import {
  access,
  copyFile,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

import { normalizeVersion, UpdateRequestError } from "./state.mjs";

const repository = "csyqlz/VOZEB-PRO";
const appImage = "ghcr.io/csyqlz/vozeb-pro";
const updaterImage = "ghcr.io/csyqlz/vozeb-pro-updater";
const activeStatuses = new Set([
  "preparing",
  "backing_up",
  "pulling",
  "applying",
  "health_check",
  "rolling_back",
]);

export function createUpdateRuntime(config, store, options = {}) {
  let activeOperation;
  let startQueue = Promise.resolve();
  const operationRunner = options.operationRunner || runOperation;
  const recoveryRunner = options.recoveryRunner || recoverPreviousVersion;
  const currentImageReader =
    options.currentImageReader || readCurrentImageReferences;
  const startLocked = async (request) => {
    const current = await store.read();
    if (current.id === request.idempotencyKey) {
      if (
        current.action !== request.action ||
        current.currentVersion !== request.currentVersion ||
        current.targetVersion !== request.targetVersion
      )
        throw new UpdateRequestError("升级幂等键已被不同请求使用", 409);
      return current;
    }
    if (activeOperation || activeStatuses.has(current.status))
      throw new UpdateRequestError("已有升级或回滚任务正在执行", 409);
    if (
      request.action === "rollback" &&
      current.previousVersion !== request.targetVersion
    )
      throw new UpdateRequestError("目标版本不在最近一次可回滚记录中", 409);
    const currentImages = await currentImageReader(
      config,
      request.currentVersion,
    );
    const operation = await store.write({
      id: request.idempotencyKey,
      action: request.action,
      status: request.action === "rollback" ? "rolling_back" : "preparing",
      currentVersion: request.currentVersion,
      targetVersion: request.targetVersion,
      previousVersion: request.currentVersion,
      ...currentImages,
      startedAt: new Date().toISOString(),
    });
    activeOperation = operationRunner(config, store, operation).finally(() => {
      activeOperation = undefined;
    });
    return operation;
  };
  return {
    async recover() {
      const current = await store.read();
      if (!activeStatuses.has(current.status)) return current;
      const interrupted = await store.write({
        ...current,
        status: "rolling_back",
        error: "升级监督器在操作期间重启，正在恢复上一运行版本",
      });
      try {
        await recoveryRunner(config, interrupted);
        return await store.write({
          ...interrupted,
          status: "failed",
          error: "升级操作被意外中断，系统已自动恢复上一运行版本",
          rollbackSucceeded: true,
          completedAt: new Date().toISOString(),
        });
      } catch (error) {
        return store.write({
          ...interrupted,
          status: "failed",
          error: `升级操作被意外中断，自动恢复失败：${publicError(error)}`,
          rollbackSucceeded: false,
          completedAt: new Date().toISOString(),
        });
      }
    },
    async start(request) {
      const queued = startQueue.then(() => startLocked(request));
      startQueue = queued.then(
        () => undefined,
        () => undefined,
      );
      return queued;
    },
  };
}

async function recoverPreviousVersion(config, operation) {
  await assertFiles(config);
  const environment = await readEnvironment(config.environmentFile);
  const previousAppImage =
    operation.previousAppImage || `${appImage}:${operation.currentVersion}`;
  const previousUpdaterImage =
    operation.previousUpdaterImage ||
    `${updaterImage}:${operation.currentVersion}`;
  const targetAppImage =
    operation.targetAppImage || `${appImage}:${operation.targetVersion}`;
  const targetUpdaterImage =
    operation.targetUpdaterImage ||
    `${updaterImage}:${operation.targetVersion}`;
  const configuredAppImage = environment.VOZEB_PRO_IMAGE || previousAppImage;
  const configuredUpdaterImage =
    environment.VOZEB_PRO_UPDATER_IMAGE || previousUpdaterImage;
  const knownImages =
    (configuredAppImage === previousAppImage &&
      configuredUpdaterImage === previousUpdaterImage) ||
    (configuredAppImage === targetAppImage &&
      configuredUpdaterImage === targetUpdaterImage);
  if (!knownImages)
    throw new Error("当前镜像配置与中断操作不一致，已拒绝自动覆盖");
  if (configuredAppImage !== previousAppImage)
    await updateEnvironmentFile(
      config.environmentFile,
      {
        VOZEB_PRO_IMAGE: previousAppImage,
        VOZEB_PRO_UPDATER_IMAGE: previousUpdaterImage,
      },
      false,
    );
  await runCompose(config, ["up", "-d", "--no-deps", "app"]);
  const healthPolicy = await waitForHealthyContainer(config.appContainerName);
  await runCompose(config, ["up", "-d", "--no-deps", "generation-worker"]);
  await waitForReadyEndpoint(
    config.appReadyUrl,
    healthPolicy.timeoutMs,
    config.pollAfterMs,
  );
}

async function readCurrentImageReferences(config, currentVersion) {
  const environment = await readEnvironment(config.environmentFile);
  const previousAppImage =
    environment.VOZEB_PRO_IMAGE || `${appImage}:${currentVersion}`;
  const previousUpdaterImage =
    environment.VOZEB_PRO_UPDATER_IMAGE || `${updaterImage}:${currentVersion}`;
  assertOfficialCurrentImage(previousAppImage, appImage, currentVersion);
  assertOfficialCurrentImage(
    previousUpdaterImage,
    updaterImage,
    currentVersion,
  );
  return { previousAppImage, previousUpdaterImage };
}

async function runOperation(config, store, operation) {
  let previousAppImage = `${appImage}:${operation.currentVersion}`;
  let previousUpdaterImage = `${updaterImage}:${operation.currentVersion}`;
  let environmentChanged = false;
  let applicationStopped = false;
  let workerStopped = false;
  try {
    const releaseTag = await assertRelease(
      operation.targetVersion,
      operation.action,
    );
    await assertFiles(config);
    const environment = await readEnvironment(config.environmentFile);
    previousAppImage = environment.VOZEB_PRO_IMAGE || previousAppImage;
    previousUpdaterImage =
      environment.VOZEB_PRO_UPDATER_IMAGE || previousUpdaterImage;
    assertOfficialCurrentImage(
      previousAppImage,
      appImage,
      operation.currentVersion,
    );
    assertOfficialCurrentImage(
      previousUpdaterImage,
      updaterImage,
      operation.currentVersion,
    );
    await runDocker(["version"]);
    const currentAppDigest = await imageDigestFor(previousAppImage);
    const currentUpdaterDigest = await imageDigestFor(previousUpdaterImage);
    await verifyOfficialImage(
      `${appImage}@${currentAppDigest}`,
      operation.currentVersion,
    );
    await verifyOfficialImage(
      `${updaterImage}@${currentUpdaterDigest}`,
      operation.currentVersion,
    );
    await assertSupportedComposeTopology(
      config,
      previousAppImage,
      previousUpdaterImage,
    );
    operation = await store.write({
      ...operation,
      previousAppImage,
      previousUpdaterImage,
    });

    operation = await store.write({ ...operation, status: "pulling" });
    const targetAppImage = `${appImage}:${operation.targetVersion}`;
    const targetUpdaterImage = `${updaterImage}:${operation.targetVersion}`;
    await runDocker(["pull", targetAppImage]);
    await runDocker(["pull", targetUpdaterImage]);
    const imageDigest = await imageDigestFor(targetAppImage);
    const updaterDigest = await imageDigestFor(targetUpdaterImage);
    await verifyOfficialImage(`${appImage}@${imageDigest}`, releaseTag);
    await verifyOfficialImage(`${updaterImage}@${updaterDigest}`, releaseTag);
    const targetAppReference = `${appImage}@${imageDigest}`;
    const targetUpdaterReference = `${updaterImage}@${updaterDigest}`;
    operation = await store.write({
      ...operation,
      targetAppImage: targetAppReference,
      targetUpdaterImage: targetUpdaterReference,
    });

    const backupPath = `/app/web/.data/disaster-recovery/system-update-${safeTimestamp()}`;
    operation = await store.write({
      ...operation,
      status: "backing_up",
      backupPath,
    });
    await runCompose(config, ["stop", "generation-worker"]);
    workerStopped = true;
    await runCompose(config, ["stop", "app"]);
    applicationStopped = true;
    await runCompose(config, [
      "run",
      "--rm",
      "--no-deps",
      "app",
      "node",
      "/app/web/scripts/disaster-backup.mjs",
      "--output",
      backupPath,
      "--confirm-offline",
    ]);

    operation = await store.write({
      ...operation,
      status: "applying",
      imageDigest,
    });
    await updateEnvironmentFile(config.environmentFile, {
      VOZEB_PRO_IMAGE: targetAppReference,
      VOZEB_PRO_UPDATER_IMAGE: targetUpdaterReference,
    });
    environmentChanged = true;
    await assertSupportedComposeTopology(
      config,
      targetAppReference,
      targetUpdaterReference,
    );
    await runCompose(config, ["up", "-d", "--no-deps", "app"]);

    operation = await store.write({ ...operation, status: "health_check" });
    const healthPolicy = await waitForHealthyContainer(config.appContainerName);
    await runCompose(config, ["up", "-d", "--no-deps", "generation-worker"]);
    await waitForReadyEndpoint(
      config.appReadyUrl,
      healthPolicy.timeoutMs,
      config.pollAfterMs,
    );
    applicationStopped = false;
    workerStopped = false;

    await store.write({
      ...operation,
      status: "completed",
      completedAt: new Date().toISOString(),
      previousVersion: operation.currentVersion,
      rollbackSucceeded: undefined,
    });
    restartUpdater(config);
  } catch (error) {
    let rollbackSucceeded;
    if (workerStopped || applicationStopped || environmentChanged) {
      rollbackSucceeded = false;
      try {
        if (environmentChanged)
          await updateEnvironmentFile(
            config.environmentFile,
            {
              VOZEB_PRO_IMAGE: previousAppImage,
              VOZEB_PRO_UPDATER_IMAGE: previousUpdaterImage,
            },
            false,
          );
        await runCompose(config, ["up", "-d", "--no-deps", "app"]);
        const healthPolicy = await waitForHealthyContainer(
          config.appContainerName,
        );
        await runCompose(config, [
          "up",
          "-d",
          "--no-deps",
          "generation-worker",
        ]);
        await waitForReadyEndpoint(
          config.appReadyUrl,
          healthPolicy.timeoutMs,
          config.pollAfterMs,
        );
        rollbackSucceeded = true;
      } catch (rollbackError) {
        console.error("automatic update rollback failed", rollbackError);
      }
    }
    await store.write({
      ...operation,
      status: "failed",
      error: publicError(error),
      completedAt: new Date().toISOString(),
      ...(typeof rollbackSucceeded === "boolean" ? { rollbackSucceeded } : {}),
    });
  }
}

async function assertRelease(version, action) {
  const token = process.env.VOZEB_PRO_GITHUB_TOKEN?.trim();
  const response = await fetch(
    `https://api.github.com/repos/${repository}/releases/tags/${encodeURIComponent(version)}`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "VOZEB-PRO-Updater",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      redirect: "error",
    },
  );
  if (!response.ok)
    throw new Error(`GitHub Release ${version} 校验失败（${response.status}）`);
  const release = await response.json();
  if (
    release?.draft === true ||
    release?.prerelease === true ||
    normalizeVersion(release?.tag_name) !== version
  )
    throw new Error("目标不是可安装的正式 Release");
  const releaseTag = String(release.tag_name || "").trim();
  if (action === "upgrade") {
    const latest = await fetch(
      `https://api.github.com/repos/${repository}/releases/latest`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "VOZEB-PRO-Updater",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        redirect: "error",
      },
    );
    const value = latest.ok ? await latest.json() : null;
    if (!value || normalizeVersion(value.tag_name) !== version)
      throw new Error("升级目标不是当前最新正式 Release");
  }
  return releaseTag;
}

async function assertFiles(config) {
  await access(config.environmentFile);
  for (const file of config.composeFiles) await access(file);
}

async function readEnvironment(file) {
  return Object.fromEntries(
    (await readFile(file, "utf8"))
      .split(/\r?\n/)
      .filter((line) => /^[A-Z0-9_]+=/.test(line))
      .map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}

function assertOfficialCurrentImage(image, repositoryName, currentVersion) {
  if (
    image !== `${repositoryName}:${currentVersion}` &&
    !new RegExp(`^${escapeRegExp(repositoryName)}@sha256:[a-f0-9]{64}$`).test(
      image,
    )
  )
    throw new Error(
      "当前不是与版本一致的官方固定镜像，拒绝在线覆盖；请使用手动升级流程",
    );
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function updateEnvironmentFile(file, values, createBackup = true) {
  const source = await readFile(file, "utf8");
  let next = source;
  for (const [key, value] of Object.entries(values)) {
    const line = `${key}=${value}`;
    const expression = new RegExp(`^${key}=.*$`, "m");
    next = expression.test(next)
      ? next.replace(expression, line)
      : `${next.replace(/\s*$/, "")}\n${line}\n`;
  }
  const backup = `${file}.before-update`;
  const temporary = `${file}.${process.pid}.tmp`;
  if (createBackup) await copyFile(file, backup);
  await writeFile(temporary, next, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, file);
}

async function imageDigestFor(image) {
  const output = await runCapture("docker", [
    "image",
    "inspect",
    image,
    "--format",
    "{{index .RepoDigests 0}}",
  ]);
  const digest = output.trim().split("@")[1] || "";
  if (!/^sha256:[a-f0-9]{64}$/.test(digest))
    throw new Error("官方镜像摘要读取失败");
  return digest;
}

async function waitForHealthyContainer(containerName) {
  const inspection = JSON.parse(
    await runCapture("docker", ["inspect", containerName]),
  )[0];
  const healthcheck = inspection?.Config?.Healthcheck;
  if (
    !healthcheck ||
    !Number.isFinite(healthcheck.Interval) ||
    !Number.isFinite(healthcheck.Retries)
  )
    throw new Error("应用镜像未声明健康检查，拒绝自动切换");
  const allowedNanoseconds =
    Number(healthcheck.StartPeriod || 0) +
    Number(healthcheck.Interval) * Number(healthcheck.Retries) +
    Number(healthcheck.Timeout || 0);
  const deadline = Date.now() + Math.ceil(allowedNanoseconds / 1_000_000);
  const interval = Math.max(
    500,
    Math.ceil(Number(healthcheck.Interval) / 1_000_000),
  );
  while (Date.now() <= deadline) {
    const state = JSON.parse(
      await runCapture("docker", [
        "inspect",
        containerName,
        "--format",
        "{{json .State}}",
      ]),
    );
    if (state?.Health?.Status === "healthy")
      return { timeoutMs: Math.ceil(allowedNanoseconds / 1_000_000), interval };
    if (
      state?.Health?.Status === "unhealthy" ||
      state?.Status === "exited" ||
      state?.Status === "dead"
    )
      throw new Error("新版本健康检查失败");
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error("新版本未在镜像健康检查时限内就绪");
}

export async function waitForReadyEndpoint(
  url,
  timeoutMs,
  pollAfterMs,
  options = {},
) {
  const fetcher = options.fetcher || fetch;
  const now = options.now || Date.now;
  const sleep =
    options.sleep ||
    ((duration) => new Promise((resolve) => setTimeout(resolve, duration)));
  const deadline = now() + timeoutMs;
  let lastError = "";
  do {
    const remaining = Math.max(1, deadline - now());
    try {
      const response = await fetcher(url, {
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(Math.min(pollAfterMs, remaining)),
      });
      const payload = await response.json().catch(() => null);
      if (response.ok && payload?.data?.ready === true) return;
      lastError =
        typeof payload?.msg === "string"
          ? payload.msg.slice(0, 300)
          : `HTTP ${response.status}`;
      if (response.status !== 503) break;
    } catch (error) {
      lastError = publicError(error);
    }
    if (now() >= deadline) break;
    await sleep(Math.min(pollAfterMs, Math.max(1, deadline - now())));
  } while (now() <= deadline);
  throw new Error(`应用就绪检查失败${lastError ? `：${lastError}` : ""}`);
}

function runCompose(config, args) {
  return runDocker(composeArguments(config, args));
}

function composeArguments(config, args) {
  const base = [
    "compose",
    "--project-directory",
    config.workspace,
    "--env-file",
    config.environmentFile,
  ];
  for (const file of config.composeFiles) base.push("-f", file);
  return [...base, ...args];
}

function restartUpdater(config) {
  const child = spawn(
    "docker",
    composeArguments(config, ["up", "-d", "--no-deps", "updater"]),
    {
      stdio: "ignore",
      detached: true,
    },
  );
  child.unref();
}

async function assertSupportedComposeTopology(
  config,
  expectedAppImage,
  expectedUpdaterImage,
) {
  let compose;
  try {
    compose = JSON.parse(
      await runCapture(
        "docker",
        composeArguments(config, ["config", "--format", "json"]),
      ),
    );
  } catch {
    throw new Error("Docker Compose 部署配置无法解析，拒绝在线升级");
  }
  validateComposeTopology(compose, expectedAppImage, expectedUpdaterImage);
}

export function validateComposeTopology(
  compose,
  expectedAppImage,
  expectedUpdaterImage,
) {
  const services = compose?.services;
  const app = services?.app;
  const worker = services?.["generation-worker"];
  const updater = services?.updater;
  if (!app || !worker || !updater)
    throw new Error(
      "在线升级仅支持包含 App、Worker 与升级器的受控 Compose 部署",
    );
  if (
    app.image !== expectedAppImage ||
    worker.image !== expectedAppImage ||
    updater.image !== expectedUpdaterImage
  )
    throw new Error("Compose 服务未使用当前官方固定版本镜像，拒绝在线升级");
  if (app.environment?.VOZEB_PRO_UPDATER_URL !== "http://updater:8787")
    throw new Error("App 未通过 Compose 内网连接升级器，拒绝在线升级");
  if (app.network_mode === "host" || worker.network_mode === "host")
    throw new Error("当前 Host 网络部署不支持在线升级");
  if (hasDockerSocket(app)) throw new Error("App 不得访问 Docker Socket");
  if (!hasDockerSocket(updater))
    throw new Error("升级器缺少受控 Docker Socket");
  if (Array.isArray(updater.ports) && updater.ports.length > 0)
    throw new Error("升级器不得向宿主机暴露端口");
}

function hasDockerSocket(service) {
  return Array.isArray(service?.volumes)
    ? service.volumes.some((volume) => {
        if (typeof volume === "string")
          return volume.split(":").slice(0, 2).includes("/var/run/docker.sock");
        return (
          volume?.source === "/var/run/docker.sock" ||
          volume?.target === "/var/run/docker.sock"
        );
      })
    : false;
}

function runDocker(args) {
  return runCommand("docker", args);
}

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) =>
      code === 0
        ? resolve()
        : reject(new Error(`${command} 命令失败（${signal || code}）`)),
    );
  });
}

function verifyOfficialImage(image, releaseTag) {
  return runCommand("cosign", [
    "verify",
    "--certificate-identity-regexp",
    certificateIdentityForReleaseTag(releaseTag),
    "--certificate-oidc-issuer",
    "https://token.actions.githubusercontent.com",
    image,
  ]);
}

export function certificateIdentityForReleaseTag(releaseTag) {
  const escapedTag = escapeRegExp(releaseTag);
  return `^https://github\\.com/csyqlz/VOZEB-PRO/\\.github/workflows/docker-image\\.yml@refs/tags/${escapedTag}$`;
}

function runCapture(command, args) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "inherit"],
    });
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.once("error", reject);
    child.once("exit", (code, signal) =>
      code === 0
        ? resolve(Buffer.concat(chunks).toString("utf8"))
        : reject(new Error(`Docker 查询失败（${signal || code}）`)),
    );
  });
}

function safeTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function publicError(error) {
  const message = error instanceof Error ? error.message.slice(0, 1000) : "";
  if (!message) return "升级执行失败";
  if (
    /(?:bearer|authorization|api.?key|password|secret|token|credential|postgres(?:ql)?:\/\/|\/workspace(?:\/|$)|\/app(?:\/|$)|[a-z]:\\)/i.test(
      message,
    )
  )
    return "升级执行失败，请查看升级器日志";
  return message;
}

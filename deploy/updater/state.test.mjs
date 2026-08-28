import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  certificateIdentityForReleaseTag,
  createUpdateRuntime,
  updateEnvironmentFile,
  validateComposeTopology,
  waitForReadyEndpoint,
} from "./runtime.mjs";
import {
  compareVersions,
  createStateStore,
  normalizeVersion,
  validateUpdateRequest,
} from "./state.mjs";

test("normalizes and compares stable release versions", () => {
  assert.equal(normalizeVersion("0.0.8"), "v0.0.8");
  assert.equal(compareVersions("v0.0.9", "v0.0.8"), 1);
  assert.equal(normalizeVersion("main"), "");
});

test("requires all upgrade confirmations and a newer target", () => {
  const confirmations = {
    databaseBackup: true,
    environmentReviewed: true,
    changelogReviewed: true,
    rollbackReviewed: true,
  };
  assert.deepEqual(
    validateUpdateRequest({
      action: "upgrade",
      targetVersion: "v0.0.9",
      currentVersion: "v0.0.8",
      idempotencyKey: "request-one",
      confirmations,
    }),
    {
      action: "upgrade",
      targetVersion: "v0.0.9",
      currentVersion: "v0.0.8",
      idempotencyKey: "request-one",
    },
  );
  assert.throws(() =>
    validateUpdateRequest({
      action: "upgrade",
      targetVersion: "v0.0.8",
      currentVersion: "v0.0.8",
      idempotencyKey: "request-two",
      confirmations,
    }),
  );
  assert.throws(() =>
    validateUpdateRequest({
      action: "upgrade",
      targetVersion: "v0.0.9",
      currentVersion: "v0.0.8",
      idempotencyKey: "request-three",
      confirmations: { one: true, two: true, three: true, four: true },
    }),
  );
});

test("persists operation state atomically", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "vozeb-updater-state-"),
  );
  try {
    const store = createStateStore(directory, 1500);
    await store.write({
      id: "operation-one",
      status: "pulling",
      targetVersion: "v0.0.9",
      previousAppImage:
        "ghcr.io/csyqlz/vozeb-pro@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      targetUpdaterImage:
        "ghcr.io/csyqlz/vozeb-pro-updater@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    });
    const saved = await store.read();
    assert.equal(saved.id, "operation-one");
    assert.equal(saved.status, "pulling");
    assert.equal(saved.targetVersion, "v0.0.9");
    assert.match(saved.previousAppImage, /@sha256:a{64}$/);
    assert.match(saved.targetUpdaterImage, /@sha256:b{64}$/);
    assert.equal(saved.pollAfterMs, 1500);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("updates only controlled image keys and keeps an environment backup", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vozeb-updater-env-"));
  const file = path.join(directory, ".env");
  try {
    await writeFile(
      file,
      "POSTGRES_PASSWORD=secret\nVOZEB_PRO_IMAGE=old\n",
      "utf8",
    );
    await updateEnvironmentFile(file, {
      VOZEB_PRO_IMAGE: "ghcr.io/csyqlz/vozeb-pro:v0.0.9",
      VOZEB_PRO_UPDATER_IMAGE: "ghcr.io/csyqlz/vozeb-pro-updater:v0.0.9",
    });
    assert.match(await readFile(file, "utf8"), /POSTGRES_PASSWORD=secret/);
    assert.match(
      await readFile(file, "utf8"),
      /VOZEB_PRO_IMAGE=ghcr\.io\/csyqlz\/vozeb-pro:v0\.0\.9/,
    );
    assert.match(
      await readFile(`${file}.before-update`, "utf8"),
      /VOZEB_PRO_IMAGE=old/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("replays only an identical update request for one idempotency key", async () => {
  const persisted = {
    id: "operation-one",
    action: "upgrade",
    status: "completed",
    currentVersion: "v0.0.8",
    targetVersion: "v0.0.9",
  };
  const runtime = createUpdateRuntime({}, { read: async () => persisted });
  await assert.doesNotReject(() =>
    runtime.start({
      action: "upgrade",
      currentVersion: "v0.0.8",
      targetVersion: "v0.0.9",
      idempotencyKey: "operation-one",
    }),
  );
  await assert.rejects(
    () =>
      runtime.start({
        action: "rollback",
        currentVersion: "v0.0.9",
        targetVersion: "v0.0.8",
        idempotencyKey: "operation-one",
      }),
    /幂等键/,
  );
});

test("serializes concurrent starts before claiming durable state", async () => {
  let persisted = { status: "idle" };
  let writes = 0;
  const store = {
    read: async () => persisted,
    write: async (value) => {
      writes += 1;
      await Promise.resolve();
      persisted = value;
      return persisted;
    },
  };
  const runtime = createUpdateRuntime({}, store, {
    operationRunner: () => new Promise(() => undefined),
    currentImageReader: async () => ({
      previousAppImage: "ghcr.io/csyqlz/vozeb-pro:v0.0.8",
      previousUpdaterImage: "ghcr.io/csyqlz/vozeb-pro-updater:v0.0.8",
    }),
  });
  const request = {
    action: "upgrade",
    currentVersion: "v0.0.8",
    targetVersion: "v0.0.9",
  };

  const first = runtime.start({
    ...request,
    idempotencyKey: "operation-three",
  });
  const second = runtime.start({
    ...request,
    idempotencyKey: "operation-four",
  });

  await assert.doesNotReject(first);
  await assert.rejects(second, /已有升级或回滚任务/);
  assert.equal(writes, 1);
});

test("binds image verification to the exact release workflow tag", () => {
  assert.equal(
    certificateIdentityForReleaseTag("v0.0.9"),
    "^https://github\\.com/csyqlz/VOZEB-PRO/\\.github/workflows/docker-image\\.yml@refs/tags/v0\\.0\\.9$",
  );
});

test("accepts only the controlled official Compose topology", () => {
  const appImage = "ghcr.io/csyqlz/vozeb-pro:v0.0.8";
  const updaterImage = "ghcr.io/csyqlz/vozeb-pro-updater:v0.0.8";
  const compose = {
    services: {
      app: {
        image: appImage,
        environment: { VOZEB_PRO_UPDATER_URL: "http://updater:8787" },
        volumes: [{ source: "vozeb-pro-data", target: "/app/web/.data" }],
      },
      "generation-worker": { image: appImage },
      updater: {
        image: updaterImage,
        volumes: [
          { source: "/var/run/docker.sock", target: "/var/run/docker.sock" },
        ],
      },
    },
  };

  assert.doesNotThrow(() =>
    validateComposeTopology(compose, appImage, updaterImage),
  );
  assert.throws(
    () =>
      validateComposeTopology(
        {
          ...compose,
          services: {
            ...compose.services,
            app: {
              ...compose.services.app,
              image: "example.invalid/app:latest",
            },
          },
        },
        appImage,
        updaterImage,
      ),
    /官方固定版本镜像/,
  );
  assert.throws(
    () =>
      validateComposeTopology(
        {
          ...compose,
          services: {
            ...compose.services,
            app: {
              ...compose.services.app,
              volumes: [
                {
                  source: "/var/run/docker.sock",
                  target: "/var/run/docker.sock",
                },
              ],
            },
          },
        },
        appImage,
        updaterImage,
      ),
    /App 不得访问 Docker Socket/,
  );
});

test("releases an interrupted operation into an explicit failed state", async () => {
  let persisted = {
    id: "operation-two",
    action: "upgrade",
    status: "pulling",
    currentVersion: "v0.0.8",
    targetVersion: "v0.0.9",
  };
  const store = {
    read: async () => persisted,
    write: async (value) => {
      persisted = value;
      return persisted;
    },
  };
  const recovered = await createUpdateRuntime(
    { environmentFile: "/missing/.env", composeFiles: [] },
    store,
  ).recover();
  assert.equal(recovered.status, "failed");
  assert.equal(recovered.rollbackSucceeded, false);
  assert.match(recovered.error, /自动恢复失败/);
});

test("recovers an interrupted durable operation before accepting traffic", async () => {
  let persisted = {
    id: "operation-five",
    action: "upgrade",
    status: "applying",
    currentVersion: "v0.0.8",
    targetVersion: "v0.0.9",
  };
  const writes = [];
  const store = {
    read: async () => persisted,
    write: async (value) => {
      persisted = value;
      writes.push(value.status);
      return persisted;
    },
  };
  const recovered = await createUpdateRuntime({}, store, {
    recoveryRunner: async () => undefined,
  }).recover();

  assert.deepEqual(writes, ["rolling_back", "failed"]);
  assert.equal(recovered.rollbackSucceeded, true);
  assert.match(recovered.error, /已自动恢复上一运行版本/);
});

test("waits for the application and worker readiness contract", async () => {
  let now = 0;
  let requests = 0;
  await waitForReadyEndpoint("http://app:3000/api/health/ready", 4000, 1000, {
    now: () => now,
    sleep: async (duration) => {
      now += duration;
    },
    fetcher: async () => {
      requests += 1;
      return new Response(
        JSON.stringify(
          requests === 1
            ? { code: 503, data: { ready: false }, msg: "Worker 尚未就绪" }
            : { code: 0, data: { ready: true }, msg: "服务已就绪" },
        ),
        {
          status: requests === 1 ? 503 : 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    },
  });
  assert.equal(requests, 2);
});

test("fails the update when readiness never becomes true", async () => {
  let now = 0;
  await assert.rejects(
    () =>
      waitForReadyEndpoint("http://app:3000/api/health/ready", 2000, 1000, {
        now: () => now,
        sleep: async (duration) => {
          now += duration;
        },
        fetcher: async () =>
          new Response(
            JSON.stringify({
              code: 503,
              data: { ready: false },
              msg: "数据库未就绪",
            }),
            { status: 503, headers: { "Content-Type": "application/json" } },
          ),
      }),
    /应用就绪检查失败：数据库未就绪/,
  );
});

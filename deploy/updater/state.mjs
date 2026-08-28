import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const versionPattern = /^v(\d+)\.(\d+)\.(\d+)$/;

export function normalizeVersion(value) {
  const match =
    typeof value === "string"
      ? value.trim().match(/^v?(\d+)\.(\d+)\.(\d+)$/)
      : null;
  return match
    ? `v${Number(match[1])}.${Number(match[2])}.${Number(match[3])}`
    : "";
}

export function compareVersions(left, right) {
  const a = versionParts(left);
  const b = versionParts(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

export function validateUpdateRequest(value) {
  const input =
    value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const action =
    input.action === "upgrade" || input.action === "rollback"
      ? input.action
      : "";
  const targetVersion = normalizeVersion(input.targetVersion);
  const currentVersion = normalizeVersion(input.currentVersion);
  const idempotencyKey =
    typeof input.idempotencyKey === "string" &&
    /^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,159}$/.test(input.idempotencyKey)
      ? input.idempotencyKey
      : "";
  const confirmationKeys = [
    "databaseBackup",
    "environmentReviewed",
    "changelogReviewed",
    "rollbackReviewed",
  ];
  const confirmations =
    input.confirmations &&
    typeof input.confirmations === "object" &&
    !Array.isArray(input.confirmations) &&
    Object.keys(input.confirmations).length === confirmationKeys.length &&
    confirmationKeys.every((key) => input.confirmations[key] === true);
  if (
    !action ||
    !targetVersion ||
    !currentVersion ||
    !idempotencyKey ||
    !confirmations
  )
    throw new UpdateRequestError("升级请求参数或确认项无效", 400);
  if (
    action === "upgrade" &&
    compareVersions(targetVersion, currentVersion) <= 0
  )
    throw new UpdateRequestError("升级目标必须高于当前版本", 409);
  return { action, targetVersion, currentVersion, idempotencyKey };
}

export function createStateStore(stateDirectory, pollAfterMs) {
  const file = path.join(stateDirectory, "operation.json");
  return {
    async read() {
      try {
        return normalizeState(
          JSON.parse(await readFile(file, "utf8")),
          pollAfterMs,
        );
      } catch (error) {
        if (error?.code !== "ENOENT" && !(error instanceof SyntaxError))
          throw error;
        return { status: "idle", pollAfterMs };
      }
    },
    async write(state) {
      await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
      const next = normalizeState(
        { ...state, updatedAt: new Date().toISOString() },
        pollAfterMs,
      );
      const temporary = `${file}.${process.pid}.tmp`;
      await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await rename(temporary, file);
      return next;
    },
  };
}

export class UpdateRequestError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

function normalizeState(value, pollAfterMs) {
  const allowed = new Set([
    "idle",
    "preparing",
    "backing_up",
    "pulling",
    "applying",
    "health_check",
    "completed",
    "failed",
    "rolling_back",
  ]);
  return {
    status: allowed.has(value?.status) ? value.status : "idle",
    ...textField(value, "id"),
    ...(value?.action === "upgrade" || value?.action === "rollback"
      ? { action: value.action }
      : {}),
    ...versionField(value, "currentVersion"),
    ...versionField(value, "targetVersion"),
    ...versionField(value, "previousVersion"),
    ...textField(value, "startedAt"),
    ...textField(value, "updatedAt"),
    ...textField(value, "completedAt"),
    ...textField(value, "backupPath"),
    ...textField(value, "imageDigest"),
    ...imageReferenceField(
      value,
      "previousAppImage",
      "ghcr.io/csyqlz/vozeb-pro",
    ),
    ...imageReferenceField(
      value,
      "previousUpdaterImage",
      "ghcr.io/csyqlz/vozeb-pro-updater",
    ),
    ...imageReferenceField(value, "targetAppImage", "ghcr.io/csyqlz/vozeb-pro"),
    ...imageReferenceField(
      value,
      "targetUpdaterImage",
      "ghcr.io/csyqlz/vozeb-pro-updater",
    ),
    ...textField(value, "error"),
    ...(typeof value?.rollbackSucceeded === "boolean"
      ? { rollbackSucceeded: value.rollbackSucceeded }
      : {}),
    pollAfterMs,
  };
}

function versionParts(value) {
  const match = normalizeVersion(value).match(versionPattern);
  return match ? match.slice(1).map(Number) : [0, 0, 0];
}

function textField(value, key) {
  return typeof value?.[key] === "string" && value[key].trim()
    ? { [key]: value[key].trim() }
    : {};
}

function versionField(value, key) {
  const version = normalizeVersion(value?.[key]);
  return version ? { [key]: version } : {};
}

function imageReferenceField(value, key, repository) {
  const reference = typeof value?.[key] === "string" ? value[key].trim() : "";
  const taggedVersion = reference.startsWith(`${repository}:`)
    ? normalizeVersion(reference.slice(repository.length + 1))
    : "";
  return (taggedVersion && reference === `${repository}:${taggedVersion}`) ||
    new RegExp(
      `^${repository.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}@sha256:[a-f0-9]{64}$`,
    ).test(reference)
    ? { [key]: reference }
    : {};
}

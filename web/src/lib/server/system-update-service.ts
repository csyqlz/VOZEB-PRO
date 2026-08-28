import { APP_VERSION } from "@/constant/env";
import { compareSystemVersions, hasCompleteSystemUpdateConfirmations, normalizeSystemVersion, type SystemReleaseInfo, type SystemUpdateInfo, type SystemUpdateOperation, type SystemUpdateRequest } from "@/lib/system-update-contract";

const GITHUB_RELEASE_URL = "https://api.github.com/repos/csyqlz/VOZEB-PRO/releases/latest";
const ACTIVE_OPERATION_STATUSES = new Set<SystemUpdateOperation["status"]>(["preparing", "backing_up", "pulling", "applying", "health_check", "rolling_back"]);

export class SystemUpdateServiceError extends Error {
    constructor(
        message: string,
        readonly status: number,
    ) {
        super(message);
    }
}

export async function getSystemUpdateInfo(): Promise<SystemUpdateInfo> {
    const currentVersion = normalizeSystemVersion(APP_VERSION) || "v0.0.8";
    const supervisor = supervisorConfig();
    const supervisorResult = supervisor
        ? await readSupervisorOperation(supervisor)
              .then((operation) => ({ operation, error: "" }))
              .catch((error) => ({ operation: unavailableOperation(), error: publicServiceError(error, "升级监督器暂不可用") }))
        : { operation: unavailableOperation(), error: "" };
    const releaseDeferred = ACTIVE_OPERATION_STATUSES.has(supervisorResult.operation.status);
    const releaseResult = releaseDeferred
        ? { release: undefined, error: "" }
        : await fetchLatestRelease()
              .then((release) => ({ release, error: "" }))
              .catch((error) => ({ release: undefined, error: publicServiceError(error, "暂时无法检查 GitHub Release") }));
    const verifiedTargetVersion = supervisorResult.operation.action === "upgrade" && ACTIVE_OPERATION_STATUSES.has(supervisorResult.operation.status) ? supervisorResult.operation.targetVersion : undefined;
    const latestCandidate = releaseResult.release?.version || verifiedTargetVersion;
    const latestVersion = latestCandidate && compareSystemVersions(latestCandidate, currentVersion) > 0 ? latestCandidate : currentVersion;
    return {
        currentVersion,
        latestVersion,
        hasUpdate: compareSystemVersions(latestVersion, currentVersion) > 0,
        checkedAt: new Date().toISOString(),
        ...(releaseResult.release ? { release: releaseResult.release } : {}),
        releaseCheck: releaseDeferred ? { status: "deferred" } : releaseResult.error ? { status: "unavailable", reason: releaseResult.error } : { status: "succeeded" },
        onlineUpgrade: {
            supported: Boolean(supervisor && !supervisorResult.error),
            ...(!supervisor ? { reason: "当前部署未启用在线升级监督器，请按部署文档启用后再操作" } : supervisorResult.error ? { reason: supervisorResult.error } : {}),
            operation: supervisorResult.operation,
        },
    };
}

export async function requestSystemUpdate(input: SystemUpdateRequest) {
    const supervisor = supervisorConfig();
    if (!supervisor) throw new SystemUpdateServiceError("当前部署未启用在线升级监督器", 409);
    if (!hasCompleteSystemUpdateConfirmations(input.confirmations)) throw new SystemUpdateServiceError("请确认全部升级准备项", 400);
    const targetVersion = normalizeSystemVersion(input.targetVersion);
    if (!targetVersion || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,159}$/.test(input.idempotencyKey)) throw new SystemUpdateServiceError("升级请求参数无效", 400);

    if (input.action === "upgrade") {
        const release = await fetchLatestRelease();
        if (!release || release.version !== targetVersion) throw new SystemUpdateServiceError("目标版本不是 GitHub 当前正式 Release", 409);
        if (compareSystemVersions(targetVersion, APP_VERSION) <= 0) throw new SystemUpdateServiceError("当前已是该版本或更高版本", 409);
    } else {
        const current = await readSupervisorOperation(supervisor);
        if (current.previousVersion !== targetVersion) throw new SystemUpdateServiceError("目标版本不在可回滚记录中", 409);
        if (compareSystemVersions(targetVersion, APP_VERSION) >= 0) throw new SystemUpdateServiceError("回滚目标必须低于当前运行版本", 409);
    }

    const response = await callSupervisor(supervisor, "/v1/updates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...input, targetVersion, currentVersion: normalizeSystemVersion(APP_VERSION) }),
    });
    return normalizeOperation(response);
}

async function fetchLatestRelease(): Promise<SystemReleaseInfo | undefined> {
    const headers: Record<string, string> = { Accept: "application/vnd.github+json", "User-Agent": "VOZEB-PRO-Updater" };
    const token = process.env.VOZEB_PRO_GITHUB_TOKEN?.trim();
    if (token) headers.Authorization = `Bearer ${token}`;
    try {
        const response = await fetch(GITHUB_RELEASE_URL, { cache: "no-store", headers, redirect: "error" });
        if (response.status === 404) return undefined;
        if (!response.ok) throw new SystemUpdateServiceError(`GitHub Release 查询失败（${response.status}）`, 502);
        const value = (await response.json()) as Record<string, unknown>;
        const version = normalizeSystemVersion(value.tag_name);
        if (!version || value.draft === true || value.prerelease === true) return undefined;
        const htmlUrl = officialReleaseUrl(value.html_url);
        if (!htmlUrl) throw new SystemUpdateServiceError("GitHub Release 地址无效", 502);
        return { version, name: text(value.name, 160) || `VOZEB PRO ${version}`, body: text(value.body, 20_000), publishedAt: date(value.published_at), htmlUrl };
    } catch (error) {
        if (error instanceof SystemUpdateServiceError) throw error;
        throw new SystemUpdateServiceError("暂时无法连接 GitHub Release", 502);
    }
}

function supervisorConfig() {
    const baseUrl = process.env.VOZEB_PRO_UPDATER_URL?.trim().replace(/\/+$/, "") || "";
    const token = process.env.VOZEB_PRO_UPDATER_TOKEN?.trim() || "";
    if (!baseUrl || token.length < 32) return undefined;
    const reservedTokens = [process.env.VOZEB_PRO_INSTALL_TOKEN, process.env.VOZEB_PRO_MAINTENANCE_TOKEN, process.env.VOZEB_PRO_WORKER_TOKEN, process.env.VOZEB_PRO_GITHUB_TOKEN].map((value) => value?.trim()).filter(Boolean);
    if (reservedTokens.includes(token)) return undefined;
    let url: URL;
    try {
        url = new URL(baseUrl);
    } catch {
        return undefined;
    }
    const allowedHosts = new Set(["updater", "127.0.0.1", "localhost", "[::1]", ...(process.env.VOZEB_PRO_UPDATER_HOSTS || "").split(",").map((item) => item.trim().toLowerCase())].filter(Boolean));
    return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password && allowedHosts.has(url.hostname.toLowerCase()) ? { baseUrl: url.toString().replace(/\/$/, ""), token } : undefined;
}

async function readSupervisorOperation(config: NonNullable<ReturnType<typeof supervisorConfig>>) {
    return normalizeOperation(await callSupervisor(config, "/v1/updates"));
}

async function callSupervisor(config: NonNullable<ReturnType<typeof supervisorConfig>>, path: string, init: RequestInit = {}) {
    try {
        const response = await fetch(`${config.baseUrl}${path}`, { ...init, cache: "no-store", redirect: "error", headers: { ...init.headers, Authorization: `Bearer ${config.token}`, "User-Agent": "VOZEB-PRO-App" } });
        const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
        if (!response.ok || !payload) throw new SystemUpdateServiceError(publicOperationError(payload?.error) || "升级监督器请求失败", response.status >= 400 && response.status <= 599 ? response.status : 502);
        return payload;
    } catch (error) {
        if (error instanceof SystemUpdateServiceError) throw error;
        throw new SystemUpdateServiceError("升级监督器暂不可用", 503);
    }
}

function normalizeOperation(value: Record<string, unknown>): SystemUpdateOperation {
    const statuses = new Set<SystemUpdateOperation["status"]>(["idle", "preparing", "backing_up", "pulling", "applying", "health_check", "completed", "failed", "rolling_back"]);
    const status = statuses.has(value.status as SystemUpdateOperation["status"]) ? (value.status as SystemUpdateOperation["status"]) : "idle";
    return {
        status,
        ...field(value, "id", 160),
        ...(value.action === "upgrade" || value.action === "rollback" ? { action: value.action } : {}),
        ...versionField(value, "currentVersion"),
        ...versionField(value, "targetVersion"),
        ...versionField(value, "previousVersion"),
        ...dateField(value, "startedAt"),
        ...dateField(value, "updatedAt"),
        ...dateField(value, "completedAt"),
        ...imageDigestField(value),
        ...operationErrorField(value),
        ...(typeof value.rollbackSucceeded === "boolean" ? { rollbackSucceeded: value.rollbackSucceeded } : {}),
        ...(Number.isFinite(Number(value.pollAfterMs)) && Number(value.pollAfterMs) >= 500 ? { pollAfterMs: Number(value.pollAfterMs) } : {}),
    };
}

function unavailableOperation(): SystemUpdateOperation {
    return { status: "idle" };
}

function versionField(value: Record<string, unknown>, key: "currentVersion" | "targetVersion" | "previousVersion") {
    const version = normalizeSystemVersion(value[key]);
    return version ? { [key]: version } : {};
}

function dateField(value: Record<string, unknown>, key: "startedAt" | "updatedAt" | "completedAt") {
    const parsed = date(value[key]);
    return parsed ? { [key]: parsed } : {};
}

function field(value: Record<string, unknown>, key: "id" | "imageDigest", max: number) {
    const parsed = text(value[key], max);
    return parsed ? { [key]: parsed } : {};
}

function imageDigestField(value: Record<string, unknown>) {
    const imageDigest = text(value.imageDigest, 200);
    return /^sha256:[a-f0-9]{64}$/.test(imageDigest) ? { imageDigest } : {};
}

function operationErrorField(value: Record<string, unknown>) {
    const error = publicOperationError(value.error);
    return error ? { error } : {};
}

function publicOperationError(value: unknown) {
    const message = text(value, 1000);
    if (!message) return "";
    if (/(?:bearer|authorization|api.?key|password|secret|token|credential|postgres(?:ql)?:\/\/|\/workspace(?:\/|$)|\/app(?:\/|$)|[a-z]:\\)/i.test(message)) {
        return "升级执行失败，请查看服务器升级器日志";
    }
    return message;
}

function date(value: unknown) {
    const timestamp = typeof value === "string" ? Date.parse(value) : Number.NaN;
    return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : "";
}

function officialReleaseUrl(value: unknown) {
    const source = text(value, 500);
    try {
        const url = new URL(source);
        return url.protocol === "https:" && url.hostname === "github.com" && url.pathname.startsWith("/csyqlz/VOZEB-PRO/releases/") ? url.toString() : "";
    } catch {
        return "";
    }
}

function text(value: unknown, max: number) {
    return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function publicServiceError(error: unknown, fallback: string) {
    return error instanceof Error && error.message.trim() ? error.message.trim().slice(0, 500) : fallback;
}

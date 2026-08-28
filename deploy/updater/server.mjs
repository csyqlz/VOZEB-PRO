import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import path from "node:path";

import { createUpdateRuntime } from "./runtime.mjs";
import {
  createStateStore,
  UpdateRequestError,
  validateUpdateRequest,
} from "./state.mjs";

const token = process.env.VOZEB_PRO_UPDATER_TOKEN?.trim() || "";
if (token.length < 32)
  throw new Error("VOZEB_PRO_UPDATER_TOKEN 必须至少 32 个字符");
if (token === process.env.VOZEB_PRO_GITHUB_TOKEN?.trim())
  throw new Error("VOZEB_PRO_UPDATER_TOKEN 不得复用 GitHub 令牌");

const workspace = path.resolve(
  process.env.VOZEB_PRO_UPDATER_WORKSPACE || "/workspace",
);
const environmentFile = safeWorkspacePath(
  process.env.VOZEB_PRO_UPDATER_ENV_FILE || ".env",
);
const composeFiles = (
  process.env.VOZEB_PRO_UPDATER_COMPOSE_FILES ||
  "docker-compose.yml,docker-compose.updater.yml"
)
  .split(",")
  .map((item) => safeWorkspacePath(item.trim()))
  .filter(Boolean);
const pollAfterMs = positiveInteger(
  process.env.VOZEB_PRO_UPDATER_POLL_AFTER_MS,
  2000,
);
const port = positiveInteger(process.env.VOZEB_PRO_UPDATER_PORT, 8787);
const config = {
  workspace,
  environmentFile,
  composeFiles,
  pollAfterMs,
  appReadyUrl: "http://app:3000/api/health/ready",
  appContainerName:
    process.env.VOZEB_PRO_UPDATER_APP_CONTAINER?.trim() || "vozeb-pro",
};
const store = createStateStore(
  path.resolve(process.env.VOZEB_PRO_UPDATER_STATE_DIR || "/state"),
  pollAfterMs,
);
const runtime = createUpdateRuntime(config, store);
await runtime.recover();

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", "http://updater.internal");
    if (request.method === "GET" && url.pathname === "/health")
      return json(response, 200, { ok: true });
    if (!authorized(request.headers.authorization))
      return json(response, 401, { error: "unauthorized" });
    if (request.method === "GET" && url.pathname === "/v1/updates")
      return json(response, 200, await store.read());
    if (request.method === "POST" && url.pathname === "/v1/updates") {
      const operation = await runtime.start(
        validateUpdateRequest(await readJson(request)),
      );
      return json(response, 202, operation);
    }
    return json(response, 404, { error: "not_found" });
  } catch (error) {
    const status = error instanceof UpdateRequestError ? error.status : 500;
    if (status === 500) console.error("updater request failed", error);
    return json(response, status, {
      error:
        error instanceof UpdateRequestError
          ? error.message
          : "升级监督器内部错误",
    });
  }
});

server.listen(port, "0.0.0.0", () =>
  process.stdout.write(`VOZEB PRO updater listening on :${port}\n`),
);

function safeWorkspacePath(value) {
  const resolved = path.resolve(workspace, value);
  if (resolved !== workspace && !resolved.startsWith(`${workspace}${path.sep}`))
    throw new Error("升级器文件路径必须位于工作目录内");
  return resolved;
}

function authorized(value) {
  const supplied =
    typeof value === "string" && value.startsWith("Bearer ")
      ? value.slice(7)
      : "";
  const left = Buffer.from(supplied);
  const right = Buffer.from(token);
  return left.length === right.length && timingSafeEqual(left, right);
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 16 * 1024)
      throw new UpdateRequestError("请求体超过升级协议上限", 413);
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new UpdateRequestError("请求 JSON 无效", 400);
  }
}

function json(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  response.end(body);
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 500 ? number : fallback;
}

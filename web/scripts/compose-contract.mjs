import { readFileSync } from "node:fs";
import path from "node:path";

import { parse } from "yaml";

export const composeProfiles = [
    { file: "docker-compose.yml", embeddedPostgres: true, image: "${VOZEB_PRO_IMAGE:-ghcr.io/csyqlz/vozeb-pro:v0.0.7}", workerOrigin: "http://app:3000" },
    { file: "docker-compose.local.yml", embeddedPostgres: true, image: "vozeb-pro:local", workerOrigin: "http://app:3000" },
    { file: "docker-compose.baota.yml", embeddedPostgres: false, hostNetwork: true, image: "${VOZEB_PRO_IMAGE:-ghcr.io/csyqlz/vozeb-pro:v0.0.7}", workerOrigin: "http://127.0.0.1:3000" },
    { file: "docker-compose.external-db.yml", embeddedPostgres: false, image: "${VOZEB_PRO_IMAGE:-ghcr.io/csyqlz/vozeb-pro:v0.0.7}", workerOrigin: "http://app:3000" },
    { file: "docker-compose.lowmem.yml", embeddedPostgres: false, image: "${VOZEB_PRO_IMAGE:-ghcr.io/csyqlz/vozeb-pro:v0.0.7}", workerOrigin: "http://app:3000" },
];

export const docsComposeProfiles = [
    { file: "docs/docker-compose.yml", image: "ghcr.io/csyqlz/vozeb-pro-docs:v0.0.7" },
    { file: "docs/docker-compose.local.yml", build: { context: "..", dockerfile: "docs/Dockerfile" } },
];

const maintenanceToken = "${VOZEB_PRO_MAINTENANCE_TOKEN:?请在 .env 中配置至少 32 位维护令牌}";
const workerToken = "${VOZEB_PRO_WORKER_TOKEN:?请在 .env 中配置独立的至少 32 位 Worker 令牌}";
const installToken = "${VOZEB_PRO_INSTALL_TOKEN:?请在 .env 中配置至少 32 位一次性安装令牌}";

export function validateComposeContracts({ repoRoot }) {
    return composeProfiles.map((profile) => {
        const source = readFileSync(path.join(repoRoot, profile.file), "utf8");
        return validateComposeContract(source, profile);
    });
}

export function validateDocsComposeContracts({ repoRoot }) {
    return docsComposeProfiles.map((profile) => {
        const source = readFileSync(path.join(repoRoot, profile.file), "utf8");
        return validateDocsComposeContract(source, profile);
    });
}

export function validateDocsComposeContract(source, profile) {
    let compose;
    try {
        compose = parse(source);
    } catch (error) {
        throw new Error(`${profile.file}: YAML 解析失败：${error.message}`);
    }
    const services = compose?.services && typeof compose.services === "object" && !Array.isArray(compose.services) ? compose.services : {};
    const docs = services.docs;
    const violations = [];
    if (!docs || Object.keys(services).length !== 1) violations.push("文档 Compose 必须且只能声明 docs 服务");
    if (!docs?.ports?.includes("3001:3000")) violations.push("docs 必须把宿主机 3001 映射到容器 3000");
    if (docs?.restart !== "unless-stopped") violations.push("docs 必须使用 unless-stopped 重启策略");
    if (profile.image && docs?.image !== profile.image) violations.push("发布文档 Compose 镜像不正确");
    if (profile.build && (docs?.build?.context !== profile.build.context || docs?.build?.dockerfile !== profile.build.dockerfile)) violations.push("本地文档 Compose 构建上下文不正确");
    if (violations.length > 0) throw new Error(`${profile.file} Compose 契约失败：\n- ${violations.join("\n- ")}`);
    return { file: profile.file, services: ["docs"] };
}

export function validateComposeContract(source, profile) {
    let compose;
    try {
        compose = parse(source);
    } catch (error) {
        throw new Error(`${profile.file}: YAML 解析失败：${error.message}`);
    }

    const violations = [];
    const ensure = (condition, message) => {
        if (!condition) violations.push(message);
    };
    const services = compose?.services || {};
    const app = services.app || {};
    const worker = services["generation-worker"] || {};
    const appEnvironment = app.environment || {};
    const workerEnvironment = worker.environment || {};

    ensure(Boolean(services.app), "缺少 app 服务");
    ensure(Boolean(services["generation-worker"]), "缺少 generation-worker 服务");
    ensure(app.image === profile.image, "app 必须使用当前发布版本的明确镜像");
    ensure(sameImage(app.image, worker.image), "app 与 generation-worker 必须使用同一镜像");
    ensure(!String(app.image || "").endsWith(":latest"), "发布 Compose 禁止使用 latest 镜像");
    ensure(JSON.stringify(worker.command) === JSON.stringify(["node", "/app/web/scripts/generation-worker.mjs"]), "Worker 启动命令不正确");
    ensure(app.env_file?.includes(".env"), "app 必须读取 .env");
    ensure(!worker.env_file, "generation-worker 不得读取包含安装令牌和业务密钥的 .env");
    ensure(appEnvironment.VOZEB_PRO_INSTALL_TOKEN === installToken, "app 未声明强制一次性安装令牌");
    ensure(!("VOZEB_PRO_INSTALL_TOKEN" in workerEnvironment), "generation-worker 不得获得一次性安装令牌");
    ensure(appEnvironment.VOZEB_PRO_MAINTENANCE_TOKEN === maintenanceToken, "app 未声明强制维护令牌");
    ensure(appEnvironment.VOZEB_PRO_WORKER_TOKEN === workerToken, "app 未声明强制 Worker 令牌");
    ensure(workerEnvironment.VOZEB_PRO_WORKER_TOKEN === workerToken, "generation-worker 未声明同一强制 Worker 令牌");
    ensure(!("VOZEB_PRO_MAINTENANCE_TOKEN" in workerEnvironment), "generation-worker 不得获得外部维护令牌");
    ensure(workerEnvironment.VOZEB_PRO_WORKER_API_ORIGIN === profile.workerOrigin, `Worker API 地址必须为 ${profile.workerOrigin}`);
    ensure(appEnvironment.VOZEB_PRO_DATABASE_PROVIDER === "postgres", "app 必须使用 PostgreSQL provider");
    ensure(typeof appEnvironment.DATABASE_URL === "string", "app 缺少 DATABASE_URL");
    ensure(!("DATABASE_URL" in workerEnvironment), "generation-worker 不应直接持有数据库连接串");
    ensure(!("VOZEB_PRO_DATABASE_PROVIDER" in workerEnvironment), "generation-worker 不应直接访问数据库 provider");
    ensure(app.volumes?.includes("vozeb-pro-data:/app/web/.data"), "app 缺少持久数据卷挂载");
    ensure(Object.hasOwn(compose?.volumes || {}, "vozeb-pro-data"), "缺少 vozeb-pro-data 顶层数据卷");
    ensure(
        app.healthcheck?.test?.some((value) => String(value).includes("/api/health/live")),
        "app 健康检查必须调用 /api/health/live",
    );
    ensure(worker.depends_on?.app?.condition === "service_healthy", "generation-worker 必须等待 app 健康");

    if (profile.embeddedPostgres) {
        ensure(Boolean(services.postgres), "默认或本地拓扑必须包含 PostgreSQL 服务");
        ensure(String(appEnvironment.DATABASE_URL || "").includes("@postgres:5432/"), "内置 PostgreSQL 拓扑必须连接 postgres 服务");
        ensure(Object.hasOwn(compose?.volumes || {}, "vozeb-pro-postgres"), "内置 PostgreSQL 拓扑缺少数据库数据卷");
    } else {
        ensure(!services.postgres, "外部数据库拓扑不得内置 PostgreSQL 服务");
        ensure(String(appEnvironment.DATABASE_URL || "").startsWith("${DATABASE_URL:?"), "外部数据库拓扑必须显式要求 DATABASE_URL");
        ensure(!Object.hasOwn(compose?.volumes || {}, "vozeb-pro-postgres"), "外部数据库拓扑不得声明无用的 PostgreSQL 数据卷");
    }

    if (profile.hostNetwork) {
        ensure(app.network_mode === "host", "宝塔 app 必须使用 host 网络");
        ensure(worker.network_mode === "host", "宝塔 generation-worker 必须使用 host 网络");
        ensure("VOZEB_PRO_TRUSTED_PROXY_HOPS" in appEnvironment, "宝塔拓扑缺少反向代理层数配置");
    } else {
        ensure(!app.network_mode && !worker.network_mode, "宝塔专用 host 网络不得泄漏到其他拓扑");
        ensure(!("VOZEB_PRO_TRUSTED_PROXY_HOPS" in appEnvironment), "宝塔专用反向代理默认值不得泄漏到其他拓扑");
    }

    if (violations.length > 0) throw new Error(`${profile.file} Compose 契约失败：\n- ${violations.join("\n- ")}`);
    return { file: profile.file, services: Object.keys(services) };
}

function sameImage(appImage, workerImage) {
    return typeof appImage === "string" && appImage === workerImage;
}

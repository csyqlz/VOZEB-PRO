import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { composeProfiles, docsComposeProfiles, validateComposeContract, validateComposeContracts, validateDocsComposeContract, validateDocsComposeContracts } from "./compose-contract.mjs";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(webRoot, "..");

describe("Docker Compose contracts", () => {
    it("validates every supported deployment topology with structured YAML parsing", () => {
        expect(validateComposeContracts({ repoRoot })).toEqual(
            composeProfiles.map((profile) => ({
                file: profile.file,
                services: profile.embeddedPostgres ? ["postgres", "app", "generation-worker"] : ["app", "generation-worker"],
            })),
        );
        expect(validateDocsComposeContracts({ repoRoot })).toEqual(docsComposeProfiles.map(({ file }) => ({ file, services: ["docs"] })));
    });

    it("rejects a Worker that can bypass the application database boundary", () => {
        const profile = composeProfiles.find(({ file }) => file === "docker-compose.external-db.yml");
        const source = readFileSync(path.join(repoRoot, profile.file), "utf8").replace("      VOZEB_PRO_WORKER_API_ORIGIN: http://app:3000", "      VOZEB_PRO_WORKER_API_ORIGIN: http://app:3000\n      DATABASE_URL: postgres://leaked");

        expect(() => validateComposeContract(source, profile)).toThrow("generation-worker 不应直接持有数据库连接串");
    });

    it("rejects mutable latest release images", () => {
        const profile = composeProfiles.find(({ file }) => file === "docker-compose.yml");
        const source = readFileSync(path.join(repoRoot, profile.file), "utf8").replaceAll("ghcr.io/csyqlz/vozeb-pro:v0.0.7", "ghcr.io/csyqlz/vozeb-pro:latest");

        expect(() => validateComposeContract(source, profile)).toThrow("app 必须使用当前发布版本的明确镜像");
    });

    it("rejects a Worker that imports the application secret environment", () => {
        const profile = composeProfiles.find(({ file }) => file === "docker-compose.external-db.yml");
        const source = readFileSync(path.join(repoRoot, profile.file), "utf8").replace('    command: ["node", "/app/web/scripts/generation-worker.mjs"]', '    command: ["node", "/app/web/scripts/generation-worker.mjs"]\n    env_file:\n      - .env');

        expect(() => validateComposeContract(source, profile)).toThrow("generation-worker 不得读取包含安装令牌和业务密钥的 .env");
    });

    it("rejects exposing the external maintenance token to the Worker", () => {
        const profile = composeProfiles.find(({ file }) => file === "docker-compose.external-db.yml");
        const source = readFileSync(path.join(repoRoot, profile.file), "utf8").replace("      VOZEB_PRO_WORKER_API_ORIGIN: http://app:3000", "      VOZEB_PRO_WORKER_API_ORIGIN: http://app:3000\n      VOZEB_PRO_MAINTENANCE_TOKEN: leaked");

        expect(() => validateComposeContract(source, profile)).toThrow("generation-worker 不得获得外部维护令牌");
    });

    it("rejects Baota-only host networking in the public default topology", () => {
        const profile = composeProfiles.find(({ file }) => file === "docker-compose.yml");
        const source = readFileSync(path.join(repoRoot, profile.file), "utf8").replace("    image: ${VOZEB_PRO_IMAGE", "    network_mode: host\n    image: ${VOZEB_PRO_IMAGE");

        expect(() => validateComposeContract(source, profile)).toThrow("宝塔专用 host 网络不得泄漏到其他拓扑");
    });

    it("reports an invalid docs service shape as a contract failure", () => {
        const profile = docsComposeProfiles[0];

        expect(() => validateDocsComposeContract("services: invalid", profile)).toThrow("文档 Compose 必须且只能声明 docs 服务");
    });
});

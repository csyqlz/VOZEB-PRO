import { readFileSync } from "node:fs";
import path from "node:path";

export function validateNginxContract({ repoRoot }) {
    const file = path.join(repoRoot, "deploy", "nginx", "vozeb-pro.conf.example");
    const source = readFileSync(file, "utf8");
    ensureBalancedBlocks(source);
    ensure(/listen\s+443\s+ssl\s+http2\s*;/.test(source), "HTTPS 监听必须启用 HTTP/2");
    ensure(/gzip\s+on\s*;/.test(source), "Nginx 必须启用 gzip");
    ensure(/gzip_types[^;]*application\/javascript[^;]*text\/css|gzip_types[^;]*text\/css[^;]*application\/javascript/.test(source), "gzip_types 必须覆盖 JS 和 CSS");
    ensure(/location\s+\^~\s+\/_next\/static\//.test(source), "缺少 Next.js 静态资源专用 location");
    ensure(/max-age=31536000,\s*immutable/.test(source), "Next.js 哈希静态资源缺少长期不可变缓存");
    ensure(/proxy_set_header\s+X-Forwarded-Proto\s+\$scheme\s*;/.test(source), "反向代理缺少 X-Forwarded-Proto");
    ensure(/proxy_buffering\s+off\s*;/.test(source), "Agent SSE 路由必须关闭代理缓冲");
    ensure(!/brotli\s+on\s*;/.test(source), "默认配置不得假设服务器已安装 Brotli 模块");
    return file;
}

function ensureBalancedBlocks(source) {
    let depth = 0;
    let quote = "";
    let escaped = false;
    for (const char of source.replace(/#.*$/gm, "")) {
        if (escaped) {
            escaped = false;
            continue;
        }
        if (char === "\\" && quote) {
            escaped = true;
            continue;
        }
        if (quote) {
            if (char === quote) quote = "";
            continue;
        }
        if (char === '"' || char === "'") {
            quote = char;
            continue;
        }
        if (char === "{") depth += 1;
        if (char === "}") depth -= 1;
        ensure(depth >= 0, "Nginx 配置块提前闭合");
    }
    ensure(!quote, "Nginx 配置存在未闭合引号");
    ensure(depth === 0, "Nginx 配置存在未闭合块");
}

function ensure(condition, message) {
    if (!condition) throw new Error(message);
}

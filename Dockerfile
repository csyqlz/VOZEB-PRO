# syntax=docker/dockerfile:1.7

FROM node:22-bookworm-slim AS web-build

WORKDIR /app/web
ARG BUILD_NODE_OPTIONS
ARG NEXT_BUILD_CPUS
ARG NEXT_PUBLIC_SITE_URL
ARG PNPM_VERSION=11.9.0
ENV NEXT_TELEMETRY_DISABLED=1
ENV CI=1
ENV NODE_OPTIONS=${BUILD_NODE_OPTIONS}
ENV NEXT_BUILD_CPUS=${NEXT_BUILD_CPUS}
ENV PNPM_HOME=/pnpm
ENV PATH=${PNPM_HOME}:${PATH}

RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate

COPY web/package.json web/pnpm-lock.yaml web/pnpm-workspace.yaml ./
RUN --mount=type=cache,target=/pnpm/store pnpm install --frozen-lockfile --store-dir=/pnpm/store

COPY VERSION /app/VERSION
COPY CHANGELOG.md /app/CHANGELOG.md
COPY web ./
RUN --mount=type=cache,target=/app/web/.next/cache pnpm run typecheck && NEXT_SKIP_BUILD_TYPECHECK=1 pnpm run build
RUN set -eux; \
    mkdir -p /app/sharp-runtime/node_modules/.pnpm; \
    find node_modules/.pnpm -mindepth 1 -maxdepth 1 -type d -name '@img+sharp-*' -exec cp -a {} /app/sharp-runtime/node_modules/.pnpm/ \;; \
    test -n "$(find /app/sharp-runtime/node_modules/.pnpm -mindepth 1 -maxdepth 1 -type d -name '@img+sharp-linux-*' -print -quit)"; \
    test -n "$(find /app/sharp-runtime/node_modules/.pnpm -mindepth 1 -maxdepth 1 -type d -name '@img+sharp-libvips-linux-*' -print -quit)"

FROM node:22-bookworm-slim

WORKDIR /app
ARG DEBIAN_APT_MIRROR=http://deb.debian.org
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
ENV VOZEB_PRO_DATA_DIR=/app/web/.data
ENV VOZEB_PRO_INTERNAL_ORIGIN=http://127.0.0.1:3000
ENV NODE_OPTIONS=--max-old-space-size=384
ENV UV_THREADPOOL_SIZE=2

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    rm -f /etc/apt/apt.conf.d/docker-clean && \
    sed -i "s|http://deb.debian.org|${DEBIAN_APT_MIRROR}|g" /etc/apt/sources.list.d/debian.sources && \
    apt-get update && apt-get install -y --no-install-recommends ca-certificates chromium ffmpeg fonts-noto-cjk postgresql-client && \
    sed -i "s|${DEBIAN_APT_MIRROR}|http://deb.debian.org|g" /etc/apt/sources.list.d/debian.sources
RUN mkdir -p /app/web/scripts

COPY VERSION /app/VERSION
COPY CHANGELOG.md /app/CHANGELOG.md
COPY --from=web-build /app/web/public /app/web/public
COPY --from=web-build /app/web/.next/standalone /app/web
COPY --from=web-build /app/web/.next/static /app/web/.next/static
COPY --from=web-build /app/web/node_modules/.pnpm/playwright-core@1.62.1/node_modules/playwright-core /app/web/node_modules/.pnpm/playwright-core@1.62.1/node_modules/playwright-core
COPY --from=web-build /app/sharp-runtime/node_modules/.pnpm /app/web/node_modules/.pnpm
COPY web/scripts/reset-admin-password.mjs /app/web/scripts/reset-admin-password.mjs
COPY web/scripts/generation-runtime.mjs /app/web/scripts/generation-runtime.mjs
COPY web/scripts/generation-worker-policy.mjs /app/web/scripts/generation-worker-policy.mjs
COPY web/scripts/generation-worker.mjs /app/web/scripts/generation-worker.mjs
COPY web/scripts/disaster-recovery-core.mjs /app/web/scripts/disaster-recovery-core.mjs
COPY web/scripts/disaster-object-storage.mjs /app/web/scripts/disaster-object-storage.mjs
COPY web/scripts/disaster-backup.mjs /app/web/scripts/disaster-backup.mjs
COPY web/scripts/disaster-restore.mjs /app/web/scripts/disaster-restore.mjs

RUN cd /app/web && node -e "require('sharp')"
RUN mkdir -p /app/web/.data && chown -R node:node /app/web

EXPOSE 3000
USER node
CMD ["sh", "-c", "cd /app/web && PORT=3000 node server.js"]

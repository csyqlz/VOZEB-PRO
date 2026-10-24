FROM vozeb-pro:pricing-edit-build-20261012 AS app-build

FROM vozeb-pro:pre-pricing-edit-20261012
USER root
COPY --from=app-build --chown=node:node /app/web/.next/standalone/ /app/web/
COPY --from=app-build --chown=node:node /app/web/.next/static/ /app/web/.next/static/
COPY --from=app-build --chown=node:node /app/web/public/ /app/web/public/
COPY --from=app-build --chown=node:node /app/sharp-runtime/node_modules/.pnpm/ /app/web/node_modules/.pnpm/
COPY --from=app-build --chown=node:node /app/web/node_modules/.pnpm/playwright-core@1.62.1/node_modules/playwright-core/ /app/web/node_modules/.pnpm/playwright-core@1.62.1/node_modules/playwright-core/
RUN cd /app/web && node -e "require('sharp'); require('playwright-core'); const fs = require('fs'); if (!fs.existsSync('.next/BUILD_ID') || !fs.existsSync('.next/static') || !fs.existsSync('public/logo.svg')) process.exit(1)"
USER node

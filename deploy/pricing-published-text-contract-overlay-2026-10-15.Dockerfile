FROM vozeb-pro:pricing-text-estimate-20261014
USER root
RUN rm -rf /app/web/.next /app/web/public
COPY --chown=node:node . /app/web/
RUN cd /app/web && node -e "require('sharp'); require('playwright-core'); const fs=require('fs'); if(!fs.existsSync('.next/BUILD_ID') || !fs.existsSync('.next/static') || !fs.existsSync('public/logo.svg')) process.exit(1)"
USER node

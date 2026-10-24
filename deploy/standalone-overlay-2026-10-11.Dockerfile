FROM vozeb-pro:pre-video-reference-20261011
USER root
COPY --chown=node:node . /app/web/
RUN cd /app/web && node -e "require('sharp'); require('playwright-core'); const fs=require('fs'); if(!fs.existsSync('.next-release-pricing-20261011k/BUILD_ID')) process.exit(1)"
USER node

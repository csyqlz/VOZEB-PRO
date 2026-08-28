FROM ghcr.io/sigstore/cosign/cosign:v2.6.1 AS cosign

FROM node:22-alpine

RUN apk add --no-cache docker-cli docker-cli-compose
COPY --from=cosign /ko-app/cosign /usr/local/bin/cosign
WORKDIR /opt/vozeb-updater
COPY deploy/updater/*.mjs ./

USER root
EXPOSE 8787
CMD ["node", "server.mjs"]

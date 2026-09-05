# syntax=docker/dockerfile:1.7
# Native recovery contracts are tested against Hermes v2026.8.31.
ARG HERMES_IMAGE=nousresearch/hermes-agent:v2026.8.31@sha256:64923faeae267792bf9bf87fe3b4c4869e35004e360c7df01730ad801b74d524

# Hermes now ships Node 26; Olympus supports Node 22.22–25. Keep the tested
# Node/npm toolchain identical in dependency, build and runtime stages.
FROM node:22.22.3-bookworm-slim@sha256:e21fc383b50d5347dc7a9f1cae45b8f4e2f0d39f7ade28e4eef7d2934522b752 AS node-runtime
FROM ${HERMES_IMAGE} AS olympus-base
USER root
COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
COPY --from=node-runtime /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
RUN ln -sf /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm && \
    ln -sf /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx

FROM olympus-base AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM dependencies AS build
COPY . ./
RUN npm run build

FROM olympus-base AS production-dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM olympus-base AS runtime
ARG VERSION=0.6.0
ARG REVISION=unknown
WORKDIR /opt/olympus-dispatch
# HOST=0.0.0.0 is required inside the container network namespace; exposure to the
# outside world stays controlled by the published port binding (loopback by default).
ENV NODE_ENV=production \
    PORT=6969 \
    HOST=0.0.0.0 \
    HERMES_AGENT_DIR=/opt/hermes \
    HERMES_PYTHON=/opt/hermes/.venv/bin/python \
    PYTHONDONTWRITEBYTECODE=1
COPY --from=production-dependencies --chown=10000:10000 /app/node_modules ./node_modules
COPY --from=build --chown=10000:10000 /app/dist ./dist
COPY --chown=10000:10000 package.json ./
LABEL org.opencontainers.image.title="Olympus Dispatch" \
      org.opencontainers.image.version=$VERSION \
      org.opencontainers.image.revision=$REVISION \
      org.opencontainers.image.source="https://github.com/digitalchili/olympus"

# The upstream Hermes image starts its own gateway wrapper by default. Olympus
# imports the installed AIAgent directly and must not start another gateway.
ENTRYPOINT []
USER 10000:10000
EXPOSE 6969
HEALTHCHECK --interval=30s --timeout=10s --start-period=90s --retries=3 \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PORT || 6969}/api/ready`).then(response => { if (!response.ok) process.exit(1); }).catch(() => process.exit(1))"]
CMD ["node", "dist/server/server/index.js"]

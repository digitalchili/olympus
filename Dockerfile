# syntax=docker/dockerfile:1.7
# Keep the Node and Python/Hermes runtimes aligned with the central Somboon VPS.
ARG HERMES_IMAGE=nousresearch/hermes-agent:v2026.7.30@sha256:b869e64d6496d4763d5e4fb675b5f504cb23b0e35ec9b790481a56118602b10f

FROM ${HERMES_IMAGE} AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM dependencies AS build
COPY . ./
RUN npm run build

FROM ${HERMES_IMAGE} AS production-dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM ${HERMES_IMAGE} AS runtime
ARG VERSION=0.3.0
ARG REVISION=unknown
WORKDIR /opt/olympus-dispatch
ENV NODE_ENV=production \
    PORT=6969 \
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

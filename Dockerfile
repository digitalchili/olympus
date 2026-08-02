# syntax=docker/dockerfile:1.7
# Keep the Node and Python/Hermes runtimes aligned with the central Somboon VPS.
ARG HERMES_IMAGE=nousresearch/hermes-agent:v2026.7.7.2@sha256:9c841866021c54c4596849f6135717e8a4d52ba510b7f52c50aef1de1a283973

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
WORKDIR /opt/olympus-dispatch
ENV NODE_ENV=production \
    PORT=6969 \
    HERMES_AGENT_DIR=/opt/hermes \
    HERMES_PYTHON=/opt/hermes/.venv/bin/python \
    PYTHONDONTWRITEBYTECODE=1
COPY --from=production-dependencies --chown=10000:10000 /app/node_modules ./node_modules
COPY --from=build --chown=10000:10000 /app/dist ./dist
COPY --chown=10000:10000 package.json ./

# The upstream Hermes image starts its own gateway wrapper by default. Olympus
# imports the installed AIAgent directly and must not start another gateway.
ENTRYPOINT []
USER 10000:10000
EXPOSE 6969
HEALTHCHECK --interval=30s --timeout=10s --start-period=90s --retries=3 \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PORT || 6969}/api/health`).then(async (response) => { const body = await response.json(); if (!response.ok || !body.ok || !body.hermes) process.exit(1); }).catch(() => process.exit(1))"]
CMD ["node", "dist/server/server/index.js"]

# syntax=docker/dockerfile:1.7
#
# One Dockerfile, three targets that share the dependency and build layers:
#   web     Next.js standalone server (apps/web)
#   worker  job runner (apps/worker) plus the migration runner (packages/db)
#
# Build from the repo root:
#   docker build -f infra/docker/Dockerfile --target web    --build-arg APP_URL=https://app.useflock.com -t flock-web .
#   docker build -f infra/docker/Dockerfile --target worker -t flock-worker .
#
# Coolify builds it through docker-compose.coolify.yaml (see infra/coolify/README.md).

# Override to build from a registry mirror (Docker Hub rate-limits anonymous pulls).
ARG NODE_IMAGE=node:22.22.0-bookworm-slim

FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=1 \
    NEXT_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /repo

# ── Dependencies: only manifests, so this layer survives source-only changes ──
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/payments/package.json packages/payments/
COPY packages/telegram/package.json packages/telegram/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @flock/web... --filter @flock/worker...

# ── Build ────────────────────────────────────────────────────────────────────
FROM deps AS build
COPY . .
# Statically rendered pages read APP_URL (metadataBase) at build time, so the web image is per environment.
ARG APP_URL=https://app.useflock.com
ENV APP_URL=${APP_URL}
RUN pnpm --filter @flock/worker build \
 && NEXT_OUTPUT=standalone pnpm --filter @flock/web build
# Migration runner and ops tools (deploy-check, set-telegram-webhook, stripe-webhooks), bundled like the worker.
RUN cd apps/worker && node build.mjs --tools /out/extra
# A self-contained worker directory with production node_modules only.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm --filter @flock/worker deploy --prod --legacy /out/worker \
 && cp -r apps/worker/dist /out/worker/dist \
 && mv /out/extra/migrate /out/extra/tools /out/worker/

# ── Runtime: web ─────────────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS web
ARG GIT_SHA=dev
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    GIT_SHA=${GIT_SHA}
WORKDIR /app
COPY --from=build --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=node:node /repo/apps/web/public ./apps/web/public
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/api/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "apps/web/server.js"]

# ── Runtime: worker (+ `node migrate/dist/migrate.js` and `node tools/<name>.js`) ─
FROM ${NODE_IMAGE} AS worker
ARG GIT_SHA=dev
ENV NODE_ENV=production \
    GIT_SHA=${GIT_SHA}
WORKDIR /app
COPY --from=build --chown=node:node /out/worker ./
USER node
EXPOSE 8081
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8081/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "--enable-source-maps", "dist/main.js"]

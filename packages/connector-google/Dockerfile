# syntax=docker/dockerfile:1
#
# The image ayni-connector-google: the Google connector alone, built from the repository's root with
#   docker build -f packages/connector-google/Dockerfile -t ayni-connector-google .
# It holds no account, no secret and no state (TOOL-OAUTH-018); its configuration is its environment (README).

# ---- Build stage ---------------------------------------------------------
# Node version is kept in sync with the 2060 reusable CI workflow (Node 24).
FROM node:24-alpine AS builder
WORKDIR /repo

# Corepack activates the pnpm version pinned in package.json ("packageManager").
RUN corepack enable

# The workspace's manifests first, so that the install layer is cached across source-only changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json tsconfig.build.json ./
COPY packages/feature-profiles/package.json packages/feature-profiles/
COPY packages/provider-kit/package.json packages/provider-kit/
COPY packages/conformance/package.json packages/conformance/
COPY packages/provider-memory/package.json packages/provider-memory/
COPY packages/connector-google/package.json packages/connector-google/
RUN pnpm install --frozen-lockfile

COPY packages ./packages
# the connector and the workspace packages it depends on, then the connector alone with its production dependencies
RUN pnpm --filter @ayni.org/ayni-connector-google... run build \
  && pnpm --filter @ayni.org/ayni-connector-google deploy --prod /out

# ---- Runtime stage -------------------------------------------------------
FROM node:24-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8000 \
    HOST=0.0.0.0 \
    LOG_LEVEL=info

COPY --from=builder /out ./

USER node
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=3s CMD wget -q -O /dev/null "http://127.0.0.1:${PORT}/healthz" || exit 1
# RESOURCE_URL is required: the address of /mcp as the agent reaches it
CMD ["node", "build/cli.js"]

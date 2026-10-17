FROM node:24-alpine

ENV CI=true
RUN corepack enable
WORKDIR /app

# Every workspace manifest, because --frozen-lockfile validates the whole
# workspace against the lockfile even when installing one app's dependencies.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/woo-mcp/package.json apps/woo-mcp/
COPY apps/toolbox-mcp/package.json apps/toolbox-mcp/
COPY apps/gateway/package.json apps/gateway/
COPY apps/dashboard/package.json apps/dashboard/
COPY packages/wook8-mcp/package.json packages/wook8-mcp/
RUN pnpm install --frozen-lockfile --prod --filter toolbox-mcp

COPY tsconfig.base.json ./
COPY apps/toolbox-mcp apps/toolbox-mcp

USER node
WORKDIR /app/apps/toolbox-mcp
EXPOSE 3000
CMD ["node", "src/index.ts"]

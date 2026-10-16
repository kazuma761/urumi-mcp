# The dashboard is the only thing in the repo that needs compiling, and the
# gateway serves it, so it is built here and copied into the runtime stage.
FROM node:24-alpine AS dashboard

ENV CI=true
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/woo-mcp/package.json apps/woo-mcp/
COPY apps/toolbox-mcp/package.json apps/toolbox-mcp/
COPY apps/gateway/package.json apps/gateway/
COPY apps/dashboard/package.json apps/dashboard/
COPY packages/urumi-mcp/package.json packages/urumi-mcp/
# Not --prod: Vite is a devDependency.
RUN pnpm install --frozen-lockfile --filter dashboard
COPY tsconfig.base.json ./
COPY apps/dashboard apps/dashboard
RUN pnpm --filter dashboard build

FROM node:24-alpine

ENV CI=true
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/woo-mcp/package.json apps/woo-mcp/
COPY apps/toolbox-mcp/package.json apps/toolbox-mcp/
COPY apps/gateway/package.json apps/gateway/
COPY apps/dashboard/package.json apps/dashboard/
COPY packages/urumi-mcp/package.json packages/urumi-mcp/
RUN pnpm install --frozen-lockfile --prod --filter gateway

COPY tsconfig.base.json ./
# Includes apps/gateway/drizzle: the migrations the gateway applies on start.
COPY apps/gateway apps/gateway
COPY --from=dashboard /app/apps/dashboard/dist /app/dashboard
ENV DASHBOARD_DIR=/app/dashboard

USER node
WORKDIR /app/apps/gateway
EXPOSE 8080
CMD ["node", "src/index.ts"]

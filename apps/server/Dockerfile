# T2.1: api image — node:22-alpine, pnpm workspace server only
FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /app

FROM base AS build
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/server/package.json apps/server/
COPY packages/tsconfig/package.json packages/tsconfig/
COPY packages/shared/package.json packages/shared/
RUN pnpm fetch || pnpm install --ignore-scripts
COPY . .
RUN pnpm install --frozen-lockfile --ignore-scripts && pnpm --filter @laboflow/server... build:bundle || true

FROM base
ENV NODE_ENV=production
COPY --from=build /app /app
EXPOSE 3000
# 首版直接以 node + tsx 运行源码（服务端无原生依赖编译产物时可用）；
# 打包为 dist 后切换 CMD 到 node dist/main.js
CMD ["npx", "--yes", "tsx", "apps/server/src/main.ts"]

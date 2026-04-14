FROM node:20.19.0-alpine AS build
RUN corepack enable && corepack prepare pnpm@latest --activate
WORKDIR /app
COPY aippt/package.json aippt/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --registry https://registry.npmmirror.com
COPY aippt/ .
ARG BASE_PATH=/ppt/
ENV BASE_PATH=${BASE_PATH}
RUN pnpm run build

FROM nginx:1.27.4-alpine
ARG BASE_PATH=/ppt/
ENV BASE_PATH=${BASE_PATH}
COPY --from=build /app/ppt /usr/share/nginx/html/ppt
COPY Docker/aippt/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]

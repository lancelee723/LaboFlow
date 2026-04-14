FROM node:20.19.0-alpine AS build
WORKDIR /app
COPY Clawith/frontend/package*.json ./
RUN npm ci --registry https://registry.npmmirror.com
COPY Clawith/frontend/ .
RUN npm run build

FROM nginx:1.27.4-alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY Docker/clawith-frontend/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 3000
CMD ["nginx", "-g", "daemon off;"]

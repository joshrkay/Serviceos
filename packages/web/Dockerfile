FROM node:20-alpine AS builder
WORKDIR /app

COPY package*.json ./
COPY packages/api/package.json ./packages/api/
COPY packages/shared/package.json ./packages/shared/
COPY packages/web/package*.json ./packages/web/
RUN npm ci --workspace=packages/web

COPY packages/web ./packages/web
RUN npm run build --workspace=packages/web

FROM nginx:alpine
COPY --from=builder /app/packages/web/dist /usr/share/nginx/html
COPY packages/web/nginx.conf.template /etc/nginx/templates/default.conf.template
EXPOSE 80

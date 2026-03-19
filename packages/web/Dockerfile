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
# Default fallback so nginx starts in PR/preview environments where API_URL
# hasn't been explicitly configured. Overridden by the Railway service variable.
ENV API_URL=http://localhost:3000
COPY --from=builder /app/packages/web/dist /usr/share/nginx/html
# Copy template to a non-auto-processed location. We run envsubst manually
# with a restricted variable list ('$PORT $API_URL') so nginx's own runtime
# variables ($uri, $http_host, $remote_addr, etc.) are left intact and not
# replaced with empty strings.
COPY packages/web/nginx.conf.template /etc/nginx/nginx.conf.template
EXPOSE 80
CMD ["sh", "-c", "envsubst '$PORT $API_URL' < /etc/nginx/nginx.conf.template > /etc/nginx/conf.d/default.conf && nginx -g 'daemon off;'"]

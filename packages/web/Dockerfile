cat > packages/web/Dockerfile << 'EOF'
FROM node:20-alpine AS builder
WORKDIR /app

# Copy root manifests (workspace config + lock file)
COPY package*.json ./

# Copy package manifests for workspace resolution
COPY packages/api/package.json ./packages/api/
COPY packages/shared/package.json ./packages/shared/
COPY packages/web/package*.json ./packages/web/

# Install all deps including devDeps (need typescript, vite, etc)
RUN npm ci --include=dev

# Copy tsconfig files
COPY tsconfig.json tsconfig.base.json ./

# Copy web source
COPY packages/web ./packages/web
RUN npm run build --workspace=packages/web

FROM nginx:alpine
# Default fallback so nginx starts in PR/preview environments where API_URL
# hasn't been explicitly configured. Overridden by the Railway service variable.
ENV API_URL=http://localhost:3000
COPY --from=builder /app/packages/web/dist /usr/share/nginx/html
COPY packages/web/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY packages/web/env.js.template /etc/nginx/templates/env.js.template
COPY packages/web/render-runtime-config.sh /docker-entrypoint.d/40-render-runtime-config.sh
RUN chmod +x /docker-entrypoint.d/40-render-runtime-config.sh
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
EOF

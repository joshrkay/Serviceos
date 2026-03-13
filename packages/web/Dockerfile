# ── Stage 1: Build ────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/web/package.json ./packages/web/
COPY packages/shared/package.json ./packages/shared/

RUN npm ci --include=dev

COPY tsconfig.json tsconfig.base.json ./
COPY packages/web ./packages/web
COPY packages/shared ./packages/shared

# Build args become VITE_ env vars at build time
ARG VITE_CLERK_PUBLISHABLE_KEY
ARG VITE_API_URL

RUN cd packages/web && npm run build

# ── Stage 2: Runtime (nginx) ──────────────────────────────────────────────────
FROM nginx:alpine AS runtime

# Remove default nginx page
RUN rm -rf /usr/share/nginx/html/*

# Copy built assets
COPY --from=builder /app/packages/web/dist /usr/share/nginx/html

# nginx config: serve SPA with fallback to index.html for client-side routing
COPY packages/web/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]

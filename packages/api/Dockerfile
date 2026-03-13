# ── Stage 1: Build ────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Copy manifests for layer caching
COPY package.json package-lock.json ./
COPY packages/api/package.json ./packages/api/
COPY packages/shared/package.json ./packages/shared/

# Install all deps including devDeps (need tsc)
RUN npm ci --include=dev

# Copy source files
COPY tsconfig.base.json ./
COPY packages/api ./packages/api
COPY packages/shared ./packages/shared

# Compile shared package first, then api
RUN cd packages/shared && npx tsc -p tsconfig.json || true
RUN cd packages/api && npx tsc -p tsconfig.json

# ── Stage 2: Runtime ──────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime

WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/api/package.json ./packages/api/
COPY packages/shared/package.json ./packages/shared/

# Production deps only
RUN npm ci --omit=dev

# Copy compiled output
COPY --from=builder /app/packages/api/dist ./packages/api/dist
COPY --from=builder /app/packages/shared/dist ./packages/shared/dist

EXPOSE 3000

ENV NODE_ENV=production

CMD ["node", "packages/api/dist/index.js"]

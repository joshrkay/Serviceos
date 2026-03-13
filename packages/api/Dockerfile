# ── Stage 1: Build ────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Copy root manifests (workspace config + lock file)
COPY package.json package-lock.json ./

# Copy package manifests for workspace resolution
COPY packages/api/package.json ./packages/api/
COPY packages/shared/package.json ./packages/shared/

# Install all deps including devDeps (need tsc)
RUN npm ci --include=dev

# Copy tsconfig files (shared package extends root tsconfig.json)
COPY tsconfig.json tsconfig.base.json ./

# Copy only the api source (shared not needed — api has no @ai-service-os/shared imports)
COPY packages/api/src ./packages/api/src
COPY packages/api/tsconfig.json ./packages/api/tsconfig.json

# Compile — exclude test files to avoid jest type issues
RUN cd packages/api && npx tsc --outDir dist --rootDir src \
    --module commonjs --target ES2022 \
    --esModuleInterop true --skipLibCheck true \
    --resolveJsonModule true --declaration false --declarationMap false \
    --noEmit false

# ── Stage 2: Runtime ──────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime

WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/api/package.json ./packages/api/
COPY packages/shared/package.json ./packages/shared/

# Production deps only
RUN npm ci --omit=dev

# Copy compiled output from builder
COPY --from=builder /app/packages/api/dist ./packages/api/dist

EXPOSE 3000

ENV NODE_ENV=production

CMD ["node", "packages/api/dist/index.js"]

FROM node:20-alpine AS base
WORKDIR /app

# Install dependencies — include shared in workspace resolution
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/api/package.json packages/api/
COPY packages/web/package.json packages/web/
RUN npm ci --ignore-scripts

# Build Shared (API and Web depend on it)
FROM base AS shared-build
COPY tsconfig.json tsconfig.base.json ./
COPY packages/shared/ packages/shared/
RUN cd packages/shared && npx tsc

# Build Web
FROM base AS web-build
COPY tsconfig.base.json ./
COPY packages/web/ packages/web/
RUN cd packages/web && npx vite build

# Build API
FROM base AS api-build
COPY tsconfig.base.json ./
COPY --from=shared-build /app/packages/shared/ packages/shared/
COPY packages/api/ packages/api/
RUN cd packages/api && npx tsc --project tsconfig.build.json

# Web static files (served by nginx) — used by @serviceos/web
FROM nginx:alpine AS web
COPY --from=web-build /app/packages/web/dist /usr/share/nginx/html
COPY packages/web/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80

# API production image — used by @serviceos/api (last stage = Railway default)
FROM node:20-alpine AS api
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/api/package.json packages/api/
COPY packages/web/package.json packages/web/
RUN npm ci --omit=dev --ignore-scripts
COPY --from=shared-build /app/packages/shared/dist packages/shared/dist
COPY --from=shared-build /app/packages/shared/package.json packages/shared/
COPY --from=api-build /app/packages/api/dist packages/api/dist
COPY --from=api-build /app/packages/api/package.json packages/api/
EXPOSE 3000
CMD ["node", "packages/api/dist/src/index.js"]

FROM node:20-alpine AS base
WORKDIR /app

# Install dependencies. `--ignore-scripts` skips the prepare hook in
# packages/shared, so shared/dist is NOT built here — the `shared-build`
# stage below handles that explicitly.
COPY package.json package-lock.json ./
COPY packages/api/package.json packages/api/
COPY packages/web/package.json packages/web/
COPY packages/shared/package.json packages/shared/
RUN npm ci --ignore-scripts

# Build shared first — both web (vite resolves @ai-service-os/shared via
# package.json main → dist/index.js) and api (tsc) need shared/dist to
# exist before they can compile.
FROM base AS shared-build
COPY tsconfig.json tsconfig.base.json ./
COPY packages/shared/ packages/shared/
RUN cd packages/shared && npx tsc

# Build Web
FROM shared-build AS web-build
COPY packages/web/ packages/web/
RUN cd packages/web && npx vite build

# Build API
FROM shared-build AS api-build
COPY packages/api/ packages/api/
ARG RAILWAY_GIT_COMMIT_SHA=unknown
RUN echo "build: $RAILWAY_GIT_COMMIT_SHA" && cd packages/api && npx tsc --project tsconfig.build.json

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
COPY packages/api/package.json packages/api/
COPY packages/web/package.json packages/web/
COPY packages/shared/package.json packages/shared/
RUN npm ci --omit=dev --ignore-scripts
COPY --from=api-build /app/packages/api/dist packages/api/dist
COPY --from=api-build /app/packages/api/package.json packages/api/
COPY --from=shared-build /app/packages/shared/dist packages/shared/dist
COPY --from=web-build /app/packages/web/dist packages/web/dist
EXPOSE 3000
CMD ["node", "packages/api/dist/src/index.js"]

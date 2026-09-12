FROM node:20.20.2-alpine AS base
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
# Provider credentials are runtime-only. Never declare them as Docker ARGs or
# interpolate them in RUN instructions: builders persist expanded commands in
# logs and image history. Optional filler PCM files are generated offline and
# checked into a release artifact; when absent, the existing runtime cache
# degrades gracefully without exposing a production credential.

# Web static files (served by nginx) — used by @serviceos/web
#
# Pinned by digest, not just tag. `nginx:alpine` is a floating tag: an upstream
# push silently changes the image serving the SPA between two deploys of
# identical source, with nothing in the repo recording that it moved. The tag
# is kept alongside the digest for human readability — at time of pinning
# `alpine`, `1.31.3-alpine`, and `1.31.3-alpine3.24` all resolved to this same
# digest, so this is the image that was already shipping. Dependabot's `docker`
# ecosystem (.github/dependabot.yml) bumps it; do not replace it with a bare
# tag to avoid the bump.
FROM nginx:1.31.4-alpine@sha256:db35bfc6b2951e7f8a72db5db120288c127ffaeeb4a6d4b95a26fead017d5913 AS web
COPY --from=web-build /app/packages/web/dist /usr/share/nginx/html
COPY packages/web/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80

# API production image — used by @serviceos/api (last stage = Railway default)
FROM node:20.20.2-alpine AS api
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

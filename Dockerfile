FROM node:20-alpine AS base
WORKDIR /app

# Install dependencies
COPY package.json package-lock.json ./
COPY packages/api/package.json packages/api/
COPY packages/web/package.json packages/web/
RUN npm ci --ignore-scripts

# Build API
FROM base AS api-build
COPY tsconfig.base.json ./
COPY packages/api/ packages/api/
RUN cd packages/api && npx tsc --project tsconfig.json

# Build Web
FROM base AS web-build
COPY tsconfig.base.json ./
COPY packages/web/ packages/web/
RUN cd packages/web && npx vite build

# API production image
FROM node:20-alpine AS api
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY packages/api/package.json packages/api/
COPY packages/web/package.json packages/web/
RUN npm ci --omit=dev --ignore-scripts
COPY --from=api-build /app/packages/api/dist packages/api/dist
COPY --from=api-build /app/packages/api/package.json packages/api/
EXPOSE 3000
CMD ["node", "packages/api/dist/src/index.js"]

# Web static files (served by Railway's static hosting or nginx)
FROM nginx:alpine AS web
COPY --from=web-build /app/packages/web/dist /usr/share/nginx/html
COPY packages/web/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80

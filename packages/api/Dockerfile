FROM node:20-alpine AS builder
WORKDIR /app

COPY package*.json ./
COPY tsconfig.base.json ./
COPY packages/api/package*.json ./packages/api/
RUN npm ci --workspace=packages/api

COPY packages/api ./packages/api
RUN npm run build --workspace=packages/api

FROM node:20-alpine
WORKDIR /app

COPY --from=builder /app/packages/api/package*.json ./
COPY --from=builder /app/packages/api/dist ./dist

RUN npm ci --omit=dev

ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "dist/src/index.js"]

# Rivet rewrite — single deployable image (API serves the built SPA).
#
# Deploy contract (Railway/Render or any container host):
#   pre-deploy: node packages/api/dist/db/migrate.js   (versioned SQL migrations)
#   start:      node packages/api/dist/index.js
#   health:     GET /health
#   env:        DATABASE_URL (non-superuser, RLS-enforced role)
#               DATABASE_ADMIN_URL (migrations, pg-boss, platform layer)
#               CLERK_JWKS_URL, OPENAI_API_KEY, STRIPE_WEBHOOK_SECRET,
#               TWILIO_ACCOUNT_SID/AUTH_TOKEN, VOICE_WEBHOOK_SECRET (all optional)
#
# Jobs run on pg-boss, so 2+ instances are safe from day one.

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/api/package.json packages/api/
COPY packages/web/package.json packages/web/
RUN npm ci
COPY packages ./packages
RUN npm run build -w packages/contracts \
  && npm run build -w packages/api \
  && npm run build -w packages/web

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/api/package.json packages/api/
RUN npm ci --omit=dev --workspace=packages/api --workspace=packages/contracts
COPY --from=build /app/packages/contracts/dist packages/contracts/dist
COPY --from=build /app/packages/api/dist packages/api/dist
COPY --from=build /app/packages/web/dist packages/web/dist
ENV PORT=3001
ENV WEB_DIST_PATH=/app/packages/web/dist
EXPOSE 3001
CMD ["node", "packages/api/dist/index.js"]

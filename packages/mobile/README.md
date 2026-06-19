# @serviceos/mobile

The owner-operator mobile app (iOS + Android) — Expo + React Native + Expo
Router. Delivers the voice → AI proposal → approve (5s undo) → push-notify loop
over the existing ServiceOS API.

See the design docs:
- `docs/mobile/owner-operator-app-spec.md` — architecture
- `docs/mobile/workflows.md` — the operational workflow catalog
- `docs/plans/2026-06-19-001-feat-mobile-mvp-owner-operator-plan.md` — build plan

## Isolated project (not a root workspace) — on purpose

Unlike `packages/api|web|shared`, this package is **not** a member of the root
npm workspaces. The root `Dockerfile` runs `npm ci` against the root lockfile
while only `COPY`ing the api/web/shared `package.json`s; adding mobile to the
root workspaces would either break that `npm ci` (workspace missing from the
image) or pull the whole Expo/React Native tree into the api image. Keeping
mobile isolated makes the Railway api/web build provably unaffected.

Consequences:
- Install/run from inside this directory: `cd packages/mobile && npm install`.
- It has its own `node_modules` and `package-lock.json`.
- `@ai-service-os/shared` (pure Zod) is resolved from its **built `dist`** via
  Metro (`metro.config.js` `extraNodeModules` → the package root, honoring
  `package.json` `main`) and TypeScript path aliases (`tsconfig.json` →
  `../shared/dist`). This matches how `packages/web`/`packages/api` consume it.
  Rebuild shared after changing it: `npm run build --workspace=packages/shared`
  (the monorepo root install already builds it via `prepare`). It is not an npm
  dependency of this package.

## Stack notes
- **Expo SDK 52** (React 18.3.1, RN 0.76) — React aligned with `packages/web`.
- **NativeWind v4** (Tailwind v3) driven by the shared design tokens in
  `src/theme/tokens.js` (mirrors `packages/web/src/index.css`).

## Tests
- Pure-logic tests (tokens, formatters, hooks) run under **Vitest**:
  `npm test` (or, from the repo root, `npx vitest run --root packages/mobile`).
- React Native component-render tests use **jest-expo**: `npm run test:rn`.

## Run
```
cp .env.example .env   # set EXPO_PUBLIC_API_URL + Clerk key
npm install
npm start
```

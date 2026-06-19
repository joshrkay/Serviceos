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

## Running & viewing the app

All commands run from inside `packages/mobile`.

### Dev (Metro)
```
cp .env.example .env   # set EXPO_PUBLIC_API_URL + Clerk key
npm install
npm start
```

### On your iPhone (Expo Go) — fastest, free, no Apple account
1. Install **Expo Go** from the App Store.
2. `npm install && npx expo start` (add `--tunnel` if your phone isn't on the same Wi-Fi).
3. Scan the QR with the Camera app → it opens in Expo Go with live reload.

All current deps (expo-router, nativewind, reanimated, screens, safe-area-context,
gesture-handler) are Expo SDK 52 modules supported by Expo Go, so no custom dev build is
needed yet.

### Web preview / screenshot (no device)
```
npm install
npx expo export --platform web --output-dir web-dist
npx serve web-dist            # or any static server, then open in a browser
```
The app renders via React-Native-Web (approximates iOS, not pixel-identical).

### TestFlight (real iOS beta) — via EAS Build
Prereqs: an **Apple Developer Program** membership ($99/yr) and a free **Expo** account.
```
npx eas-cli login
npx eas-cli build --platform ios --profile preview   # EAS cloud-builds the .ipa + manages signing
npx eas-cli submit --platform ios                    # uploads to App Store Connect → TestFlight
```
Fill in the `submit.production.ios` placeholders in `eas.json` (Apple ID, ASC app id, team
id). The build runs on Expo's servers — trigger it from your machine or a CI job with an
`EXPO_TOKEN`, not from this repo's cloud env. Replace `assets/icon.png` (a solid-brand
placeholder) with real branding before shipping.

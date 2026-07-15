# Rivet (ServiceOS) Mobile — Store Release Runbook (Blocker #2)

_What it takes to ship the Expo app to TestFlight / Play internal testing.
Pairs with `packages/mobile/README.md` (dev/QA) and `docs/LAUNCH-READINESS-v4.md`
(the blocker analysis). The app itself is real and API-wired — these are
release-config gaps, not code gaps._

## Already fixed in code (this branch)

- ✅ **Push token in standalone builds.** `getExpoPushTokenAsync` now receives an
  explicit `projectId` (`src/push/nativePushDeps.ts:resolveProjectId`) resolved
  from `app.json` → `expo.extra.eas.projectId` (or the `EAS_PROJECT_ID` env).
  Without this, push silently dies for every production user. It stays a no-op
  in dev (Expo's dev-client auto-resolves), so behavior is unchanged locally.
- ✅ **Version** bumped `0.0.1` → `1.0.0` (`app.json` + `package.json`).
- ✅ **`extra.eas.projectId` scaffold** added to `app.json` (empty — see step 1).

## Steps to release (run from `packages/mobile`)

### 1. Create the EAS project (writes the real projectId)
```
npx eas-cli login
npx eas-cli init        # populates app.json → expo.extra.eas.projectId + owner
```
This fills the empty `projectId` scaffold. The push fix above reads it
automatically — no code change after `eas init`.

### 2. Provide production runtime env to the build
The app inlines `EXPO_PUBLIC_*` at build time (`src/lib/env.ts` falls back to
`http://localhost:3000` when unset — wrong for prod). Set them as EAS
environment variables (preferred) or per-profile `env` in `eas.json`:
```
npx eas-cli env:create --environment production --name EXPO_PUBLIC_API_URL --value https://<api-host>
npx eas-cli env:create --environment production --name EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY --value pk_live_...
```
(Optionally `EAS_PROJECT_ID` if you prefer the env path over `app.json`.)

For Stripe Terminal Tap to Pay Test builds, also set:
```
npx eas-cli env:create --environment preview --name EXPO_PUBLIC_TERMINAL_SIMULATED --value 1
```
Terminal requires this EAS native build (config plugins in `app.json`). **Expo Go is not supported** once Terminal is linked.

### 3. Fill the App Store Connect submit credentials
`eas.json` → `submit.production.ios` still has placeholders:
`appleId`, `ascAppId`, `appleTeamId` (`REPLACE_WITH_…`). Fill them (or pass via
`eas submit` flags / EAS secrets). Requires an **Apple Developer Program**
membership.

### 4. Replace placeholder store assets
`assets/icon.png` is a 4.5 KB solid-brand placeholder. Add real assets and wire
them in `app.json` (keys intentionally NOT pre-added — referencing missing files
fails the build):
- **App icon** — 1024×1024 PNG → `expo.icon` (already pointed at `./assets/icon.png`; just replace the file).
- **Splash image** → add `expo.splash.image: "./assets/splash.png"` (backgroundColor `#030213` already set).
- **Android adaptive icon** → add `expo.android.adaptiveIcon.foregroundImage: "./assets/adaptive-icon.png"` + `backgroundColor`.
- **Notification icon** → extend the `expo-notifications` plugin entry:
  `["expo-notifications", { "icon": "./assets/notification-icon.png", "color": "#1F5FD6" }]`.

### 5. (Optional) Decide OTA updates
No `expo-updates` / `updates` block / `runtimeVersion` is configured today — OTA
is **not** wired. Either add `expo-updates` (+ `app.json` `updates` +
`runtimeVersion`, and per-profile `channel` in `eas.json`) for hot-fixes, or
accept store-only updates for v1 and treat OTA as out-of-scope.

### 6. Build + submit
```
npx eas-cli build --platform ios --profile production    # store-distribution build (required for TestFlight)
npx eas-cli submit --platform ios                         # → App Store Connect → TestFlight
# Android internal testing:
npx eas-cli build --platform android --profile production
npx eas-cli submit --platform android
```
The `production` profile uses `appVersionSource: "remote"` + `autoIncrement`, so
build numbers increment server-side; the `1.0.0` marketing version is set.
Builds run on Expo's servers — trigger from your machine or CI with an
`EXPO_TOKEN`, not from this repo's cloud sandbox.

### 7. Verify push end-to-end (the fix's payoff)
On a **physical device** install of the production build: sign in → grant
notifications → confirm a `POST /api/devices` lands (token registered) → send a
test push from the dispatcher/approval flow → confirm receipt. (Simulators
return `unsupported` by design.)

## Status checklist
- [x] Push `projectId` resolution (code)
- [x] Version → 1.0.0
- [ ] `eas init` (projectId + owner)
- [ ] Production `EXPO_PUBLIC_*` env on EAS
- [ ] `eas.json` submit credentials
- [ ] Real icon / splash / adaptive / notification assets
- [ ] OTA decision (wire `expo-updates` or document out-of-scope)
- [ ] First `eas build` + `eas submit` to TestFlight / Play internal

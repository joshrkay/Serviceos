---
name: verify
description: Run the Rivet mobile app (packages/mobile) in a phone-sized browser against a local API and drive its screens for runtime verification. Use when a change to packages/mobile needs to be observed running, not just typechecked or unit-tested.
---

# Verify the mobile app at runtime (no device needed)

The app is Expo + expo-router. Native-only paths (Stripe Terminal, push,
camera, splash/icon, bundle identifier) cannot be observed here; everything
else renders through react-native-web on Metro's dev server and can be driven
with Playwright's chromium at a phone viewport.

## Handle (what worked, 2026-10-22)

1. API with in-memory repos (no Postgres needed), dev-auth bypass, from `packages/api`:
   ```
   npm run build -w packages/shared            # once, from the repo root
   NODE_ENV=dev DEV_AUTH_BYPASS=true PORT=3000 TELEPHONY_ENABLED=false EMAIL_ENABLED=false LOG_LEVEL=warn nohup npm run dev > /tmp/api.log 2>&1 &
   curl -fsS http://localhost:3000/health
   ```
2. Metro web with the dev-auth shim (signed in as `dev_owner` without Clerk), from `packages/mobile`:
   ```
   CI=1 EXPO_NO_TYPESCRIPT_SETUP=1 EXPO_PUBLIC_AUTH_MODE=dev EXPO_PUBLIC_API_URL=http://localhost:3000 \
     EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_dev_auth_shim nohup npx expo start --web --port 8081 > /tmp/metro.log 2>&1 &
   curl -fsS http://localhost:8081/status      # "packager-status:running" (first bundle takes ~1-2 min)
   ```
   `expo export` cannot be used for this: it sets NODE_ENV=production and the
   dev-auth guard refuses the shim there (by design).
3. Drive with Playwright from the repo-root install (`/home/user/Serviceos/node_modules/playwright`),
   `executablePath: '/opt/pw-browsers/chromium'`, `args: ['--no-sandbox']`,
   viewport 390x844 (and 320 for the overflow invariant), `isMobile: true`.

## Seeding data through the real API

Mint the same unsigned JWT the shim uses and POST (see
`scripts/maestro-device-run.sh` `api_post`):
```
b64url() { printf '%s' "$1" | base64 | tr -d '=\n' | tr '/+' '_-'; }
TOKEN="$(b64url '{"alg":"none","typ":"JWT"}').$(b64url '{"sub":"dev_owner","sid":"dev-session","role":"owner"}').x"
```
customer → location → job → invoice (`POST /api/invoices` with `jobId` + cents
line items) → `POST /api/invoices/:id/issue` so the invoice is `open` and the
"Collect on site" panel renders on `/invoices/:id`.

## Gotchas

- Metro's dev LogBox overlay is a separate root, `<div id="error-overlay">`;
  it intercepts clicks and covers screenshots. Remove it with
  `document.getElementById('error-overlay')?.remove()` after each navigation.
- Two page errors fire on every route on web and are pre-existing (identical on
  `main`): `ExpoNotifications.getLastNotificationResponse` and
  `expo-file-system.getInfoAsync` are native-only. Ignore them unless the count
  changes.
- `/sign-in` renders Home under the shim (always signed in). Without the shim
  the real Clerk provider needs a reachable Clerk frontend API; in the sandbox
  clerk-js cannot load (`ERR_TUNNEL_CONNECTION_FAILED`) and the app stays blank.
- Metro tries to launch React Native DevTools (Electron) as root and logs a
  FATAL for it; harmless.
- Three Metro instances can run side by side on different ports (e.g. a
  `git worktree` of `main` on 8082 for a baseline comparison).

## Flows worth driving

`/` (Home: money + approvals, mode switch), `/today`, `/voice`, `/customers`,
`/jobs`, `/invoices/:id` (collect panel; tap "Collect card payment" → web
fallback message, no crash), `/settings/delete-account` (two-step confirm; do
not confirm), `/nope/missing` (+not-found), and the 320px overflow check.

---
name: verify
description: >
  Runtime-verify packages/web changes by booting the authenticated SPA
  headlessly (no Clerk cloud), seeding data, and driving flows in Chromium.
  Use when /verify needs to observe web UI behavior, not just run tests.
---

# Web runtime verification (headless, no Clerk cloud)

The web app is gated by Clerk, whose hosted frontend API is unreachable in
sandboxed/CI environments — so a naive `vite dev` white-screens on auth.
This repo ships a **dev test-auth mode** that swaps Clerk for a local shim so
the whole authenticated app boots and is driveable. Recipe below.

## 1. Boot the API (InMemory, dev auth bypass)

```bash
cd packages/api
NODE_ENV=dev DEV_AUTH_BYPASS=true PORT=3000 LOG_LEVEL=warn \
  TELEPHONY_ENABLED=false EMAIL_ENABLED=false \
  node -r ts-node/register src/index.ts &
# health: curl -s -o /dev/null -w '%{http_code}' http://localhost:3000/health  → 200 (takes ~15-20s)
```

- No `DATABASE_URL` → InMemory repos (data lives only for this process — do NOT
  restart between seeding and driving).
- `DEV_AUTH_BYPASS=true` decodes an **unsigned** JWT's `sub` (+ optional `role`)
  and bootstraps a tenant. `/api/onboarding/status` returns 503 on InMemory —
  harmless (the OnboardingGuard renders through it).

## 2. Boot vite in test-auth mode

`packages/web/.env.local` (git-ignored):
```
VITE_AUTH_MODE=dev
VITE_CLERK_PUBLISHABLE_KEY=pk_test_ZHVtbXkuY2xlcmsuYWNjb3VudHMuZGV2JA   # placeholder; shim ignores it
VITE_API_URL=http://localhost:3000
VITE_DEV_AUTH_SUB=dev_owner
VITE_DEV_AUTH_ROLE=owner     # or technician / dispatcher
```
```bash
cd packages/web && VITE_AUTH_MODE=dev npx vite --port 5173 --host 127.0.0.1 &
```

`VITE_AUTH_MODE=dev` makes `vite.config.ts` alias `@clerk/clerk-react` →
`src/dev/clerk-dev-shim.tsx`, which returns a signed-in session and a
`getToken()` that mints the same unsigned JWT the API bypass accepts. **Never
active in a real build.** The shim returns **referentially-stable** hook
results — do not "simplify" it to return fresh objects per render, or
`useDetailQuery`/`useApiClient` consumers spin in an infinite refetch loop and
every detail page hangs on a spinner.

The browser and API share one identity (`sub=dev_owner`), so data seeded via
HTTP is visible in the UI.

## 3. Seed representative data

```bash
cd packages/api && node scripts/verify-seed.mjs   # prints a JSON blob of ids
```
Creates a customer, 3 jobs (one scheduled today, one at a 23:30-local tz
boundary, one unscheduled), appointments, an estimate, and a draft invoice —
all via the real API as the owner. Tenant tz = America/New_York. Re-run to get
fresh ids (it prints them).

## 4. Drive Chromium

The project pins a Playwright browser build that isn't installed; use the
pre-installed one via `executablePath`:
```js
import { chromium } from '@playwright/test';
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
});
// tz-sensitive flows: newContext({ timezoneId: 'Australia/Sydney' }) to prove
// tenant-tz rendering is independent of the viewer's browser tz.
```
Gotchas:
- A "What's new" modal opens on first load — dismiss with the **"Got it"** button
  before interacting.
- Detail pages (`/jobs/:id`) chain ~10 fetches (doubled under StrictMode) — wait
  ~5-10s after load, not `networkidle` (streams never idle → it times out).
- Run the driver script from inside `packages/web` (or copy it there) so
  `@playwright/test` resolves; don't pipe stdout through `head` (SIGPIPE kills node
  mid-run) — redirect to a file.

## Flow map (what proves each area)

- Cancel a job: JobDetail → **More** → *Customer Canceled* → reason → **Continue**
  → **Confirm and cancel** → POST `/api/jobs/:id/transition {status:'canceled'}`.
- Clear a customer field: `/customers/:id/edit` → clear email → **Save** → PUT
  body carries `email:""`; reload `/customers/:id` shows `—`.
- Tenant-tz day: set browser tz ≠ NY, load `/schedule` — today's appointments
  (incl. the 23:30-local one) render in NY time on the correct day.
- Home Today: `/` "Active today" counts appointments in the tenant-tz day.
- Job data integrity: `/jobs/:id` shows real estimate/invoice/schedule (no mock data).

## Teardown
`fuser -k 5173/tcp 3000/tcp` and `rm packages/web/.env.local`.

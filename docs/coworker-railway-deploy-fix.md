# Railway Deployment Fix — Coworker Prompt

**What this is:** A self-contained brief for a coworker (or an agent with Railway
access) to diagnose and fix the ServiceOS Railway deployment. It exists because
the sandbox that wrote the code **cannot reach Railway** — all `*.railway.app`
hosts return `403 host_not_allowed` from there, so deploy verification and any
dashboard/CLI fix must be done by someone whose network can reach Railway.

**You need:** Railway access to the `unique-adaptation` project (services
`@serviceos/api`, `@serviceos/web`, and the Postgres plugin), via the dashboard
or `railway` CLI (`railway login`), plus permission to view/edit service
variables and trigger redeploys.

**Branch under test:** `claude/brave-dirac-u5whk` (PR #450). The relevant deploy
config is `railway.toml`; the API entrypoint is `packages/api/src/index.ts`.

**How to report:** Copy this file to
`docs/verification-runs/railway-deploy-fix-YYYY-MM-DD-yourname.md`, fill in the
findings under each step, and mark each: ✅ confirmed good · ❌ broken (describe) ·
⚠️ works but off · ⏭️ skipped (why).

---

## Background — what we already know

- `railway.toml` previously hardcoded `port = 3000` for the edge target. The app
  honors Railway's injected `PORT` (`process.env.PORT || 3000`) and `app.listen`
  binds all interfaces, so a static edge port misroutes traffic ("Application not
  found") whenever the injected `PORT` differs (Railway's default is 8080). The
  hardcoded line was **removed** so the edge follows the injected `$PORT`. This
  needs **post-deploy verification** (Step 2).
- A prior live session (`docs/verification-runs/beta-verification-2026-05-13.md`)
  noted the real host is `serviceosapi-development.up.railway.app` (note `eos`,
  not `ios`) and that `PORT=8080` is Railway's default.
- The production API-key audit has **never been run** (the sandbox can't reach
  Railway). The app silently runs AI in **mock mode** when `AI_PROVIDER_API_KEY`
  is unset, so a missing key won't crash — it will quietly fake AI (Step 4).

---

## Step 0 — Identify the live URLs and service

- [ ] In Railway → `unique-adaptation` → `@serviceos/api` → Settings → Networking,
      copy the public `*.up.railway.app` URL. Expected:
      `https://serviceosapi-development.up.railway.app`.
- [ ] Copy the `@serviceos/web` URL (expected `serviceosweb-development.up.railway.app`).
- Record API URL: `__________________________`  Web URL: `__________________________`

## Step 1 — Is the API actually up?

- [ ] `curl -i https://<api-url>/health` → expect **HTTP 200** with a small JSON body.
- [ ] If you get Railway's **"Application not found / Train has not arrived"** page,
      the edge is routing to the wrong port — go to Step 2.
- [ ] `curl -i https://<api-url>/ready` → may be 200 or 503. **503 is OK** if the DB
      is cold; `/ready` 503s on an unreachable DB by design. Only `/health` must be 200.
- Finding: `__________________________`

## Step 2 — Port routing (the main fix to verify)

The fix removed the hardcoded `port` from `railway.toml`. Confirm the app's listen
port and the edge target now agree.

- [ ] Railway → `@serviceos/api` → Variables: read the **`PORT`** value (if any).
      Record it: `PORT = __________` (or "not set" → Railway default 8080).
- [ ] Railway → `@serviceos/api` → Deploy logs: find the startup line
      `[startup] PORT=<n> NODE_ENV=production` and `ServiceOS API running on
      http://localhost:<n>`. Record the `<n>`: `__________`.
- [ ] Confirm `/health` (Step 1) returns 200. If it does, the edge target and the
      listen port agree — **fix verified**.
- [ ] If `/health` still 404s as "Application not found": the edge is not routing to
      `<n>`. Set the service **`PORT`** variable explicitly (e.g. `8080`), redeploy,
      and re-check. Do **not** re-add a hardcoded `port` to `railway.toml` unless the
      edge truly cannot autodetect — if you must, set it to the exact `<n>` above.
- Finding: `__________________________`

## Step 3 — Pre-deploy migration health

`railway.toml` runs `preDeployCommand = node packages/api/dist/src/db/migrate.js`
before each deploy. A newer migration adds a `tenant_settings_us_region_check`
constraint that fails to apply if existing `tenant_settings` rows violate it.

- [ ] Railway → latest deploy → check the **pre-deploy / release** logs for
      `Migrations completed successfully` (good) vs `Migration failed: ... check
      constraint "tenant_settings_us_region_check" ... violated by some row`.
- [ ] If it failed: some existing tenant rows have a `us_region` value the new CHECK
      rejects. Either backfill those rows to a valid value before the constraint is
      added, or relax/repair the migration. Capture the failing rows:
      `SELECT id, us_region FROM tenant_settings WHERE us_region IS NOT NULL;`
- Finding: `__________________________`

## Step 4 — Production API-key / secrets audit (was blocked from the sandbox)

For each, confirm the env var is present and non-empty in `@serviceos/api` →
Variables. **AI is the critical one** — if missing, the system runs against a mock.

- [ ] `AI_PROVIDER_API_KEY` (+ optional `AI_PROVIDER_BASE_URL`, `AI_DEFAULT_MODEL`).
      Verify live, not mock: `curl https://<api-url>/api/health/ai` →
      `{"providers":[...]}` with a non-empty `providers` array. An **empty**
      `{"providers":[]}` means **no AI key / mock mode** — flag it.
- [ ] `CLERK_SECRET_KEY`, `CLERK_WEBHOOK_SECRET`
- [ ] `STRIPE_API_KEY`, `STRIPE_WEBHOOK_SECRET`
- [ ] `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TENANT_ENCRYPTION_KEY`
- [ ] `SENDGRID_API_KEY`, `SENDGRID_FROM_EMAIL`
- [ ] `DATABASE_URL` (or the discrete `DB_*` vars)
- Record which are present / missing / mock: `__________________________`

## Step 5 — End-to-end smoke (optional, if you have time)

- [ ] Open the web URL → you should see the Fieldly login page (not a white screen).
- [ ] Sign up / log in and confirm you land inside the app.
- [ ] If the QA harness can reach Railway from your machine, run it against the
      deploy (see `qa/README.md`):
      ```
      export E2E_API_URL=https://<api-url> E2E_BASE_URL=https://<web-url>
      export E2E_DB_URL_READONLY=<postgres public proxy url>
      export E2E_CLERK_HMAC_SECRET=<@serviceos/api CLERK_SECRET_KEY value>
      npm run qa:doctor && npm run e2e:qa-matrix
      ```
- Finding: `__________________________`

---

## Deliverable back to the dev team

1. Whether `/health` is 200 and the **port fix is confirmed** (Step 2), including
   the actual listen port and the service `PORT` variable.
2. The **key-status table** from Step 4 — especially whether `AI_PROVIDER_API_KEY`
   is live vs mock. If the AI key is missing, **stop and report it** before any
   AI-dependent flow is exercised.
3. Any migration failure from Step 3.
4. If you changed a service variable or `railway.toml`, say exactly what and why so
   we can land it in the repo.

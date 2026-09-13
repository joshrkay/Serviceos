# Live Deploy Verification — 2026-08-05

**What this is:** the live-deploy verification run for the 2026-08-05 production-readiness
pass (`/PRODUCTION-READINESS-2026-08-05.md`), in the shape of
`docs/archive/2026-07-cleanup/docs/coworker-railway-deploy-fix.md`. Steps 0–2 and most of
Step 4 were completed live from a machine that reaches `*.railway.app` (the old
sandbox 403 constraint did not apply). Steps marked ⏳ need Railway **dashboard**
or prod-DB access and are the remaining operator checklist.

Legend: ✅ confirmed good · ❌ broken · ⚠️ works but off · ⏳ needs dashboard/DB access

## Step 0 — Live URLs

- ✅ API prod: `https://serviceosapi-production.up.railway.app` · API dev: `https://serviceosapi-development.up.railway.app`
- ✅ Web prod: `https://serviceosweb-production.up.railway.app` · Web dev: `https://serviceosweb-development.up.railway.app`
- All four responded 200 on 2026-08-05.

## Step 1 — Is the API up?

- ✅ prod `GET /health` → 200 `{"status":"ok","environment":"production","checks":{"database":{"status":"ok"},"drain":{"status":"ok"}}}`
- ✅ prod `GET /ready` → 200 `{"status":"ready"}`
- ✅ dev `/health` → 200 (database ok, drain ok)

## Step 2 — Port routing

- ✅ Verified by behavior: `railway.toml` intentionally pins no port and `/health` serves 200 on the public domain in both envs — edge and listen port agree. No action.

## Step 3 — Pre-deploy migration health

- ⏳ **B2**: migration `131_appointment_assignments_no_double_booking` self-skips with only
  `RAISE WARNING` when legacy overlapping assignment rows exist. Run against prod:
  `SELECT conname FROM pg_constraint WHERE conname = 'no_double_booking';`
  If absent: clean overlapping rows, re-run the migration block.
- Local `npm run migrate:dryrun` on main @ 388063a6: ✅ all 268 migrations valid.

## Step 4 — Production key/secret audit

- ✅ `AI_PROVIDER_API_KEY` present (prod telephony health `llmGateway:true` — computed as
  `!!config.AI_PROVIDER_API_KEY`, app.ts:4201). NOTE: `/api/health/ai` shows `providers: []`
  because zero AI requests have occurred since the 2026-08-03 deploy (breaker cells are
  lazily created) — see B1 below, and confirm with the METRICS_TOKEN-gated
  `GET /api/health/ai/completion` probe.
- ✅ `TWILIO_ACCOUNT_SID`/`AUTH_TOKEN` + `STORAGE_*` (capabilities `recording:true`)
- ✅ Deepgram + ElevenLabs (`stt:true`, `tts:true`, `mediaStreams:true`)
- ✅ SendGrid/Twilio-from (`messageDelivery:true`) · `DATABASE_URL` (`database:true`)
- ✅ `STRIPE_WEBHOOK_SECRET`, `CLERK_*`, `TENANT_ENCRYPTION_KEY`, `RLS_RUNTIME_ROLE`:
  boot-required in prod (`validateProductionConfig`) and prod is serving ⇒ present.
- ⚠️ `TWILIO_BUSINESS_NAME` unset — greeting says "our team" (cosmetic).
- ⏳ **B1 (go/no-go swing item)**: `POSTHOG_API_KEY` and `SENTRY_DSN` on prod services.
  PostHog events flowed only 2026-07-16→07-28 (≤4 tenants, QA-shaped), nothing since;
  zero AI calls since the 08-03 deploy. Check the prod service Variables for both keys AND
  scan Railway HTTP logs since 07-28 for organic traffic (Twilio webhooks, portal hits,
  authenticated API calls). Outcomes: (a) traffic exists but keys unset → set keys —
  ops is currently blind; (b) no traffic → surface to product; the "live tenants"
  premise needs review.
- ⏳ **B3**: `ONE_TAP_APPROVE_SECRET` on prod — unset silently omits digest one-tap
  action links (no boot failure, no warning). Now documented in
  `.env.production.example` + `docs/prod-env-checklist.md` (branch `devops/declare-one-tap-secret`).

## Step 5 — End-to-end smoke

- ✅ Web prod + dev URLs serve 200.
- ⏳ **B4**: after merging this pass's nine branches, deploy via CI (deploy.yml already
  gates on health poll + smoke), then re-run Steps 1–4 and confirm `/api/health/ai`
  providers is non-empty after the first AI call.
- ⏳ **B5 (optional)**: qa-matrix E2E against dev per `qa/README.md` (needs `E2E_*` secrets).

## Deliverable back to the dev team

1. Port fix + health: ✅ verified live, both environments.
2. Key-status table: ✅ everything the live surface can prove is present; ⏳ POSTHOG/SENTRY/ONE_TAP need dashboard reads (B1/B3).
3. Migration health: ✅ dry-run clean; ⏳ B2 prod constraint check outstanding.
4. Repo changes from this run: nine local branches (see the Branch log in
   `/PRODUCTION-READINESS-2026-08-05.md`); nothing pushed.

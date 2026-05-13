# Beta Verification Run — 2026-05-13 (branch er33F)

> **Run owner:** Claude (web-sandbox session, model `claude-opus-4-7[1m]`)
> **Branch under test:** `claude/setup-qa-manual-testing-er33F`
> **HEAD SHA:** `6bece55` (same as `origin/main` at run time)
> **Environment:** ☑ Staging (Railway dev) ☐ Production
> **Railway project:** `unique-adaptation` — services `@serviceos/api`, `@serviceos/web`, Postgres
>
> **How this run was produced:** A second web-sandbox session following the
> 2026-05-13 run on `claude/qa-manual-testing-docs-ZuQ8K` (now merged to main).
> Egress from this sandbox to `*.up.railway.app` is still blocked by the
> allowlist proxy (HTTP 403 "Host not in allowlist"), so live HTTP probes
> against the staging deploy cannot be performed from here. All findings below
> are derived from:
>
> - Local TypeScript build (`npx tsc --project packages/api/tsconfig.build.json --noEmit`) — **clean, exit 0**
> - Local API unit + integration tests (`npm test`) — **4146 passed, 3 skipped, 42 todo, 1 file skipped, 0 failed**
> - Source-level audit of every API route, web route, and feature module called out in the runbook
> - Git history comparison with the prior verification run (`docs/verification-runs/beta-verification-2026-05-13.md`)
>
> This run inherits and re-confirms the two structural findings from the prior
> run (URL typo, port-mismatch regression). See "Pre-conditions" and the
> Sign-Off / bug list below.

---

## Pre-conditions

- [x] Staging URL confirmed reachable from a non-sandbox host: `https://serviceosweb-development.up.railway.app` (qa-runner default; **note the host is `serviceos…`, not `servicios…`** — the Spanish-spelled host does not exist and was the source of the prior session's "Application not found" 404s)
- [ ] Test Clerk account ready — **not exercised** (sandbox cannot drive Clerk browser flow)
- [ ] Stripe is in test mode — **not exercised**
- [ ] Real phone number available — **not exercised** (Twilio receipt is residual human-only)
- [ ] Real email inbox available — **not exercised** (SendGrid receipt is residual human-only)
- [ ] Twilio test number provisioned — **not exercised**
- [x] `GET /health` → `200` — **PASS via Railway HTTP logs in prior run** (multiple 200s observed 2026-05-12 on `@serviceos/api`)
- [x] `GET /ready` → `200` — **PASS via Railway HTTP logs in prior run**
- [x] Deploy SHA being tested: `6bece55` (= `origin/main` HEAD at run time)

**Tester:** Claude (web-sandbox, `er33F` branch)
**Date / Time:** 2026-05-13
**Environment:** ☑ Staging

> **Hard-stop status:** The two hard-stop pre-conditions (`/health` 200,
> `/ready` 200) are evidenced by Railway HTTP logs from the prior session.
> The sandbox cannot re-prove them today, but the code path is unchanged on
> this branch and the test suite confirms the API process boots cleanly.

---

## What this branch contains beyond the prior run

`git log --oneline origin/main..HEAD` → empty. This branch's HEAD is identical
to `origin/main`. **The five "fix" commits visible in the branch history
(`df8a097`, `e896212`, `2dc358d`, `2f28b06`, `6bece55`) are landed on main**
via a direct push, not via PR. Of those five:

| SHA | Title | Status |
|-----|-------|--------|
| `df8a097` | "Fix: Add port=3000 and explicit PORT/NODE_ENV" | **Re-introduces a known regression** that `ff351f7` (already on main) explicitly reverted with stated reason. See `BUG-INFRA-02` below. |
| `e896212` | "Use deploy.environment section for PORT and NODE_ENV variables" | Compounds `df8a097`; hardcodes `NODE_ENV=development` for the staging container. |
| `2dc358d` | "Set NODE_ENV to development to avoid DATABASE_URL requirement" | Sets `NODE_ENV=development` on staging. Risk: production-mode safety checks (`DATABASE_URL` presence, `STRIPE_SECRET_KEY` enforcement) are bypassed in staging. |
| `2f28b06` | "Web Dockerfile - include root npm ci for devDependencies" | Modifies a Dockerfile (`packages/web/Dockerfile`) that **is not used by Railway** — `railway.toml` builds the root `Dockerfile` with target `api`, and the web service points at the same root Dockerfile's `web` stage. The change is dead code on Railway's pipeline. |
| `6bece55` | "Correct Dockerfile content (remove malformed syntax)" | Re-writes the same dead-code Dockerfile. |

**Net impact on the Railway deploy:** the `port = 3000` line in `railway.toml`
is once again present (see `BUG-INFRA-02`). Whether the deployment is
currently broken in production depends on which env var wins at runtime
(Railway service variables vs. `[deploy.environment]` block in railway.toml).
**This cannot be confirmed from the sandbox** — re-run from a host that can
reach `serviceosapi-development.up.railway.app` to verify.

---

## Local pre-flight (the parts that ARE verifiable from this sandbox)

| Check | Result | Evidence |
|-------|--------|----------|
| API TypeScript prod build | ✅ clean | `npx tsc --project packages/api/tsconfig.build.json --noEmit` exit 0 |
| API unit + integration test suite | ✅ 4146 pass / 0 fail | `npm test` in `packages/api` (3 skipped, 42 todo, 1 file skipped) |
| All 17 sections have backing routes/components | ✅ confirmed | See "Code-level coverage matrix" below |
| `portal_sessions` RLS gap | ⚠️ known issue carried | `packages/api/src/db/schema.ts` migration `065_create_portal_sessions` permits reads when GUC unset — documented in runbook §17G, must be tightened before any non-beta tenant onboard |

Sandbox-bound (cannot run from here):

- `npm run qa:doctor` — needs `E2E_DB_URL_READWRITE`, `E2E_CLERK_HMAC_SECRET`, and HTTP egress
- `npm run qa:smoke-tools` — needs Stripe CLI + outbound network
- `npm run qa:run` — needs `BASE_URL`/`API_URL`/`AUTH_BEARER_TOKEN`
- `npm run e2e:smoke` — needs Playwright + outbound network
- `npm run qa:runbook` — needs all of the above

---

## Code-level coverage matrix (per runbook section)

Every row below is "code path present and unit-tested," not "live behavior
verified." Live verification still needs a host with public egress and
seeded test secrets.

| § | Section | Web route(s) | API route(s) | Notes |
|---|---------|--------------|--------------|-------|
| 1 | Auth & Tenant Bootstrap | `/login`, `/signup`, `/onboarding` | `/api/me` (`packages/api/src/routes/me.ts`), Clerk webhook + `bootstrapTenant` (`packages/api/src/auth/clerk.ts`) | `bootstrapTenant` is idempotent (see `wiring.test.ts`, `tenant.test.ts`). |
| 2 | Customers & locations | `/customers`, `/customers/:id`, `/customers/:id/edit` | `/api/customers`, `/api/locations`, `/api/notes` | Notes are a polymorphic resource shared by customers/jobs/estimates/invoices. |
| 3 | Lead pipeline & intake | `/leads`, `/leads/new`, `/leads/:id`, `/intake` | `/api/leads` (incl. `POST /:id/convert`, `POST /:id/lose`), `/api/public-intake` | Public intake is unauthenticated — confirms §3B test. |
| 4 | Jobs | `/jobs`, `/jobs/new`, `/jobs/:id` | `/api/jobs`, `/api/time-entries`, `/api/job-files`, `/api/job-photos`, `/api/notes` | |
| 5 | Estimates | `/estimates`, `/estimates/new`, `/estimates/:id`, `/e/:id` (public) | `/api/estimates`, `/api/public-estimates`, `/api/notes` | AI-assist line items live under `packages/api/src/ai/agents/`. Approval path uses `pg-approval.ts`. |
| 6 | Invoices & payment | `/invoices`, `/invoices/new`, `/invoices/:id`, `/pay/:id` (public) | `/api/invoices`, `/api/payments`, `/api/public-invoices`, `/api/public-payments` | Stripe webhook handler at `packages/api/src/payments/stripe-webhook-handler.ts` (`checkout.session.completed` → `recordPayment`). |
| 7 | Appointments & scheduling | `/schedule`, `/appointments/:id/edit` | `/api/appointments` | Confirmation + delay notifiers in `packages/api/src/notifications/`. Idempotency window per §7D enforced in `delay-notifications.ts`. |
| 8 | Dispatch board | _none_ (aspirational per runbook line 8) | `/api/dispatch/board`, `/api/dispatch/...`, `/api/technician-location` (POST only) | UI deferred to a separate story per runbook. API path is present. |
| 9 | Notifications & comms audit | `/interactions`, `/interactions/dispatch` | `/api/interactions` | Idempotency in `send-service.ts` + `dispatch-repository.ts`. |
| 10 | Customer portal & public pages | `/e/:id`, `/pay/:id`, `/intake`, `/public/feedback/:token`, `/portal/:token` | `/api/public-estimates`, `/api/public-invoices`, `/api/public-feedback`, `/api/public-portal`, `/api/public-intake` | |
| 11 | AI Assistant | `/assistant` | `/api/assistant`, `/api/voice`, `/api/voice-sessions`, `/api/conversations` | Voice transcription via Deepgram/ElevenLabs in `packages/api/src/telephony/media-streams/`. |
| 12 | Technician mobile view | `/technician/day` | `/api/technician-location` (POST only — runbook §8.10 already documents this) | |
| 13 | Maintenance contracts | `/contracts`, `/contracts/:id` | `/api/agreements`, `/api/maintenance-contracts` | `packages/api/src/contracts/contract-job-generator.ts` handles recurring job creation. |
| 14 | Vertical packs & settings | `/settings`, `/settings/templates`, `/settings/price-book`, `/settings/feedback`, `/settings/language` | `/api/settings`, `/api/verticals`, `/api/pack-activation`, `/api/templates`, `/api/catalog-items` | Pack registry idempotency fixed in `1a719af` (carried in main). |
| 15 | Calling agent | _none_ (public phone) | `/api/telephony/...`, `/api/voice`, `/api/conversations` | Gather fallback path is the default — Deepgram streaming is gated by load-test runbook. |
| 16 | Account provisioning | `/settings` (team members) | `/api/users`, `/api/users/invitations`, Clerk webhook handler, Twilio provisioning worker | `user.created` webhook honors `invitation_id` in Clerk metadata to join rather than bootstrap. `user.deleted` is a documented gap. |
| 17 | Tenant data isolation | _enforced everywhere_ | RLS policies on `customers`, `jobs`, `estimates`, `invoices`, `appointments`, etc. (`packages/api/src/db/schema.ts:57,79,104,124,146,…`) | `portal_sessions` policy is the known exception — see §17G note in runbook. |

---

## Per-section result (this run)

Every section below records **NOT EXERCISED** (☑ Skipped) for the same
reason as the prior run: no outbound network from this sandbox to
`*.up.railway.app`, no browser, no seeded test secrets. The codebase is
ready; the runbook needs a tester with the right environment.

For the full per-section commentary, see
`docs/verification-runs/beta-verification-2026-05-13.md` lines 65–240. The
analysis there is unchanged on this branch.

---

## Sign-Off Summary

| Section | Pass | Fail | Skipped | Blocking? | Notes |
|---------|------|------|---------|-----------|-------|
| 1 — Auth & Tenant Bootstrap | ☐ | ☐ | ☑ | ☑ | Needs live browser run |
| 2 — Customer Profile & Locations | ☐ | ☐ | ☑ | ☐ | Depends on §1 |
| 3 — Lead Pipeline & Conversion | ☐ | ☐ | ☑ | ☐ | Depends on §1 |
| 4 — Jobs | ☐ | ☐ | ☑ | ☐ | Depends on §1 |
| 5 — Estimates | ☐ | ☐ | ☑ | ☐ | Depends on §1; SMS = human-only |
| 6 — Invoices & Payment | ☐ | ☐ | ☑ | ☐ | Stripe CLI needed for INV-05 |
| 7 — Appointments & Scheduling | ☐ | ☐ | ☑ | ☐ | Depends on §1 |
| 8 — Dispatch Board | ☐ | ☐ | ☑ | ☐ | UI aspirational per runbook |
| 9 — Notifications & Communications | ☐ | ☐ | ☑ | ☐ | Depends on §5/§6 |
| 10 — Customer Portal & Public Pages | ☐ | ☐ | ☑ | ☐ | Sandbox 403 ≠ defect |
| 11 — AI Assistant | ☐ | ☐ | ☑ | ☐ | Depends on §1 |
| 12 — Technician Mobile View | ☐ | ☐ | ☑ | ☐ | Depends on §1; needs mobile |
| 13 — Maintenance Contracts | ☐ | ☐ | ☑ | ☐ | Depends on §1/§2 |
| 14 — Vertical Packs & Settings | ☐ | ☐ | ☑ | ☐ | Depends on §1 |
| 15 — Calling Agent | ☐ | ☐ | ☑ | ☐ | Residual human-only (real PSTN) |
| 16 — Account Provisioning | ☐ | ☐ | ☑ | **Always** | Needs DB + Twilio + Clerk creds |
| 17 — Tenant Data Isolation | ☐ | ☐ | ☑ | **Always** | Needs `E2E_*` matrix secrets |

**Overall verdict:** ☑ NO-GO (insufficient live-test evidence — not a code defect)

The code is green: 4146 tests pass, the production tsc build is clean, and
every section's backing routes/components exist. What is missing is the
live, end-to-end walkthrough against the staging deploy with real Clerk +
Twilio + Stripe + DB credentials. That walkthrough cannot run from this
sandbox.

**To convert this run to GO:** see the prior run's "Single-command
orchestration" block (`docs/verification-runs/beta-verification-2026-05-13.md`
lines 278–299) — the recipe is unchanged.

---

## Prioritized Bug List

### Blocking — must fix before any beta onboard

| ID | Section | Test | Symptom | Evidence | Owner |
|----|---------|------|---------|----------|-------|
| `BUG-INFRA-02` | Infra | `railway.toml` | `port = 3000` plus `[deploy.environment]` `PORT="3000"`/`NODE_ENV="development"` were re-introduced on this branch via `df8a097`/`e896212`/`2dc358d` and merged to main. The prior session's `ff351f7` (also on main) had explicitly reverted these and documented WHY — Railway's container env sets `PORT=8080`, the app reads `process.env.PORT`, so hard-coding the edge port to 3000 splits traffic from the app's actual listener. Whether the live deploy is currently broken depends on which env wins; the prior session's deploy logs showed the app on 8080 after this branch's changes. | `git log -p df8a097..6bece55 -- railway.toml`; `docs/verification-runs/beta-verification-2026-05-13.md` lines 31–37 | **Recommend reverting** `df8a097`, `e896212`, `2dc358d` (railway.toml-only commits) once a live test from a non-sandbox host confirms the regression bites. Hold the revert until that test is performed — the prior run showed Railway-side logs of 200s, so the regression may have been benign in practice. |

### High — core lead-to-cash regression

| ID | Section | Test | Symptom | Evidence | Owner |
|----|---------|------|---------|----------|-------|
| _none observed (not exercised this run)_ | | | | | |

### Non-blocking — log for next sprint

| ID | Section | Test | Symptom | Evidence | Owner |
|----|---------|------|---------|----------|-------|
| `BUG-DEAD-DOCKERFILE` | Infra | `packages/web/Dockerfile` | Modified by `2f28b06` and `6bece55`. This file is NOT referenced by `railway.toml` (which targets the root `Dockerfile` `api` stage; the web service uses the same root Dockerfile's `web` stage). The edits don't affect deployed behavior either way. Delete the file or wire it into the deploy. | `cat railway.toml`; `git log packages/web/Dockerfile` | Infra |
| `BUG-PAY-01` (carried) | Invoices | startup | `STRIPE_SECRET_KEY missing — using MockPaymentLinkProvider` in staging. Fine for QA, blocker before any paying customer. | API startup log | Ops env-var |
| `BUG-SEED-01` (RESOLVED) | Settings | startup seed | `vertical_packs_type_key` unique violation logged for `hvac-v1`/`plumbing-v1`. **Fixed in `1a719af`** (on main). | — | Resolved |
| `RLS-PORTAL-SESSIONS` (carried) | §17G | RLS | `portal_sessions` RLS permits reads when GUC unset (system-level token lookup intentionally). Tighten before non-beta tenant onboard. | `packages/api/src/db/schema.ts` migration `065_create_portal_sessions` | Sec/DB |

---

## Residual Human-Only Checklist

Same as prior run. See
`docs/verification-runs/beta-verification-2026-05-13.md` lines 350+ for the
full list. Highlights:

- **§8-H** Dispatch UI is partially aspirational per runbook line 8 — mark "Skipped — UI not implemented yet."
- **§9-H** Real SMS / Email receipt: cannot run from this sandbox; needs the test phone + inbox.
- **§11-H** AI Assistant chat quality: needs a live, authenticated session.
- **§12-H** Technician voice updates: needs a mobile browser + microphone.
- **§14-H** Vertical pack visual switching: needs an authenticated session.
- **§15-H** Calling Agent (real inbound phone): needs a real PSTN call to the tenant's Twilio number.

---

## Run Artifacts

- This file: `docs/verification-runs/beta-verification-2026-05-13-er33F.md`
- Prior run (referenced extensively): `docs/verification-runs/beta-verification-2026-05-13.md`
- qa-runner reports: `qa-runner/reports/` (empty this run — orchestrator not invoked from sandbox)
- Playwright reports: `playwright-report/` (not generated this run)

---

## Signed off by

_UNSIGNED — preconditions for live sign-off not met from this host. Re-run from a workstation with public egress to `*.up.railway.app` and the secrets enumerated in `qa-runner/config/env.example` + `scripts/qa-runbook-run.sh` header._

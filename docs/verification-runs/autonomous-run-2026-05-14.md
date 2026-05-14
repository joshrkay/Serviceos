# Autonomous run — 2026-05-14

Branch: `claude/assess-voice-config-a52Li`

Morning report from an overnight autonomous session. Written to be read cold:
what was done, what is now **verified**, and what **irreducibly still needs you**
(dashboard / credentials I cannot access from this sandbox).

---

## TL;DR

The codebase was never the main problem — **lack of verification** was. The
"first real QA run" had never happened; every prior verdict was a guess from
reading code.

Tonight I stood up the full stack **locally** (API + web + a real migrated
Postgres) and ran the verification harness against it for the first time. It
surfaced **two real application bugs** — both **found and fixed and verified**:

1. **Intermittent read-after-write 404** — the request transaction committed
   *after* the response was flushed.
2. **Stripe webhook payments never recorded** — a `payment_method` value the DB
   CHECK constraint rejected, so every `checkout.session.completed` webhook
   500'd.

The CI test gate is green locally (build, lint, **4,147 API + 828 web + 73
integration** tests). Both Docker build stages compile. The qa-matrix went from
its first run (7 pass / 7 partial / 7 fail) to **10 pass / 6 partial / 5 fail**
as the real bugs and harness bugs were fixed.

**The one thing I could not do:** reach Railway. This sandbox blocks
`*.up.railway.app` (HTTP 403). The *Railway deployment itself* is still
unverified — but its config is now self-sufficient, and the application code is
verified-good against a real local stack.

---

## What was done — 13 commits on this branch

| Area | Commits |
|---|---|
| **Deploy config** | healthcheck `/ready`→`/health`; web port `80`→`8080`; dev-safe `[deploy.environment]` baked into both `railway.toml`s + `docs/deployment.md` checklist |
| **Real bug #1** | `fix(api): commit the request transaction before flushing the response` — wraps `res.end` so COMMIT lands before the client sees the response; + regression test |
| **Real bug #2** | `fix(payments): reconcile payment_method values` — migration 094 widens the DB CHECK constraint; `PaymentMethod` type + validation gain `'stripe'`; the Stripe webhook records `method: 'stripe'` |
| **Auth** | `fix(auth): fall back to RS256 when an HMAC dev token doesn't verify` — dev env serves qa-matrix tokens AND real logins without a flag flip |
| **Dead code** | removed `service-os-app` (Next.js prototype: no deploy config, not in the workspace, superseded by `packages/web`) |
| **Harness fixes** | 8 qa-matrix harness bugs (the harness had never been run); INV-05/06 rewritten to send a correctly-shaped, **really-signed** Stripe webhook; integration tests can run without Docker via `TEST_DB_URL`; stale `getToken` test assertions |
| **Docs** | first evidence-backed `qa/reports/2026-05-14/QA-REPORT.md`; this report |

`service-os-agent` (Python) was **kept** — I'd initially called it dead, but it
has *active* contract tests and is documented architecture. Correcting that was
part of the run.

---

## The two real application bugs (both fixed + verified)

**#1 — Intermittent read-after-write 404.** `withTenantTransaction` committed
the per-request DB transaction on `res.finish` (which fires *after* the
response is on the wire) via a non-awaited `void cleanup(true)`. A client that
issued a follow-up request inside the ~1–2 ms COMMIT window read stale,
pre-commit data — e.g. *create an estimate, immediately edit it → 404*,
intermittently. Fixed by committing **before** the response is flushed (wrapping
`res.end`). Regression test added. `packages/api/src/middleware/tenant-context.ts`.

**#2 — Stripe webhook payments never recorded.** Three-way drift: the
`payments.payment_method` CHECK constraint allowed `('stripe','cash','check',
'other')`; the app's `PaymentMethod` type allowed `('cash','check','credit_card',
'bank_transfer','other')`; the Stripe webhook called `recordPayment({ method:
'credit_card' })`. `credit_card` passed app validation but **violated the DB
CHECK**, so every `checkout.session.completed` webhook returned 500 and **no
Stripe payment was ever recorded**. Fixed by migration 094 (widen the
constraint to the union), adding `'stripe'` to the type/validation, and having
the webhook record `method: 'stripe'`. Verified: a signed webhook now marks the
invoice paid (`status: 'paid', amount_paid_cents: 20000`); a duplicate delivery
is a no-op.

---

## The QA report — 10 pass · 6 partial · 5 fail

Full report: `qa/reports/2026-05-14/QA-REPORT.md`. **No real app bugs remain in
the fail column** — every remaining fail/partial is a known gap, a missing
credential, or the mock-LLM path:

| Verdict | What it means |
|---|---|
| **pass (10)** | Genuinely verified end-to-end: estimate create/validate/totals/**tenant isolation**, invoice create/list, **invoice paid via signed Stripe webhook**, **idempotent duplicate webhook**, assistant failure-handling. |
| **partial (6)** | Documented deviations (PUT-not-PATCH, `open`-not-`sent`, no email) OR the assistant infra responds but the **mock LLM** (no `AI_PROVIDER_API_KEY`) can't exercise the real intent path. |
| **fail (5)** | Real **unbuilt features**, matching predictions: INV-04 (payment-link HTTP route — the provider exists but is deliberately deferred per a code comment), INV-07 (overdue lifecycle — not implemented), AST-04/05/07 (assistant `send_invoice` / query / orchestration intents), AST-08 (no test exists for that matrix row). |

---

## What is verified

- **CI test gate, green locally:** API + web `tsc`, lint (both), **4,147** API
  unit tests, **828** web unit tests, **73** integration tests, all 93 migrations
  valid (dry-run).
- **Both Docker build stages compile:** web `vite build` (exit 0) and API
  `tsc --project tsconfig.build.json` (emits `dist/src/index.js` + `migrate.js`).
- **Core domain end-to-end** (qa-matrix, real DB): estimates, tenant isolation,
  invoices, **the Stripe payment webhook path**, idempotency.

## What is NOT verified — and irreducibly needs you

| Item | Why I can't | What to do |
|---|---|---|
| The **Railway deployment** running | Sandbox blocks `*.up.railway.app` (403) | Point the dev `api` + `web` services at this branch; redeploy; `curl <api>/health`. See `docs/deployment.md`. |
| **Live auth / login** | Needs a real Clerk instance | Set `CLERK_PUBLISHABLE_KEY` (API) + `VITE_CLERK_PUBLISHABLE_KEY` (web). |
| **`coverage-sweep`** (dead-button catcher) | No real Clerk key → SPA can't initialise; every route errors before the audit runs | Wire `E2E_CLERK_PUBLISHABLE_KEY` + `E2E_CLERK_SECRET_KEY` from a Clerk dev instance, then `npm run e2e:coverage-sweep`. |
| **Assistant / voice intents** (AST rows) | No `AI_PROVIDER_API_KEY` → API uses the mock LLM gateway | Set `AI_PROVIDER_API_KEY`, re-run the qa-matrix. |

## Flagged for follow-up (observed, not yet fixed)

- **Migration re-runnability.** `migrate.js` runs the *entire* migration SQL on
  every invocation (it's the Railway `preDeployCommand`). Re-running it against
  the test-populated local DB failed on `tenant_settings_us_region_check`
  ("violated by some row"). This may be test-data-specific or a real
  re-runnability bug that would fail `preDeployCommand` against a populated
  prod DB — it needs a focused look. Migration 094 itself is valid (verified by
  applying it directly).
- **INV-04** (payment-link HTTP route) is a *deliberate* deferral — a code
  comment in `app.ts` says the provider "will be wired into routes in a
  follow-up". Left as-is: implementing it needs design input (idempotency,
  audit-event shape) the team should make.

---

## Recommended next steps (for you)

1. **Get the branch onto dev** — point the Railway dev `api` + `web` services at
   `claude/assess-voice-config-a52Li`, set the variables in `docs/deployment.md`,
   redeploy. The config boots self-sufficiently.
2. **Wire the credentials** above and re-run `./scripts/qa-matrix-run.sh` +
   `npm run e2e:coverage-sweep` against the live env — that closes the
   verification gap I couldn't reach from here.
3. **Triage the migration re-runnability flag** — if `tenant_settings_us_region_check`
   can be violated by real prod data, `preDeployCommand` is at risk.
4. **Then decide on the unbuilt features** the QA report surfaced — backlog, not
   breakage: INV-04, INV-07, and the assistant intents.

The honest headline: the app's core is sound, **two real bugs are fixed and
verified**, and the codebase is genuinely *verified* — locally — for the first
time.

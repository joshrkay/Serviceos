# Rivet — Production Readiness Report

_Date: 2026-08-05 · **Supersedes** `docs/archive/2026-07-cleanup/root/GO-LIVE-READINESS.md` (2026-05-24) · Verified against `origin/main` @ `388063a6`._

Method: every claim was re-verified against current code, local test execution, or a live probe of the running Railway deployments — no status was inherited from prior docs. Nine remediation branches were produced (none pushed/merged; see Branch log). Verification agents' findings were independently re-run by the coordinator before acceptance.

## Verification baseline (executed locally, fresh clone)

| Check | Result |
|---|---|
| `npx tsc --project tsconfig.build.json --noEmit` (deploy tsconfig) | PASS |
| Root unit suite (`npm test`) | PASS |
| Integration suite (`npm run test:integration`, testcontainers/pgvector) | PASS |
| `npm run migrate:dryrun` | PASS (268 migrations valid) |
| Voice-quality corpus, launch gate enforced | PASS — 67/67 scripts, all 11 buckets ≥ thresholds |

## Live production probes (run 2026-08-05 from a machine that reaches Railway)

- prod + dev `/health` 200 (db ok, drain ok); prod `/ready` 200.
- `/metrics` → 401 (auth enforced; 503-if-unconfigured in prod by design).
- prod `/api/telephony/health`: `ok:true`, **all capabilities true** (mediaStreams, tts, stt, recording, messageDelivery, database, llmGateway) — i.e. Twilio, Deepgram, ElevenLabs, storage, email/SMS, DB and `AI_PROVIDER_API_KEY` are all present in prod. Only warning: `TWILIO_BUSINESS_NAME` unset (greeting says "our team").
- Boot-required secrets (`STRIPE_WEBHOOK_SECRET`, Clerk keys, `TENANT_ENCRYPTION_KEY`, `RLS_RUNTIME_ROLE`) proven present: `validateProductionConfig` fails boot without them and prod is serving.
- prod `/api/health/ai` providers `[]` = **zero AI requests since the 2026-08-03 deploy** (breaker cells are lazily created; dev shows a live OpenAI breaker with a success on 2026-08-05). Not mock mode — but see the observability finding below.
- **PostHog telemetry is dark**: events flowed only 2026-07-16 → 2026-07-28 (≤ 4 distinct tenants, QA-shaped bursts), nothing since. Server-side capture is a silent no-op without `POSTHOG_API_KEY`, which is absent from the prod contract. Combined with zero AI calls since Aug 3, production currently has **no observable product activity** — either there is (near-)zero tenant traffic, or analytics is unconfigured while traffic flows unseen. This is the single biggest open operational question (brief item B1).

## Original blockers 1–10 — all RESOLVED on current main

1. **Stripe/Clerk webhook idempotency in-memory** → RESOLVED. Durable `PgWebhookRepository` wired (`app.ts:1148,1192`); prod fail-fast if missing (`webhooks/routes.ts:245-251`); DB unique index `(source, idempotency_key)` (`schema.ts:275`).
2. **Transactions commit on error** → RESOLVED. Commit only when `statusCode < 400` (`tenant-context.ts:249`), rollback + `forceCommit` escape hatch tested.
3. **RLS not FORCEd (29 tables)** → RESOLVED. 119 ENABLE == 119 FORCE; exemptions locked to `oauth_states` + `platform_deprovision_log`; pinned by a static migration-text test and a live `pg_catalog` integration test.
4. **AssistantPage approve unauthenticated/silent** → RESOLVED. `apiFetch` + thrown errors + toast; pinned by test.
5. **In-process sweeps / non-graceful shutdown** → RESOLVED. `PROCESS_ROLE` worker split (`railway.worker.toml`), `pg_try_advisory_lock` leader election on a direct pool, all five sweeps gated; shutdown clears intervals, drains voice calls, closes pools. Minor residual: in-flight queue jobs are not awaited (SKIP LOCKED retry covers).
6. **recordPayment emits no audit** → RESOLVED. `payment.recorded`, `invoice.status_changed`, `payment.credit_rejected`; `auditRepo` passed at every live call site. (The dead un-audited `reconcilePayment` bypass is deleted on `chore/delete-dead-reconcile-payment`.)
7. **No double-booking backstop** → RESOLVED in code. Migration 131: `btree_gist` EXCLUDE constraint + sync triggers + assignment audit. **Caveat:** the migration self-skips with only a `RAISE WARNING` on legacy overlapping rows — brief item B2 confirms the constraint exists in prod.
8. **EstimateApprovalPage mock fallback** → RESOLVED. Error states + retry; `mock-data` module deleted; guard test covers the page.
9. **Conflicting deploy story** → RESOLVED. `experiments/`, `rewrite/`, `infra/`, `service-os-app/`, `service-os-agent/`, `supabase_migration.sql` all absent (D-016); Railway-only: `railway.toml` (web, runs migrations in preDeploy) + `railway.voice.toml` + `railway.worker.toml` + one multi-stage `Dockerfile` (Node pinned, runtime-only secrets, digest-pinned nginx). Quarantine intact — nothing to un-quarantine.
10. **CI build/tests/migrations** → RESOLVED. PR gate: deploy-tsconfig typecheck, web typecheck, lint, unit + mobile + real-Postgres integration, coverage thresholds (now blocking), migration-key guard, env-coverage guard, AI-gateway guard, voice-quality launch gate. Deploy gate: all of it + `migrate:dryrun`, then dev→prod with deployment-status waits, health polls and smoke tests; prod only after dev verifies. Only `continue-on-error`: two corpus data-quality steps with documented pre-existing findings (the PII guard blocks).

**IMPORTANT items:** transcripts AES-256-GCM encrypted, no plaintext retention without a key (key required in prod) — RESOLVED · TCPA/DNC consent gates enforced before any Twilio call, resolve to `block` in prod when unset — RESOLVED · `/metrics` auth — RESOLVED · DB health returns `down` so `/ready` 503s — RESOLVED.

## Money defects P0-1..P0-9 (`RIVET_MONEY_EXTRACTION_FINDINGS.md`, 2026-07-24)

Seven of nine were already fixed on main between 2026-07-24 and 2026-08-03 (commits `612ebd89`, `33c83f7f`, `cba4527f`, `0ffa1e01`, `7eb8cf89`, `8c27d910`, `bc5d48a0`, `d9fede06` + follow-ups); each was adversarially re-verified in current code and each ships regression tests that pin the defect **mechanism** (concurrency interleaves, post-void captures, the exact float-divergence rows) — not happy paths. The two partial items were completed this pass.

| P0 | Status | Notes |
|---|---|---|
| P0-1 void → live payment link | FIXED on main; **completed this pass** | Link deactivation + CAS column clear + audits already on main. Residual (minted PaymentIntent client secrets never cancelled — no `/cancel` call existed) closed on `fix/p0-1-payment-intent-cancel`: Stripe search by mint metadata, cancel on void/cancel in both platform+Connect scopes, terminal states skipped, audit on failure, void never blocked. Webhook unapplied-capture audit remains the backstop for Stripe's ~1 min search-index lag. |
| P0-2 client float totals persisted | FIXED | `normalizeLineItemTotals` on every REST create/update, both documents; pins 29×0.5, 45×0.7, 9×2.5. Residuals: legacy rows not renormalized (L1 sweep reports them as informational); web still float-previews (display-only). |
| P0-3 `void → paid` flip | FIXED | Status predicate inside the UPDATE; both crash-repair paths write through status-guarded `reconcileBalanceAtomic`; interleave-pinned incl. real Postgres. |
| P0-4 refund double-apply | FIXED | `payment_refunds` claim ledger (migration 264, FORCE RLS), claim+increment one statement; the exact re_1/re_2/retry interleave pinned unit + integration. Residual: unkeyed-refund payload fallback; only `refunds.data[0]` read (documented edge). |
| P0-5 `'stripe_checkout'` collision | FIXED | `session.id` → `event.id` fallbacks, both Stripe-unique; two intent-less checkouts both record. |
| P0-6 concurrent overpay | FIXED; **residual closed this pass** | Balance-cap predicate in SQL + loser compensation to `failed`/`credit_rejected` + audit; race-pinned on real Postgres. The last unguarded balance writer (`applyDepositCredit` read-modify-write) closed on `fix/deposit-credit-atomic` with `applyDepositCreditAtomic` (draft/open/partially_paid, cap, own-row derivation, compensation on rejection); lost-update interleave pinned failing-first. |
| P0-7 two refund conventions | FIXED | Both reconcilers refund-INCLUSIVE; defeating interleave (partial refund + crash repair) pinned. L3 is now well-defined and sweepable. |
| P0-8 unclaimed retry execution | FIXED | `claimForRetry` CAS on both entry paths; 3-way concurrent claim proven on real Postgres. |
| P0-9 stale-link capture discarded | FIXED for prevention+visibility; **test gap + consumer closed this pass** | All three branches audit `payment.unapplied_capture`; stale links killed on every credit, ordered before fallible side effects; mint CAS-guarded. `zero_balance` branch pinned on `fix/p0-9-zero-balance-test` (fails-without proven). The findings' "no sweep consumes the evidence" closed by `feat/money-reconciliation-sweep`. Remaining product decision: the excess still has no ledger home (audit-only — see Open items #1). |

**New invariant infrastructure** (`feat/money-reconciliation-sweep`): a read-only, leader-locked worker sweeping L2 (document arithmetic), L3 (refund-inclusive `amount_paid == Σ active payments`), L4 (`amount_paid ≤ total`), L5 (webhook `amount_total` vs recorded payments, nested-payload-aware, `'stripe_checkout'` refs classified unverifiable), L1 informational. Zero mutations (integration-proven); audits `money.reconciliation_violation` capped per tick; default 6 h, env-tunable. This is the findings doc's "single highest-value gate", implementable only after P0-5/P0-7 landed — both now hold.

## Feature verification — all seven advertised features WORK (with caveats)

Each feature was traced route→service→worker→UI with file:line evidence and its targeted suites executed; the voice verifier additionally **booted the API and drove a simulated inbound call** through both transports.

- **AI phone answering — WORKS.** Signed webhooks fail closed; realtime-stream ↔ Gather degrade paths return TwiML (never 5xx); proposals born `draft`; voice-quality launch gate 67/67; 1,367 voice/telephony tests green; prod capability probe live. The D-015 autonomous booking lane is the sole, deliberate auto-approve exception: per-tenant opt-in, booking-capture class only, ≥0.9 floor, platform kill switch; money/comms classes can never auto-approve. Caveats: `PUBLIC_API_URL` misconfig on the voice service is the likeliest field failure (403s every webhook); corpus doesn't prove disclosure timing (route-level TwiML provides it).
- **Quoting — WORKS.** REST + AI draft (catalog-grounded; uncatalogued prices confidence-capped 0.85 below auto-approve), token send, idempotent version-locked public approval with server-recomputed totals, deposit checkout → atomic job credit, idempotent conversion. 655 targeted tests green. Caveats: photo-analysis path in NewEstimateFlow is a canned demo (ship-or-cut decision); starter-catalog-on-API-error fixed on `fix/web-catalog-error-state`; view tokens stored raw at rest (hashed only in audit).
- **Invoicing — WORKS.** Full loop create→normalize→issue/send→Stripe link→signed webhook→recordPayment→status→receipt; prod refuses to boot without the Stripe key; remaining caveats are env provisioning, not code.
- **Payment chasing — WORKS.** Hourly leader-locked sweep → per-tenant dunning config → reminder/late-fee **proposals** (never auto-sent) → approved execution → consent-gated SMS/email → triple-guarded stop-on-payment. 198 tests green. Caveats: dunning config has no write surface (route/UI), so only the default 3/7/14-day cadence is reachable and late fees are effectively dead; step `channel` is metadata-only.
- **End-of-day digest — WORKS.** 15-min worker sweep, tenant-timezone due-matching with DST guards, UNIQUE(tenant,date) idempotency + dead-letter, SMS to owner + web DigestPage, one-tap links strictly proposal-first. Caveats: `digest_enabled` defaults false with no UI toggle (raw settings PATCH only); `ONE_TAP_APPROVE_SECRET` unset silently omits action links (now documented — `devops/declare-one-tap-secret`); a worker outage spanning a tenant's window skips that day.
- **Review monitoring — WORKS; self-serve completed this pass.** Poll (idempotent, backoff) → comms-class proposal (can never auto-approve; per-component opt-in) → approved → GBP reply + service credit; the old silent-resolver blocker is fixed with a boot-time wiring assertion. `feat/google-business-connect` adds the missing tenant connect flow (OAuth route pair reusing the calendar Google client, worker-readable credential shape, cache invalidation via NOTIFY) and 401→refresh→retry-once token refresh with visible backoff on refresh failure. Residual: no reputation list UI (reviews surface as inbox proposals); service credits are draft-time-cap only.
- **Customer portal — WORKS; distribution completed this pass.** Hashed tokens, timing-safe compare, TTL, GUC-scoped RLS, fail-closed entitlements, booking/cancel/reschedule as proposals, Stripe link/SetupIntent incl. Connect; 925 portal/route tests + RLS integration green. `feat/portal-link-send` adds mint + copy + consent-gated send from the customer surface (mint+send atomic because tokens are hash-only; session revoked if delivery fails so no live undelivered bearer credential) plus migration 269 widening the `message_dispatches` CHECK (integration-proven). Residual: no files/attachments surface in the portal.

## Branch log (all local on this machine, none pushed — user reviews and merges)

Suggested merge order: rows 1–6 are independent; 7–9 touch env/docs files with possible trivial adjacent-line conflicts.

| # | Branch | Commit(s) | What it does | Verification (re-run independently by coordinator) |
|---|---|---|---|---|
| 1 | `fix/p0-9-zero-balance-test` | `e47a8114` | Pins the untested `zero_balance` unapplied-capture audit branch | fails-without proven; 16/16; tsc clean |
| 2 | `fix/p0-1-payment-intent-cancel` | `8d154baa` | Cancels minted PaymentIntents on invoice void/cancel | TDD 6-red→green; tsc + 492 invoice/payment tests |
| 3 | `fix/deposit-credit-atomic` | `852c6afe` | Deposit credit → atomic guarded increment (lost-update + guard bypass) | TDD red (lost update shown); 356 unit + real-PG integration |
| 4 | `chore/delete-dead-reconcile-payment` | `a9135c64` | Deletes dead un-audited `reconcilePayment`; fixes stale refund-idempotency comment | deadness grep-proven; 275 tests |
| 5 | `fix/web-catalog-error-state` | `f13ccee9` | Error state (not starter prices) on catalog fetch failure; deletes latent fake-success branches | failing-first; full web suite 1,905 |
| 6 | `feat/money-reconciliation-sweep` | `9b05e901` | Read-only scheduled L2–L5 money-invariant sweep, leader-locked | 19 unit + 8 real-PG integration (incl. mutates-nothing) |
| 7 | `feat/portal-link-send` | `4fff66a0` + `b3d246ac` | Portal link mint + consent-gated send + migration 269 (coordinator-authored) | 1,218 API + 1,907 web tests; migration integration test 2/2 |
| 8 | `feat/google-business-connect` | `3962c1f9` | GBP OAuth connect route pair + web sheet + token refresh w/ visible backoff | 1,074 API + 1,908 web tests; env-coverage OK |
| 9 | `devops/declare-one-tap-secret` | `632835b3` | Declares `ONE_TAP_APPROVE_SECRET` in the prod contract + checklist | env-coverage guard OK |

## Verification brief — items requiring Railway dashboard / prod DB access

See `docs/verification-runs/live-deploy-verification-2026-08-05.md` (coworker-brief shape). Summary:

- **B1 (go/no-go swing item):** determine why production shows no observable activity — check `POSTHOG_API_KEY` + `SENTRY_DSN` on prod services and scan Railway logs for organic traffic since 2026-07-28. Real tenants + dark observability = ops flying blind; no traffic = the "live with real tenants" premise needs a product-side look.
- **B2:** confirm the `no_double_booking` constraint exists in prod `pg_constraint` (migration 131 self-skips on legacy overlaps).
- **B3:** confirm `ONE_TAP_APPROVE_SECRET` is set on prod (else digest one-tap links are silently omitted).
- **B4:** after merging, deploy via CI and re-run the live probes; confirm `/api/health/ai` providers non-empty after the first AI call.
- **B5 (optional):** run the qa-matrix E2E against dev per `qa/README.md`.

## Open items NOT addressed this pass (deliberate — need product/operator decisions)

1. Unapplied-capture excess has no ledger home (no credit-balance concept) — the money now leaves an audit trail and the sweep alerts on it, but it still can't be applied or refunded in-product. (Findings Open Decision #1/#2.)
2. Refund write-back stays refund-inclusive: a fully-refunded invoice still reads `paid`. Settled convention (both reconcilers agree; sweep encodes it), but "what do we owe back" has no report.
3. Dunning-config write surface and digest-enable UI — features run on defaults until built.
4. NewEstimateFlow photo-analysis demo path — ship-or-cut.
5. int4 money columns cap documents at $21,474,836.47; discount not split proportionally across mixed taxability (under-taxes); `taxExempt` is a phantom flag. All documented in the findings, unchanged.
6. View tokens raw at rest (hash-at-rest would be a hardening follow-up).
7. E2E real-Clerk journeys self-skip in CI without `E2E_CLERK_SECRET_KEY` (loud warning, known).

## Go / no-go

**GO — conditional on merging the nine branches and closing brief items B1–B3.** The codebase is materially production-grade: every 2026-05 blocker is resolved and re-verified against current main, all nine silent money defects are fixed with regression tests that pin the defect mechanisms (seven were fixed on main by prior work and re-proven here; the last two legs were closed this pass), all seven advertised features demonstrably work end-to-end — the voice path was proven by actually driving a call — and the deploy pipeline (Railway three-service topology, migration discipline, CI gates, post-deploy verification) is coherent and live-probed healthy with every provider key present in prod. What keeps this conditional is not code but operations: production currently shows zero telemetry and zero AI traffic, and until B1 resolves whether that means "no traffic" or "unobserved traffic", the team cannot see the product it is running — merge the branches, set the two missing observability keys, run the three dashboard checks, and this is an unconditional go.

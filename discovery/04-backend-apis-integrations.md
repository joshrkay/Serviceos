# 04 — Track 4: Backend, APIs & Integrations

Date: 2026-07-18 · Read-only discovery · Evidence verified against HEAD `a9d06aa`
See `discovery/00-cartography.md` for orientation. Annex A/B summarize the route-validation and observability/config sweeps that fed this track.

## Summary

The backend is substantially more hardened than a typical seed-stage codebase: all five inbound webhook families (Stripe, Clerk, Twilio, SendGrid, Vapi) verify signatures with timing-safe compares, replay windows, and durable Postgres-backed idempotency that fails fast if missing in prod; public token surfaces use ≥192-bit tokens with expiry, enumeration-opaque responses, and honeypots; the PgQueue is genuinely at-least-once with exponential backoff, a real DLQ, and a crash-orphan reaper; money paths are integer-cents throughout with Stripe idempotency keys and an ACH processing→settle→reverse lifecycle. The weakest seams are: (1) a family of mark-**after**-send SMS/email sweeps whose only crash backstop is an **unverified** Twilio `Idempotency-Key` header — a live duplicate-SMS window; (2) a prod per-IP rate limit of 100 req/15min on `/api` and 30/min on `/webhooks` that will throttle legitimate office-NAT users and Twilio callbacks well before 1,000 concurrent sessions; (3) observability gaps — the global error handler never reaches Sentry, and the per-request correlation ID is never threaded into queue payloads or worker logs, so tracing one customer call across voice→API→worker is not possible today; (4) authz/validation stragglers (`proposals.ts` POST with no `requirePermission` and `payload: any`; `appointments.ts` PUT mass-assignment); (5) boot-time config validation misses `TENANT_ENCRYPTION_KEY`/`TRANSCRIPT_ENCRYPTION_KEY`, deferring failure to first use. Scale posture (PgBouncer transaction mode, request-scoped transactions with statement/idle timeouts, SSE/LLM bypass allowlists, Redis fail-open-to-local everywhere) is thoughtfully engineered, with one residual hazard: `/api` handlers that await Twilio/SendGrid HTTP inline while holding a pooled transaction.

## What exists (inventory)

| Subsystem | Maturity | Evidence |
|---|---|---|
| Inbound webhooks (Stripe/Clerk/Twilio/SendGrid/Vapi) | **Hardened** | `webhooks/routes.ts` — svix 5-min replay window (:263-279), raw-body HMAC with `timingSafeEqual` (:301-303), Stripe sig verify (:884), per-tenant Twilio token + AccountSid check (:2210-2223), per-tenant Vapi secret fail-closed (:2343-2361), SendGrid ECDSA (:2404); durable dedup via `pg-webhook.ts:52` `ON CONFLICT (source, idempotency_key) DO NOTHING`; prod boot throws without durable repo (`routes.ts:219-225`); in-flight staleness classifier (`webhook-handler.ts:88-110`) |
| Public token surfaces (`/e/`, `/pay/`, portal, one-tap) | **Hardened** | portal: `randomBytes(32)` hex + shape pre-check + bounded token bucket (`portal/portal-token-middleware.ts:110-128,148`); view tokens `randomBytes(24)` + 90-day expiry (`notifications/send-service.ts:557-562`); one-tap: HMAC + 16-byte nonce + 30-min TTL, durable single-use nonce via `webhook_events` (`proposals/auto-approve.ts:272`, `app.ts:1567`); public payments amounts server-side only, opaque 404s (`routes/public-payments.ts:70-105`) |
| PgQueue + workers | **Working→Hardened** | `queues/pg-queue.ts` — `FOR UPDATE SKIP LOCKED` claim with `2^attempts` backoff capped 900s (:116-130), DLQ (:216-250), crash-orphan reaper (:132-179); leader election via session advisory locks on the direct pool (`app.ts:2299-2332`); depth + staleness sampled to prom + SLO monitor pages on any job >15min old (`workers/slo-monitor.ts`) |
| Billing/payments | **Working→Hardened** | integer cents, `Math.round` only at qty/bps boundaries (`shared/billing-engine.ts:79,90`); Stripe `Idempotency-Key` on PI/terminal/saved-card (`payments/stripe-payment-intent.ts:99`); ACH lifecycle + NSF reversal + overpayment capping (`webhooks/routes.ts:1221-1294,1150-1205`); atomic deposit credit (:1091); subscription mirror under `SELECT…FOR UPDATE` |
| Tenant transaction / scale plumbing | **Hardened** (one hazard, T4-F09) | `middleware/tenant-context.ts` — SET LOCAL, commit<400/rollback, statement 30s + idle-in-tx 60s timeouts (:95-96,176-179), SSE/LLM bypass allowlists (:71-118), after-commit hooks; PgBouncer txn mode `default_pool_size=25` + two-DSN split (`deploy/pgbouncer/pgbouncer.ini`) |
| Rate limiting | **Working** (mis-tuned, T4-F02/F05) | Redis-backed cluster-wide stores with atomic Lua INCR, fail-open-to-local (`middleware/rate-limit-store.ts`); layered per-IP + per-tenant limiters (`app.ts:839-860,4373-4384`) |
| Redis dependency | **Hardened** | every consumer (rate limit, WS cap, LLM quota, cache) falls back to in-memory; boot never stalls; error listener prevents crash (`redis/redis-client.ts:24-75`) |
| Route validation/authz | **Working** (gaps, T4-F04/F07/F08) | ~48/69 route files validated via Zod (often through `shared/contracts.ts` — absence of a zod import ≠ unvalidated, e.g. `routes/payments.ts:49`); `requirePermission` middleware exists and is used on money routes (`routes/payments.ts:43-47`) |
| Observability | **Prototype→Working** (T4-F03/F06) | structured redacting logger, prom-client pool/queue gauges, SLO monitor; but no Sentry in the global error handler, no correlation-ID propagation, ~41 stray `console.*` |

## Findings

**T4-F01 | Duplicate-SMS window: mark-after-send sweeps backstopped by an unverified Twilio idempotency header | Fix | High | Effort M | Confidence High**
- Evidence: `workers/thank-you-sms-worker.ts:245-249` (`dispatcher.send(...)` then `jobRepo.update({thankYouSmsSentAt})`, no idempotency key on send); `estimates/estimate-nudge.ts:45-56` (send, then `reminderCount+1`); `notifications/customer-message-delivery.ts:49-62` (dispatch row written **after** `sendSms` inside a fully swallowed `catch {}`); load-bearing backstop `notifications/twilio-delivery-provider.ts:180-183` — "Twilio accepts an Idempotency-Key header" is not documented for `Messages.json` and is unverified in-repo (`delivery-provider.ts:46` hedges "provider *should* dedupe").
- What & why: a crash/restart between provider send and DB stamp re-sends customer SMS on the next sweep tick; SendService's minute-quantized key (`send-service.ts:368-380`) doesn't cover cross-tick retries. Contrast the correct claim-before-send pattern already in the codebase (`notifications/lifecycle-email.ts:52-110`, `appointment-reminder-worker.ts:130-147`).
- Plan: convert Class-B senders to the existing claim/release ledger pattern; empirically verify or stop relying on the Twilio header.

**T4-F02 | Prod `/api` per-IP limit of 100 req/15min will throttle legitimate offices | Fix | High | Effort S | Confidence High**
- Evidence: `app.ts:839-848` — `max: isDev ? 10000 : 100` per IP per 15 min, cluster-wide via Redis store; `trust proxy` set (`app.ts:755`) so an office NAT collapses to one key.
- What & why: ~0.11 req/s shared across every dispatcher/tech behind one shop IP; an active SPA dashboard exceeds this in minutes → 429s that look like an outage. The per-tenant fairness limiter (1000/min, `app.ts:4372-4384`) is the right control; the per-IP one is 150× tighter.
- Plan: raise per-IP cap to DoS-guard territory (e.g. 1-2k/15min) and lean on the per-tenant limiter.

**T4-F03 | HTTP 500s never reach Sentry; correlation ID dies at the queue boundary | Fix | High | Effort M | Confidence High (spot-checked)**
- Evidence: global error handler `app.ts:6538-6561` calls only `recordApiError` (PostHog) — no `captureException`; `app.ts:6535 captureRequestError()` merely stashes the error on `res.locals` (`middleware/request-logging.ts:96-101`). Correlation ID generated per request but never threaded into `queue.send` payloads, worker logs, or voice sessions; only ~4 hand-instrumented paths reach Sentry; no `http_request_duration` metric.
- What & why: an operator diagnosing a prod incident gets queue-depth gauges and an SLO pager but cannot trace one customer's call voice→API→worker, and unhandled route errors are invisible in Sentry.
- Plan: `Sentry.captureException` in the global handler; stamp `correlationId` into `toEnvelopeMeta`/`processMessage` child logger (the seam already exists at `queues/queue.ts:296-301`).

**T4-F04 | `POST /api/proposals` lacks `requirePermission` and takes `payload: any` | Fix | High | Effort S | Confidence High (spot-checked)**
- Evidence: `routes/proposals.ts:97-110` — only `requireAuth, requireTenant`; `const body = req.body as { … payload?: any … }` with a hand-rolled type allowlist, no Zod despite CLAUDE.md's "all proposals: typed payloads validated by Zod contracts." Sibling `GET /` and `GET /inbox` both require `proposals:view`.
- What & why: any authenticated tenant user (any role) can mint scheduling proposals with unvalidated payloads that flow into execution handlers. The human-approval gate bounds blast radius but the payload contract is unenforced at the door.
- Plan: add `requirePermission` + the existing Zod proposal contracts from `shared/contracts.ts`.

**T4-F05 | `/webhooks` limited to 30 req/min per IP — Twilio/Stripe callbacks will 429 at scale | Fix | High | Effort S | Confidence Medium**
- Evidence: `app.ts:849-853`. Twilio egresses from a bounded IP pool; at hundreds of concurrent calls/SMS the per-IP status/inbound callback rate exceeds 30/min → 429. Twilio does not reliably retry all callback types; a dropped inbound-SMS webhook is a silently lost customer reply.
- Plan: exempt or greatly raise signature-verified provider paths; rate-limit by tenant after verification instead.

**T4-F06 | Encryption keys and second config validator missing from boot validation | Fix | High | Effort S | Confidence Medium**
- Evidence: `TENANT_ENCRYPTION_KEY` + `TRANSCRIPT_ENCRYPTION_KEY` absent from both the `shared/config.ts` schema and `.env.production.example`; integrations throw at first use (`integrations/credentials.ts:111-112`), not boot. Two divergent validators disagree on `STRIPE_API_KEY` vs `STRIPE_SECRET_KEY` (`config.ts:41` vs `:448`).
- What & why: a fat-fingered deploy passes health checks, then 500s the first time a tenant's credentials are decrypted — the exact failure mode boot validation exists to prevent.
- Plan: fold both keys into `validateEnvSchema`, reconcile the two validators, sync `.env.production.example`.

**T4-F07 | `PUT /api/appointments/:id` mass-assignment | Fix | Medium-High | Effort S | Confidence High (spot-checked)**
- Evidence: `routes/appointments.ts:322` — `const updates = { ...req.body }` spread straight into `updateAppointment`, only date fields coerced. Same shape (presence-check-only) on `estimates.ts:725`, `invoices.ts:551`, `jobs.ts:583` status updates.
- Plan: Zod `.strict()` update schemas; repo-layer column allowlists as backstop.

**T4-F08 | External-I/O proposal handlers: partial completion depends on per-handler self-guarding | Fix | Medium | Effort M | Confidence High**
- Evidence: `proposals/execution/executor.ts:295-318` — for `performsExternalIo` handlers the side effect commits before the idempotency marker/status tx; `resetStaleExecuting` (`pg-proposal.ts:521-548`) re-queues the proposal, so a non-self-guarding handler repeats the effect. `apply-late-fee-handler.ts:100-103` shows the correct self-guard; no audit exists proving every external-I/O handler has one. DB-only handlers are fully atomic (executor.ts:269-293) — that path is solid.
- Plan: enumerate `performsExternalIo` handlers and add/pin self-guards with tests.

**T4-F09 | `/api` handlers await Twilio/SendGrid HTTP inside the request transaction | Fix | Medium | Effort M | Confidence High**
- Evidence: `routes/estimates.ts:861` → `SendService.sendEstimate` awaits `delivery.sendSms/sendEmail` (`send-service.ts:443-453`) while `withTenantTransaction` holds a PgBouncer backend; only `/assistant/chat` + SSE are exempted (`tenant-context.ts:71-118`). With `default_pool_size=25`, ~25 concurrent slow sends stall all of `/api`; the 60s idle-in-tx timeout bounds but does not prevent it. Also: a post-send handler error rolls back the dispatch/status rows for an SMS that already left.
- Plan: add send routes to the bypass list or move delivery to the queue (pattern exists).

**T4-F10 | DLQ rows lose the real failure reason | Fix | Medium | Effort S | Confidence High**
- Evidence: `queues/queue.ts:315-327` swallows the handler exception (logs only, returns false); `app.ts:2674` then writes the literal `'max attempts exceeded'` into `_queue_dlq.error`. Triage of poison messages requires payload archaeology.
- Plan: persist last-error text on the message row at failure time; copy into DLQ.

**T4-F11 | SendGrid webhook events recorded then discarded — no bounce/complaint suppression | Gap | Medium | Effort M | Confidence High**
- Evidence: `webhooks/routes.ts:2419-2423` — receipt recorded and immediately `markProcessed`; no consumer of stored SendGrid events found. Also dedupes an entire event **batch** on `first?.sg_event_id` (:2417-2418), dropping sibling events in the array.
- What & why: hard-bounced/complaining addresses keep receiving invoices and reminders — sender-reputation and CAN-SPAM exposure.
- Plan: process the event array; maintain a suppression list checked by SendService.

**T4-F12 | Silent catches on audit/mutation paths and missing route-level idempotency on charge-adjacent endpoints | Fix | Medium | Effort M | Confidence Medium**
- Evidence: empty `catch {}` on audit write `routes/invoices.ts:260`; no route-level idempotency on `terminal.ts:171` and `calls.ts:67` (`initiateOutboundCall`). Mitigation verified: `stripe-terminal.ts:261` and `stripe-payment-intent.ts:99` do send deterministic Stripe `Idempotency-Key`s, so double-charge risk is provider-deduped; double *call* initiation is not.
- Plan: idempotency keys on double-click-prone POSTs; never silently swallow audit failures on money paths.

**T4-F13 | DB TLS `rejectUnauthorized: false` on both pools | Fix | Medium | Effort S | Confidence High**
- Evidence: `db/pool.ts:13,27,62` — certificate validation disabled for every Postgres connection in prod. (Cross-referenced with T5-F08.)
- Plan: pin the provider CA (Railway supplies one) via `DB_SSL_CA`.

**T4-F14 | Redis boot-blip permanently degrades cluster-wide rate limiting until restart | Fix | Low-Medium | Effort S | Confidence High**
- Evidence: `middleware/rate-limit-store.ts:35-46` memoizes a `null` shared client if the first connect fails (`redis-client.ts:70-74` returns null, no reconnect); limiters then run per-replica forever (N× the intended cap).
- Plan: retry/refresh the memoized client on a timer.

**T4-F15 | Hygiene: no sweep jitter; ~41 `console.*` bypass the redacting logger; `PROCESS_ROLE` defaults `'all'` | Refactor | Low | Effort S | Confidence High**
- Evidence: no jitter on the ~25 sweep intervals (leader locks make it a thundering-herd nit, not correctness); `console.*` count verified (41 in src excluding tests, incl. PII-adjacent `portal-token-middleware.ts:142`); `shared/config.ts:78` default `'all'` means an unset dashboard var silently runs all workers in a web replica — safe only because of the advisory locks.

## Annex A — Route validation/authz sweep (summary)

69 route files; 208 mutation routes across 61 files. Validation coverage ≈48/69 files via `schema.parse` (112 call sites), mostly pre-built schemas from `shared/contracts`; only 5 raw `req.body` destructures, all with presence checks. RBAC: `requireRole`/`requirePermission`/`requirePlatformAdmin` used at 294 sites across 48 files; `resolveAuthorization` (`middleware/auth.ts:176`) reloads the DB-authoritative role per request and fails closed (503) — strong. Central `asyncRoute` + `toErrorResponse` (`shared/errors.ts`); Express 4 (no auto-catch), but no unwrapped async mutation handler was found in sampling. Error shape `{error, message}` standardized; `proposals.ts` diverges (bare `{error}` + ad-hoc fields; 200-on-create instead of 201). Swallowed best-effort paths (all logged except two empty `catch {}`): `invoices.ts:237-263` deposit-credit continue + silent audit catch at `:260`; `estimates.ts:704-709`; `reports.ts:125`; `one-tap-approve.ts:171`. Worst unvalidated mutations: `appointments.ts:322` (mass-assign), `proposals.ts:102` (`payload: any`, no permission gate), `estimates.ts:725` / `invoices.ts:551` / `jobs.ts:583` (status presence-check only).

## Annex B — Observability & config sweep (summary)

Logging: structured JSON with layered redaction (`logging/redact.ts` key-based secrets at all tiers; PII masking only at `strict` tier — default app logs do NOT mask phones/emails in meta; Sentry uses `strict`); second richer engine in `logging/redaction/` for sink-specific scrubbing incl. transcript email/phone regexes. ~41 `console.*` calls bypass it. Correlation: `middleware/request-logging.ts:44-94` mints/echoes `x-correlation-id`, but no AsyncLocalStorage carry — enqueued payloads (unless a producer manually sets it), `execution-worker.ts` and `voice-action-router.ts:1804` child logs have no correlationId; tracing one call voice→API→worker is not reliably possible (biggest gap). Metrics: single prom Registry (`monitoring/metrics.ts`) with LLM latency/cost, queue depth, pool, voice-turn latency, WS, SLO gauges; **no** `http_request_duration` histogram, no worker tick durations; `/metrics` token-gated fail-closed (503 in prod when unset — `bootstrap/metrics-auth.ts:41-49`). Sentry: DSN-gated no-op client, strict-redaction processors asserted at init (`sentry.ts:89-93`), but only 4 instrumented paths call `captureException` (WS upgrade, voice-action-router, execution sweep, Stripe webhook); `uncaughtException` logs FATAL without Sentry capture; `unhandledRejection` warns and continues. `src/telemetry/` is technician GPS pings, not observability. PostHog off-by-default, IDs/enums-only. Config: two divergent validators (`configSchema` vs `validateEnvSchema`); top gaps: `TENANT_ENCRYPTION_KEY`/`TRANSCRIPT_ENCRYPTION_KEY` (nowhere, first-use throw), `ONE_TAP_APPROVE_SECRET` dev-fallback + absent from prod example, `WEBHOOK_SIGNING_SECRET` optional yet PIN-HMAC fallback, provider keys (`DEEPGRAM_API_KEY`, `ELEVENLABS_API_KEY`, `VAPI_API_KEY`, `GOOGLE_OAUTH_CLIENT_SECRET`, `QUICKBOOKS_CLIENT_SECRET`, …) read raw and unvalidated; `NODE_ENV` defaults `'dev'` so prod refinements depend on it being set; `WEB_URL`/one-tap base default to `http://localhost:3000` (mis-set prod would mint localhost approve links); TCPA default `'off'` fixed up imperatively to `'block'` in prod only when undefined. `.env.production.example` omits ~12 live secrets; `packages/api/.env.example` is 3 lines. Redis: central factory fails open cleanly (null client, in-memory fallbacks, bounded timeouts, pre-connect error listener); rate limiting degrades to per-replica MemoryStore (never unlimited, never 500); `REDIS_URL` hard-required only when `NUM_REPLICAS>1`.

## Could not verify

- Whether Twilio honors `Idempotency-Key` on `Messages.json` (load-bearing for T4-F01) — no in-repo test or provider-contract evidence.
- Exact prod values of `DB_MAX_CONNECTIONS`, `API_TENANT_RATE_LIMIT_MAX`, `PROCESS_ROLE` per Railway service — dashboard variables, not in `railway*.toml`.
- Runtime behavior of the RLS policies themselves (Track 5's scope; reviewed only incidentally here).
- Whether Grafana/Prometheus alerting is configured externally (SLO monitor's histogram rule is documented as Prometheus-only under a split `PROCESS_ROLE`, `workers/slo-monitor.ts:302-317`).

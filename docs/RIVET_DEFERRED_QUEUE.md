# Rivet Deferred Queue (shipgate Class C)

Findings from the 2026-07-24 shipgate audit that are **real but not
App-Review-visible**, deferred by triage discipline (fix after submission).
Each entry carries the evidence needed to pick it up cold. Source evidence:
five parallel discovery tracks (mobile, backend, voice, data, submission);
class arbitration recorded in the shipgate session.

## C-1 — Unmatched `/api/*` GETs return 200 + SPA HTML shell (downgraded from A)
`packages/api/src/app.ts:6728` catch-all. With `web/dist` present (production
layout), an authenticated GET to a nonexistent `/api/...` route returns
`200 text/html` (the SPA shell). Mobile hooks do `if (!res.ok) throw` →
`res.json()` → SyntaxError → "Unknown error" states. Reproduced live.
Triggers only on version skew or removed routes — absent under review
conditions. **Fix:** JSON 404 middleware for `/api/*` mounted before the SPA
catch-all.

## C-2 — Three Stripe modules lack request timeouts (downgraded from A)
`stripe-payment-intent.ts:105`, `stripe-saved-card.ts` (4 calls),
`stripe-terminal.ts` (4 calls) — no `AbortSignal` on fetches to
api.stripe.com; a stalled Stripe upstream pins the request indefinitely.
Sibling `stripe-payment-link.ts:54` already has the pattern
(`AbortSignal.timeout(STRIPE_REQUEST_TIMEOUT_MS)` + comment). **Fix:**
propagate the same guard; three mechanical single-file patches.

## C-3 — Dispatch presence routes lack asyncRoute wrapper
`dispatch/presence-routes.ts:33-66,73-83` — async Express 4 handlers with no
try/catch; a throw hangs the request. Dominant failure path (Redis) already
fails open one layer down, so not currently reproducible as a live hang.
**Fix:** wrap both with the existing `asyncRoute` helper.

## C-4 — No max wall-clock cap on voice calls (unbounded per-call spend)
`mediastream-adapter.ts:1224` re-arms the 30-min idle timer on every media
frame (Twilio sends continuous comfort noise), so it never fires during a
live call; no TwiML `timeLimit`; only silent-caller turns are capped. A
looping/engaged caller bills Deepgram+LLM+ElevenLabs+Twilio indefinitely.
**Fix:** absolute per-call timer armed once at session start →
`handleClose('max_call_duration')` with a spoken wrap-up.

## C-5 — Transcript permanently lost when session is gone at recording-webhook time
`app.ts:3823-3831` silently returns when `findByCallSid` misses — every
deploy/restart/30-min reap drops live calls' transcripts. Audio survives in
S3 but is never re-transcribed; the ingestion worker only reads the
in-memory transcript. **Fix:** persist turns incrementally during the call,
or add a re-transcribe-from-S3 fallback in `onPersisted`.

## C-6 — No LLM cross-provider failover in default config
`ai/gateway/factory.ts:187` — `fallbackProviders` is empty unless
`AI_FALLBACK_PROVIDER_*` env vars are set (staged-rollout default OFF), so
breaker-open/provider-hang dead-ends the turn at `LLM_PROVIDER_UNAVAILABLE`.
Known-tracked as FM-03. **Fix:** ops config — enable the OpenRouter
Profile B fallback; code path already wired.

## C-7 — `launch-quality-check.ts` H3 references a moved file
The checker greps `src/payments/stripe-webhook-handler.ts`, which no longer
exists (webhooks consolidated). H3 fails with ENOENT rather than a real
finding; H5's capacity ack is also stale (>30 days). **Fix:** update the H3
wrap list to the current file paths; re-run the voice capacity check and
refresh `.launch-quality-acks.json`.

## C-8 — `app.system_lookup` GUC audit
The cross-tenant escape hatch unlocks reads on 5 tables at once
(tenant_integrations, accounting_integrations, device_tokens,
notification_preferences, + portal_sessions via its own GUC). Schema-correct
and tested; unverified that every set-site uses `SET LOCAL` in a short
single-purpose transaction. **Fix:** audit set-sites in `app.ts`
(resolveTenantIdByPhoneNumber, resolveTwilioAuthTokenForSubaccount,
device-token cleanup).

## C-9 — `estimates` lacks a general `(tenant_id, status)` index
Only a partial index `WHERE status='accepted'` exists; jobs/invoices/
proposals all have the general composite. No confirmed slow query — flag
only if an estimate-list-by-status endpoint appears.

## C-10 — Soft-deleted users previously visible in reads (FIXED in shipgate PR)
Historical note: repository reads didn't filter `deleted_at`; fixed alongside
A-3 (in-app deletion). Kept here so the behavior change is discoverable.

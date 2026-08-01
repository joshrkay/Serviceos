---
title: "Click-to-call gate required a global TWILIO_ACCOUNT_SID, disabling the per-tenant prod path"
date: 2026-06-20
track: bug
problem_type: logic-errors
module: "packages/api/src/app.ts, packages/api/src/integrations/credentials.ts, packages/api/src/telephony/outbound-call-service.ts"
tags: ["telephony", "click-to-call", "twilio", "per-tenant", "feature-gate", "fail-closed", "config", "503", "deploy-verification"]
related: ["docs/solutions/logic-errors/escalation-per-user-phone-fallback-loop.md"]
---

## Problem
The owner→customer click-to-call route (`POST /api/calls`) was wired only
when a **global** `TWILIO_ACCOUNT_SID` was set in production. But the
canonical multi-tenant model resolves Twilio credentials *per tenant* from
`tenant_integrations` and frequently runs with no global SID — so on that
(canonical) path `callDeps` was `undefined` and every call 503'd before
per-tenant resolution ever ran. Click-to-call was dark for the whole
deployment.

## Symptoms
- `POST /api/calls` returns `503 { error: 'UNAVAILABLE', message: 'Calling is not configured' }`
  for every tenant in a prod deployment that uses per-tenant
  `tenant_integrations` and has no global `TWILIO_ACCOUNT_SID`.
- `GET /api/telephony/health` still reports `ok: true` (the `ok` flag does
  not cover this gate), masking the outage.

## What Didn't Work
Using a global credential as a proxy for "is the feature configured?":

```ts
const callDeps =
  pool &&
  process.env.PUBLIC_API_URL &&
  (process.env.TWILIO_ACCOUNT_SID || process.env.NODE_ENV !== 'production')
    ? { /* ...deps... */ }
    : undefined;
```

The `TWILIO_ACCOUNT_SID` term assumes a single global Twilio account. In a
per-tenant deployment that env var is legitimately absent (each tenant
brings its own subaccount), so the gate was false even though every
prerequisite for serving the request was actually present.

## Solution
Gate only on the **structural** prerequisites the composition root truly
needs — a DB pool (for repos + per-tenant cred lookup) and `PUBLIC_API_URL`
(the host Twilio calls back for the bridge TwiML). Let credential
availability be decided per tenant, at call time, by the resolver:

```ts
const callDeps =
  pool && process.env.PUBLIC_API_URL
    ? { /* ...deps..., getCreds: (tid) => getTenantTwilioCreds(tid, pool) */ }
    : undefined;
```

`getTenantTwilioCreds` already **fails closed** per tenant: it throws for a
tenant with no active integration, which `initiateOutboundCall` maps to
`OutboundCallError('not_configured')` → HTTP `503` — and never reaches
Twilio. So a genuinely unconfigured tenant still gets a clean 503; the
difference is the feature is no longer globally disabled for tenants that
*are* configured.

## Why This Works
Two independent questions were conflated: "can this process serve the route
at all?" (structural: pool + callback host) versus "does *this tenant* have
working credentials?" (per-tenant, dynamic). The global-SID check answered
the second question with a global, static signal that is wrong under the
per-tenant model. Splitting them puts each decision where its data lives —
wiring uses structural facts; the per-tenant resolver owns credential
presence and fails closed on its own.

## Prevention
- **Never gate a per-tenant capability on a global credential.** When
  credentials are resolved per tenant (the project default — see CLAUDE.md
  "per-tenant Twilio via tenant_integrations, failing closed"), the
  feature gate should check only what the composition root needs; the
  per-tenant resolver decides availability and must fail closed.
- **Pin the fail-closed path with a unit test** (added):
  `getCreds` rejecting → `not_configured`, fetch never called
  (`packages/api/test/telephony/outbound-call-service.test.ts`).
- **Verify deploy config with the right probe.** `GET /api/telephony/health`'s
  `ok` flag is `(!mediaStreams || (stt && tts)) && database && llmGateway` —
  it treats a missing message-delivery provider or an unset
  `PUBLIC_API_URL` as a *warning only*, so it stays `true` while SMS/calls
  are broken. Use `npm run verify:telephony -- --base=<url>` (added in this
  PR), which asserts the actual SMS/call gates — `messageDelivery`,
  `config.publicBaseUrl`, `database` — and exits non-zero with the missing
  vars named. `smoke-test`'s telephony probe is not sufficient for this.

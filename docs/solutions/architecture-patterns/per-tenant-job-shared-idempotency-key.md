---
title: "Per-tenant side-effecting jobs must share one canonical idempotency key"
date: 2026-06-14
track: knowledge
problem_type: architecture-patterns
module: "packages/api/src/routes/onboarding.ts, packages/api/src/webhooks/routes.ts, packages/api/src/workers/provision-twilio.ts"
tags: ["queue", "idempotency", "concurrency", "twilio", "provisioning", "race-condition"]
related: ["docs/solutions/architecture-patterns/voice-appointment-paths-vapi-vs-twilio-gather.md"]
---

## Context
A background job that has **external, paid, hard-to-reverse** side effects
(creating a Twilio subaccount, buying a DID) can be enqueued from multiple
triggers. Twilio provisioning has three: the signup auto-provision
(`webhooks/routes.ts`), the retry route, and the new "claim a chosen number"
route (`routes/onboarding.ts`). The queue dedupes on
`ON CONFLICT (idempotency_key) DO NOTHING`.

## Guidance
Use **one canonical idempotency key per tenant** (`provision-twilio-${tenantId}`)
across every enqueue site for the same per-tenant job. The "claim" route was
first written with a distinct key (`provision-twilio-claim-${tenantId}`); because
that didn't collide with the in-flight signup job's key, the queue ran **both** —
two subaccounts, two purchased numbers, double billing. Sharing the key lets the
queue collapse a concurrent claim into the already-pending job.

```ts
// dangerous: distinct keys never dedupe against each other
await queue.send(JOB, payload, `provision-twilio-claim-${tenantId}`);
// safe: collapses into a pending/in-flight auto-provision
await queue.send(JOB, payload, `provision-twilio-${tenantId}`);
```

## Why This Matters
Distinct keys for the same logical per-tenant work silently defeat the queue's
only concurrency guard and duplicate paid external resources. The cost is real
money and orphaned provider state, not just a stray row.

## When to Apply
Whenever you add a **new** enqueue site for an existing per-tenant job that
creates/buys external resources. Reuse the existing key; don't invent a
trigger-specific suffix.

## Examples / residual
- Auto-provision: `webhooks/routes.ts` → `provision-twilio-${tenantId}`.
- Claim: `routes/onboarding.ts` (`POST /phone/claim`) now reuses the same key.
- **Residual race (not fully closed):** queue dedup only collapses while the job
  row is still *pending*. A claim landing after the worker picks the job up but
  before it persists `subaccount_sid` is not deduped. Fully closing it needs
  worker-level per-tenant serialization (e.g. a Postgres advisory lock around the
  provisioning flow) or making each side-effecting step idempotent against the
  provider (look up an existing subaccount/number before creating). Tracked as a
  follow-up; the shared key closes the common window cheaply.

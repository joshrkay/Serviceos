# Phase 23 — Jobber Parity Closure (native, financing, checklists, ecosystem)

> **5 stories** | Native app shell, consumer financing, job checklists (canned + voice-fillable), outbound webhooks

---

## Purpose

`docs/competitive-gap-analysis.md` §5 names the places Jobber still wins after
the launch plan ships: native mobile apps, consumer financing, custom job
forms, marketing breadth, and ecosystem integrations. Marketing breadth is
already covered by existing specs (P16-003 campaign engine, P8 follow-up
agent, P15-005 referrals). Phase 23 closes the rest — right-sized for the
1–5 person shop: a native wrapper (not a rewrite), financing as a
provider-abstracted prequal link (not a lending platform), canned
voice-fillable checklists (not a form builder), and signed outbound webhooks
(Zapier-compatible, not a plugin marketplace).

## Exit Criteria

The app installs from the App Store / Play Store with working push
notifications and native mic/camera permissions. An estimate over the
tenant's financing threshold shows a "pay as low as $X/mo" prequal link in
the customer portal. A tech opens a job, sees the HVAC maintenance checklist,
and completes it by narrating ("filter changed, coils cleaned, static
pressure 0.8") — the AI fills the items as a proposal. A tenant connects
Zapier via a webhook URL and receives signed `job.completed` and
`invoice.paid` events.

## Foundations already in place

- P22-003 `useGlobalVoice` + shell mic; P22-004 PWA/service worker — P23-001 wraps these
- `packages/api/src/webhooks/**` — inbound webhook base (P23-005 adds outbound direction)
- `packages/api/src/audit/pg-audit.ts` — every mutation already emits events (P23-005 source)
- `packages/api/src/verticals/packs/` (hvac/plumbing/electrical) — P23-003 seeds checklists per vertical
- `packages/api/src/estimates/public-estimate-service.ts` + portal pages — P23-002 surfaces financing
- `packages/api/src/proposals/` — P23-004 checklist fills are proposal-gated
- `packages/api/src/queue/` + `workers/` — async delivery pattern for P23-005

---

## Story Specifications

### P23-001 — Capacitor native shell (iOS + Android)

> **Size:** L | **Layer:** Mobile / Platform | **AI Build:** Medium | **Human Review:** Heavy

**Dependencies:** P22-003, P22-004 merged

**Allowed files:** `packages/mobile/** (new package — Capacitor config, native projects, push plumbing), packages/web/src/native/** (new — capacitor bridge: push token registration, permission prompts, deep links), packages/web/src/components/voice/useGlobalVoice.ts (native-mic branch only), packages/web/vite.config.ts (build target only), package.json + packages/web/package.json (capacitor deps only), packages/api/src/notifications/push/** (new — device token registry + FCM/APNs send), packages/api/src/routes/push-tokens.ts (new), packages/api/src/db/schema.ts (additive migration: device_push_tokens — discover next free number), packages/api/test/notifications/push/**`

**Build prompt:** (1) New `packages/mobile`: Capacitor 6 wrapping the built web app (`webDir` → web build output). iOS + Android projects checked in; app id/name from a single config. (2) Native bridge in `packages/web/src/native/`: detect Capacitor runtime; register push token (`@capacitor/push-notifications`) and POST to `/api/push-tokens`; request mic/camera permissions natively; handle deep links (`serviceos://proposal/:id` → proposal review). Web behavior unchanged when not in Capacitor. (3) API: `device_push_tokens` table (tenant_id, user_id, platform, token, last_seen_at; RLS) + send service wrapping FCM (Android) and APNs (iOS) behind one `sendPush(userId, payload)` — used first for proposal-approval notifications ("AI booked the Smiths, tap to review") and offline-queue flush results. (4) `useGlobalVoice`: when native, prefer native recording permissions path; everything else identical. (5) Do NOT fork UI: one codebase, the native package only wraps.

**Review prompt:** Verify zero UI forks (mobile package contains config/native projects only). Verify push tokens are tenant-scoped with RLS and pruned on 410/invalid responses. Verify deep links land on the right authenticated route. Verify web build unaffected when Capacitor absent.

**Required tests:** push token register/refresh/prune; sendPush fans out to user's devices (mocked FCM/APNs); deep-link parser; bridge no-ops in plain browser; tenant isolation.

---

### P23-002 — Consumer financing on estimates (provider-abstracted)

> **Size:** M | **Layer:** Estimates / Integrations | **AI Build:** Medium | **Human Review:** Heavy

**Dependencies:** none

**Allowed files:** `packages/api/src/financing/** (new — provider interface + wisetack adapter + noop), packages/api/src/routes/financing.ts (new), packages/api/src/db/schema.ts (additive migration: financing_offers — discover next free number), packages/api/src/webhooks/routes.ts (financing status webhook only), packages/api/src/app.ts (wiring only), packages/api/test/financing/**, packages/web/src/components/estimates/FinancingBadge.tsx (new), packages/web/src/pages/portal/PortalEstimateList.tsx (badge mount only), packages/web/src/components/settings/FinancingSettings.tsx (new), packages/web/src/api/financing.ts (new)`

**Build prompt:** (1) Provider interface `FinancingProvider { getPrequalLink(estimate), estimateMonthly(totalCents, termMonths) }` with a Wisetack adapter (REST; merchant id + API key from tenant settings; encrypted at rest reusing the P15-001 crypto pattern) and a Noop provider for dev/unconfigured tenants. (2) `financing_offers` table: tenant_id, estimate_id, provider, status (offered/started/approved/declined/expired), prequal_url, monthly_estimate_cents; RLS. (3) Tenant settings: enable flag + minimum estimate total threshold (default $500 = 50000 cents). (4) Portal + public estimate page: when enabled and total ≥ threshold, `FinancingBadge` shows "as low as ~$X/mo" (display-only approximation, clearly labeled, never a credit promise) linking to the provider prequal URL. (5) Status webhook updates the offer row via the existing webhook base (durable idempotency). (6) No financing math in the billing engine — monthly figure is provider-supplied or simple display approximation, integer cents.

**Review prompt:** Verify credentials encrypted at rest. Verify badge never renders for sub-threshold or disabled tenants. Verify webhook idempotency. Verify the monthly figure is labeled an estimate. Verify no PII sent to provider beyond the provider's documented minimum.

**Required tests:** threshold gating; provider abstraction (wisetack vs noop); offer lifecycle via webhook; monthly display math (integer cents); encrypted credential round-trip; tenant isolation.

---

### P23-003 — Job checklists: canned vertical templates + completion tracking

> **Size:** M | **Layer:** Field Ops | **AI Build:** Medium | **Human Review:** Medium

**Dependencies:** none

**Allowed files:** `packages/api/src/checklists/** (new), packages/api/src/routes/checklists.ts (new), packages/api/src/db/schema.ts (additive migration: checklist_templates + job_checklists — discover next free number), packages/api/src/app.ts (wiring only), packages/api/src/verticals/packs/*.ts (checklist seed data only), packages/api/test/checklists/**, packages/web/src/components/jobs/JobChecklist.tsx (new), packages/web/src/pages/jobs/JobDetail.tsx (checklist section only), packages/web/src/pages/technician/TechnicianDayView.tsx (checklist badge only), packages/web/src/api/checklists.ts (new)`

**Build prompt:** (1) Schema: `checklist_templates` (tenant_id, vertical_type, name, items JSONB — ordered `{key, label, type: check|numeric|text, required}`; seeded per active vertical pack from canned sets: HVAC maintenance, plumbing service call, electrical safety; tenants can edit items but there is NO form builder UI in this story) and `job_checklists` (tenant_id, job_id, template_id, items_state JSONB — `{key: {done|value, completedAt, completedBy}}`, completed_at). RLS both. (2) Service: instantiate template on demand for a job; idempotent per (job, template); item updates patch `items_state`; completing all required items stamps `completed_at` and emits an audit event + job timeline event. (3) Auto-attach: when a job is created under a vertical with a default template, attach it. (4) Web: `JobChecklist` on JobDetail and tech mobile view — tap to check, numeric/text inputs inline; required items block "mark job complete" with an override-with-note path (logged).

**Review prompt:** Verify items_state patches are concurrency-safe (single-row update with jsonb_set or full-row optimistic update — pick one and test). Verify required-item gating with override audit. Verify seeds only apply to activated vertical packs. Verify tenant isolation.

**Required tests:** instantiate idempotent; item check/uncheck round-trip; numeric value persists; required gating + override note; completion stamps timeline; seed per vertical.

---

### P23-004 — Voice-fillable checklists

> **Size:** M | **Layer:** Voice / AI | **AI Build:** High | **Human Review:** Medium

**Dependencies:** P23-003

**Allowed files:** `packages/api/src/ai/tasks/checklist-fill-task.ts (new), packages/api/src/proposals/contracts/fill-checklist.ts (new — Zod), packages/api/src/proposals/execution/fill-checklist-handler.ts (new), packages/api/src/proposals/execution/handlers.ts (registry entry only), packages/api/src/ai/orchestration/intent-classifier.ts (add fill_checklist intent only), packages/api/test/ai/tasks/checklist-fill.test.ts, packages/api/test/proposals/fill-checklist-handler.test.ts`

**Build prompt:** (1) Intent `fill_checklist`: tech narration like "filter changed, coils cleaned, static pressure point eight" while a job context is active. (2) `checklist-fill-task.ts`: load the job's checklist items (labels + types) into the LLM prompt; map narration → `{key, value|done}` updates. Numeric parsing must handle spoken numbers ("point eight" → 0.8). Items not mentioned are untouched; ambiguous mentions are skipped, never guessed. (3) `fill_checklist` proposal (capture tier — auto-approvable per tenant threshold rules since it's non-financial): payload `{jobChecklistId, updates[]}` validated by Zod against the template's item keys/types. (4) Execution handler applies updates via the P23-003 service (no direct SQL) and emits audit. (5) TTS confirmation summarizes what was filled and what was skipped: "Marked filter and coils done, static pressure 0.8 — I didn't catch anything about the condensate line."

**Review prompt:** Verify unmentioned items untouched and ambiguous items skipped. Verify type validation (numeric item rejects non-numeric). Verify handler routes through the checklist service. Verify the TTS summary names skipped required items.

**Required tests:** narration fills 3 of 5 items; spoken-number parsing; ambiguous item skipped; type mismatch rejected by contract; handler idempotency; intent classifier routes 5+ phrasings.

---

### P23-005 — Outbound webhooks (Zapier-compatible ecosystem hook)

> **Size:** M | **Layer:** Platform / Integrations | **AI Build:** Medium | **Human Review:** Heavy

**Dependencies:** none

**Allowed files:** `packages/api/src/webhooks/outbound/** (new — subscription repo, dispatcher, signer), packages/api/src/routes/webhook-subscriptions.ts (new), packages/api/src/db/schema.ts (additive migration: webhook_subscriptions + webhook_deliveries — discover next free number), packages/api/src/workers/webhook-delivery-worker.ts (new), packages/api/src/app.ts (wiring only), packages/api/test/webhooks/outbound/**, packages/api/test/workers/webhook-delivery-worker.test.ts, packages/web/src/components/settings/WebhooksSettings.tsx (new), packages/web/src/api/webhook-subscriptions.ts (new)`

**Build prompt:** (1) Schema: `webhook_subscriptions` (tenant_id, url, secret, events TEXT[] — e.g. `job.completed`, `invoice.paid`, `customer.created`, `appointment.scheduled`, `estimate.accepted`; is_active) and `webhook_deliveries` (subscription_id, event_type, payload JSONB, status pending/delivered/failed, attempts, next_attempt_at, response_code). RLS both. (2) Event source: tap the existing audit-event emission path (read-only — subscribe where audit events are recorded, translating a fixed allowlist of audit event types to public event names; never expose raw audit rows). Payloads are versioned (`{event, version: 1, occurredAt, data}`) with tenant-scoped entity snapshots containing NO internal ids beyond entity ids. (3) Delivery worker (async worker pattern P0-009): POST with `X-ServiceOS-Signature: sha256=` HMAC of body using the subscription secret; exponential backoff 1m/5m/30m/2h/12h, then mark failed and auto-disable after 20 consecutive failures (notify owner). (4) Routes: CRUD subscriptions + `POST /:id/test` (sends a signed ping) + delivery log list. (5) Settings UI: add/edit subscription, event picker, reveal-once secret, recent deliveries with response codes.

**Review prompt:** Verify HMAC signing and reveal-once secret handling. Verify the event allowlist (no audit passthrough). Verify backoff + auto-disable + owner notification. Verify SSRF guardrails on subscription URLs (https only; reject private-network hosts). Verify tenant isolation on deliveries.

**Required tests:** signature verifiable by receiver; allowlist filtering; retry/backoff schedule; auto-disable at threshold; SSRF rejection (http://, 10.x, 169.254.x, localhost); test-ping endpoint; tenant isolation.

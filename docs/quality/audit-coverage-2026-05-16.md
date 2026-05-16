# Route Audit Coverage Sweep — 2026-05-16 (D2-1, Phase 1)

CLAUDE.md states "All mutations: emit audit events". This document is the
result of auditing the 28 route files under `packages/api/src/routes/` that
were flagged by grep as not injecting `auditRepo`. For each file we list its
mutation endpoints, trace whether an `auditRepo.create(...)` reaches the call
stack, and categorize the file.

The 28 files were:

```
appointments.ts assistant.ts bundles.ts calendar-integrations.ts
catalog-items.ts conversations.ts feature-flags.ts feedback.ts
interactions.ts locations.ts maintenance-contracts.ts notes.ts
pack-activation.ts portal.ts proposals.ts public-estimates.ts
public-feedback.ts public-invoices.ts public-payments.ts
quality.ts reports.ts settings.ts technician-location.ts
templates.ts users.ts vertical-training-assets.ts verticals.ts
voice-sessions.ts
```

## Category legend

- **COVERED** — every mutation endpoint already produces an audit event
  somewhere downstream of the route handler.
- **PARTIAL** — at least one mutation endpoint emits an audit event but at
  least one other does not.
- **MISSING** — no mutation endpoint in the file produces an audit event.
- **READ-ONLY** — file contains zero POST/PUT/PATCH/DELETE handlers, so the
  CLAUDE.md rule does not apply.
- **OUT-OF-SCOPE** — endpoints are high-volume telemetry / external-protocol
  endpoints where per-call audit logging would flood the audit table or be
  semantically wrong. Rationale documented per row.

## Summary counts

| Category | Count |
|---|---|
| COVERED | 2 |
| PARTIAL | 2 |
| MISSING | 16 |
| READ-ONLY | 5 |
| OUT-OF-SCOPE | 3 |
| **Total** | **28** |

> **Scope-guard trip:** 18 files (MISSING + PARTIAL) require code changes;
> projected total LOC change exceeds the ~1500-line scope-guard threshold in
> the D2-1 ticket. Per instructions, Phase 2 is split into sub-batches and
> deferred. This commit lands the categorization doc only.

## Per-file table

| File | Category | Mutation endpoints | Downstream audit? | Notes |
|---|---|---|---|---|
| `appointments.ts` | PARTIAL | `POST /`, `PUT /:id`, `POST /:id/delay-ack` | No on any path — `appointments/appointment.ts` has no `auditRepo.create`. Delay-ack writes a `JobTimeline` row (operational), not an audit event. | All three mutations need audit. |
| `assistant.ts` | OUT-OF-SCOPE | `POST /chat` | Conversational AI streaming; no persisted data mutation. AI run telemetry lives in `ai_runs` (separate observability surface). | High-volume token-streaming endpoint; auditing per-message would flood. |
| `bundles.ts` | MISSING | `POST /`, `POST /match`, `PUT /:id` | `verticals/bundles.ts:createBundle` has no audit call; `match` is read-only. | `match` is search-only, but POST `/` and PUT `/:id` need audit. |
| `calendar-integrations.ts` | MISSING | `POST /google/connect`, `DELETE /google`, `POST /google/test-push`, `GET /google/callback` (writes via `upsert`) | `integrations/calendar-integration.ts` and `integrations/google-calendar.ts` have no `auditRepo` calls. | OAuth lifecycle is security-relevant — must audit connect/disconnect/callback. `test-push` is operational-only (skip). |
| `catalog-items.ts` | MISSING | `POST /`, `PUT /:id`, `DELETE /:id` | `catalog/catalog-item.ts` has no audit. | Pricing data is sensitive; all three must audit. |
| `conversations.ts` | MISSING | `POST /` (create conversation), `POST /:id/messages` (add message) | `conversations/conversation-service.ts` has no `auditRepo.create`. | Create-conversation needs audit; per-message audit is **OUT-OF-SCOPE** within this file (high-volume voice transcript inserts via this same path during calls). Fix conversation creation only. |
| `feature-flags.ts` | MISSING | `PUT /:name`, `DELETE /:name` | `flags/feature-flags.ts` has no audit. | Platform-admin gated; mutations rare but very sensitive (cross-tenant blast radius). Must audit. |
| `feedback.ts` | READ-ONLY | _none_ | n/a | Only `GET /`. No action needed. |
| `interactions.ts` | READ-ONLY | _none_ | n/a | Only `GET /` + `GET /:id` over `voice_sessions`. No action needed. |
| `locations.ts` | MISSING | `POST /`, `PUT /:id`, `POST /:id/archive`, `POST /:id/set-primary` | `locations/location.ts` has no audit. | All four mutations need audit. |
| `maintenance-contracts.ts` | MISSING | `POST /` | Backed by in-process `Map`; no service layer. | Low priority (in-memory placeholder per file header), but for parity should still write an audit row. Defer to last sub-batch. |
| `notes.ts` | MISSING | `POST /`, `PUT /:id`, `DELETE /:id` | `notes/note.ts` has no audit. | All three need audit (notes can carry sensitive operator commentary). |
| `pack-activation.ts` | MISSING | `PUT /:packId/activate`, `DELETE /:packId` | `settings/pack-activation.ts` has no audit. | Tenant-wide activation is a privileged change. Audit both. |
| `portal.ts` | MISSING | `POST /` (mint portal session), `DELETE /:id` (revoke) | `portal/portal-service.ts` has no audit. | Portal tokens are bearer credentials; mint/revoke must audit. |
| `proposals.ts` | MISSING | `POST /:id/approve`, `POST /:id/reject`, `POST /:id/undo`, `PUT /:id` (edit) | `proposals/actions.ts` does not call `auditRepo.create`. `proposals/audit.ts` defines `logProposalEvent` but it is unused. | High-criticality — proposal approval is the human-in-the-loop gate. All four must audit; `logProposalEvent` is the right helper to wire in. |
| `public-estimates.ts` | MISSING | `POST /:token/view`, `POST /:token/approve`, `POST /:token/deposit-checkout`, `POST /:token/decline` | `estimates/public-estimate-service.ts` has no `auditRepo.create` despite the file-level comment ("then emit an audit event…"). | `approve` and `decline` are non-repudiation events with IP/UA capture; MUST audit. `view` and `deposit-checkout` are operational page interactions (audit `view` would flood — treat per-row as OUT-OF-SCOPE). |
| `public-feedback.ts` | MISSING | `POST /:token` (submit feedback) | `feedback/feedback-response.ts` and `feedback/feedback-request.ts` have no audit. | Customer-submitted; audit the submission for traceability. |
| `public-invoices.ts` | PARTIAL | `POST /:token/view`, `POST /:token/checkout` | `invoices/public-invoice-service.ts` has no audit. | `view` is high-volume (every page load) — OUT-OF-SCOPE per call. `checkout` mints a Stripe Payment Link — first-time mint should audit; subsequent idempotent reads do not. |
| `public-payments.ts` | OUT-OF-SCOPE | `POST /create-payment-intent`, `GET /status/:invoiceId` | Creates a Stripe `PaymentIntent`; the actual payment row is written later by the Stripe webhook in `webhooks/routes.ts`, which **does** call `auditRepo.create`. | No DB mutation in this route — Stripe owns the side effect. The webhook completes the audit trail. |
| `quality.ts` | READ-ONLY | _none_ | n/a | Only `GET`s. |
| `reports.ts` | READ-ONLY | _none_ | n/a | Only `GET`s. |
| `settings.ts` | MISSING | `PATCH /language`, `PUT /` | `settings/settings.ts:updateSettings` has no audit; `/language` is an in-process `Map`. | Tenant settings change must audit. `/language` is in-memory today but should still emit (forward-compat). |
| `technician-location.ts` | OUT-OF-SCOPE | `POST /` (batched ping ingest) | None — pings stream every ~30s, often hundreds per technician per shift. | Per-ping audit would multiply audit-table size by 100x; out-of-scope by design. (Per-shift summary audit is a separate ticket.) |
| `templates.ts` | MISSING | `POST /`, `POST /:id/instantiate`, `PUT /:id` | `templates/estimate-template.ts` has no audit. | `POST /` and `PUT /:id` need audit. `instantiate` only increments a usage counter — operational, not a domain mutation; OUT-OF-SCOPE per-call within this file. |
| `users.ts` | MISSING | `PATCH /:id` (role / name change), `POST /invitations` | `users/user.ts` has no audit; `users/pending-invitation.ts` has no audit. | Role changes and invitations are very sensitive — MUST audit. |
| `vertical-training-assets.ts` | COVERED | `POST /`, `POST /:id/approve`, `POST /:id/activate`, `POST /:id/archive` | `verticals/training-asset-service.ts` calls `auditRepo.create(...)` for create + every lifecycle transition (lines 432, 578). | No action. |
| `verticals.ts` | READ-ONLY | _none_ | n/a | Only `GET`s. |
| `voice-sessions.ts` | COVERED | `POST /`, `POST /:id/input`, `DELETE /:id` | `ai/agents/customer-calling/inapp-adapter.ts` calls `auditRepo.create(ev)` at line 655 inside session lifecycle. | No action. |

## Phase 2 sub-batches (proposed)

To stay within commit-size limits and isolate review surface area, Phase 2
should be split into the following sub-tickets. Each sub-batch is sized for
one focused dispatch (~3-5 files, ~300-600 LOC):

### D2-1a — Customer-domain mutation routes (≈4 files)
- `appointments.ts` (3 endpoints)
- `locations.ts` (4 endpoints)
- `notes.ts` (3 endpoints)
- `conversations.ts` (1 endpoint — conversation create only; per-message audit
  remains OUT-OF-SCOPE within this file)

Service files needing edits:
`appointments/appointment.ts`, `locations/location.ts`, `notes/note.ts`,
`conversations/conversation-service.ts`.

New `AuditEventType` values (all additive, namespaced strings):
`appointment.created`, `appointment.updated`, `appointment.delay_acknowledged`,
`location.created`, `location.updated`, `location.archived`,
`location.primary_set`, `note.created`, `note.updated`, `note.deleted`,
`conversation.created`.

### D2-1b — Catalog / templates / bundles (≈3 files)
- `catalog-items.ts` (3 endpoints)
- `templates.ts` (2 endpoints — skip `instantiate`)
- `bundles.ts` (2 endpoints — skip `match`)

Service files: `catalog/catalog-item.ts`, `templates/estimate-template.ts`,
`verticals/bundles.ts`.

New event types: `catalog_item.created`, `catalog_item.updated`,
`catalog_item.archived`, `estimate_template.created`, `estimate_template.updated`,
`service_bundle.created`, `service_bundle.updated`.

### D2-1c — Proposals + settings + users + flags (≈4 files, highest sensitivity)
- `proposals.ts` (4 endpoints — wire existing `logProposalEvent`)
- `settings.ts` (2 endpoints — `PATCH /language`, `PUT /`)
- `users.ts` (2 endpoints)
- `feature-flags.ts` (2 endpoints)

Service files: `proposals/actions.ts` (call existing `logProposalEvent`),
`settings/settings.ts`, `users/user.ts`, `users/pending-invitation.ts`,
`flags/feature-flags.ts`.

New event types: `proposal.approved`, `proposal.rejected`, `proposal.edited`,
`proposal.undone` (some already in the `PROPOSAL_EVENT_TYPES` const in
`proposals/audit.ts` — wire that helper through);
`settings.tenant.updated`, `settings.language.updated`,
`user.updated`, `user.invited`,
`feature_flag.upserted`, `feature_flag.deleted`.

### D2-1d — Portal + integrations + public surfaces (≈5 files)
- `portal.ts` (2 endpoints)
- `calendar-integrations.ts` (3 endpoints — connect, disconnect, callback;
  skip `test-push`)
- `public-estimates.ts` (2 endpoints — `approve`, `decline`; `view` and
  `deposit-checkout` are OUT-OF-SCOPE per-call)
- `public-feedback.ts` (1 endpoint)
- `public-invoices.ts` (1 endpoint — `checkout` first-mint only)

Service files: `portal/portal-service.ts`,
`integrations/calendar-integration.ts` (or wrap at route level),
`estimates/public-estimate-service.ts`,
`feedback/feedback-response.ts`, `invoices/public-invoice-service.ts`.

Public routes have no Clerk session — the audit `actorId` will be a synthetic
`customer:<customerId>` or `public:<token-hash>` value with `actorRole='customer'`.

New event types: `portal_session.created`, `portal_session.revoked`,
`calendar_integration.connected`, `calendar_integration.disconnected`,
`calendar_integration.callback_consumed`,
`public_estimate.approved`, `public_estimate.declined`,
`feedback_response.submitted`, `public_invoice.checkout_created`.

### D2-1e — Pack-activation + maintenance-contracts (≈2 files, lowest priority)
- `pack-activation.ts` (2 endpoints)
- `maintenance-contracts.ts` (1 endpoint — in-memory placeholder; emit audit
  even though the persistence layer is a `Map`)

Service files: `settings/pack-activation.ts`, and inline emission in
`maintenance-contracts.ts` route handler.

New event types: `pack_activation.activated`, `pack_activation.deactivated`,
`maintenance_contract.created`.

## Smoke-test plan (Phase 3, to be implemented per sub-batch)

`packages/api/test/audit/audit-coverage.test.ts` should assert that the
following five "canary" mutations write at least one row to an
`InMemoryAuditRepository`:

1. `POST /api/appointments` (D2-1a)
2. `PUT /api/catalog/items/:id` (D2-1b)
3. `POST /api/proposals/:id/approve` (D2-1c)
4. `POST /public/estimates/:token/approve` (D2-1d)
5. `PUT /api/settings/` (D2-1c)

The test asserts `auditRepo.getAll().some(e => e.entityType === '<type>' && e.eventType === '<expected>')`
for each.

## Notes on enum changes (Tier-1 freeze list)

`AuditEventType` in `packages/shared/src/enums.ts` is on the
`freeze-list.md` Tier-1 list: **additive changes allowed, renames forbidden**.
Existing values (`CREATED`, `UPDATED`, `ARCHIVED`, …) remain untouched. The
new dot-namespaced values listed per sub-batch above are added as new enum
members; the existing generic values are left in place for backward
compatibility with any caller that uses them (none in the codebase today, but
the freeze-list contract requires it).

The existing convention in the codebase is to pass the event-type string
literal directly (e.g. `'vertical_training_asset.created'` in
`training-asset-service.ts`). Phase 2 will follow the same convention — the
enum additions document the canonical names but the call sites pass strings.

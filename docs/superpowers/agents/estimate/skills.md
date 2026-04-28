# Estimate Agent — Skills

Most skills wrap existing code in `packages/api/src/estimates/*` and `packages/api/src/ai/tasks/estimate-*`. The agent's value-add is **state machine orchestration + idempotency + audit + handoff to the invoice agent on acceptance**.

## Skill index

| Skill | Used in states | Wraps existing | New code | Notes |
|---|---|---|---|---|
| `create_estimate_draft` | trigger → draft | `estimate.ts` repo, `estimate-task.ts`, billing engine | small | wrapper |
| `apply_estimate_edit` | draft / revising | `estimate-editor.ts`, `estimate-edit-task.ts` | small | wrapper + delta audit |
| `validate_estimate` | validating | shared validator pattern (mirror of `invoice-proposal-validator`) | small | new (or reuse if generalized) |
| `compute_totals` | draft | shared billing engine | none | reuse |
| `check_auto_approve` | awaiting_approval | tenant policy + AI confidence | small | new |
| `queue_estimate_proposal` | awaiting_approval | proposal engine | small | wraps `draft_estimate` |
| `render_estimate` | sending | new HTML/PDF renderer | medium | v1 HTML; v2 PDF |
| `mint_view_token` | sending | crypto.randomUUID + DB | small | new |
| `send_estimate` | sending | followup agent `send_email` / `send_sms` | small | hand-off |
| `record_view` | awaiting_response | audit (no state change) | small | new |
| `accept_estimate` | awaiting_response → converting | `approved-estimate-metadata.ts`, `estimate-snapshots.ts` | small | wraps existing |
| `decline_estimate` | awaiting_response → declined | audit | small | new |
| `request_revision` | awaiting_response → revising | `estimate-snapshots.ts` snapshot of prior rev | small | new |
| `convert_to_invoice` | converting | invoice agent `create_invoice_draft({source: 'estimate_accepted'})` | small | hand-off |
| `expire_stale` | scheduler tick | scan + transition | small | new |
| `emit_audit` | every transition | shared audit | none | reuse |

## Skill specs

---

### `create_estimate_draft` (small — wrap)

Creates the canonical estimate row in `draft` state. Source-aware so re-fired events don't duplicate.

**Input:**
```ts
type CreateDraftInput =
  | { source: 'manual', dispatcherId: string, payload: EstimateDraftPayload }
  | { source: 'ai_proposal', proposalId: string, payload: EstimateDraftPayload }
  | { source: 'lead_pipeline', leadId: string, payload: EstimateDraftPayload };
```
**Output:** `{ estimateId: string, idempotent: boolean }`
**Errors:** `MissingCustomerError`, `MissingLineItemsError`, `IdempotencyConflict`
**State:** `draft`
**New file:** `packages/api/src/agents/estimate/create-draft.ts`

**Implementation notes:**
- Idempotency: `(tenantId, source, sourceRef)` unique key.
- Line items via `estimate-task.ts` (existing AI composition for AI sources) or explicit payload (manual).
- Totals via shared billing engine.

---

### `apply_estimate_edit` (small — wrap)

Applies a typed patch. Valid in `draft` or `revising`. Records edit-delta.

**Input:** `{ estimateId, patch: EstimateEditPatch, actorId }`
**Output:** `{ revision: number, totals: EstimateTotals }`
**Errors:** `EstimateNotEditable`, `InvalidPatch`
**State:** `draft` / `revising`
**Wraps:** `estimate-editor.ts`, `estimate-edit-task.ts`.

---

### `validate_estimate` (small — new)

Mirror of `invoice-proposal-validator` for estimates. Same math + currency + customer rules; estimates additionally validate `expiresAt > now` and `at least one line item`.

**Input:** `{ estimateId }`
**Output:** `{ valid: true } | { valid: false, field_errors: ValidationIssue[] }`
**State:** `validating`
**New file:** `packages/api/src/agents/estimate/validate-estimate.ts`

If a generalized validator emerges from invoice work (P9-001), refactor both to share — for now, copy the pattern, keep them sibling files.

---

### `check_auto_approve` (small — new)

Decides auto vs human based on tenant policy + AI confidence + amount.

**Input:** `{ estimateId, source, aiConfidence?: number }`
**Output:** `{ autoApprove: boolean, reason }`
**New file:** `packages/api/src/agents/estimate/auto-approve.ts`

---

### `queue_estimate_proposal` (small — wrap)

Inserts a `draft_estimate` proposal for human review.

**Input:** `{ estimateId, draftedBy: 'ai' | 'manual' }`
**Output:** `{ proposalId }`
**State:** `awaiting_approval`
**Wraps:** existing proposal engine + `draft_estimate` proposal handler.

---

### `render_estimate` (medium — new, v1 minimal)

v1: render HTML using context module similar to `invoice-context.ts`; persist `html_snapshot`.
v2: real PDF.

**Input:** `{ estimateId }`
**Output:** `{ url: string, contentType: 'text/html' | 'application/pdf' }`
**Cost ceiling:** $0 (template render).
**New file:** `packages/api/src/agents/estimate/render-estimate.ts`

---

### `mint_view_token` (small — new)

Mint a 32-char URL-safe token; persist on `estimates.view_token`. One token per revision; rotated on revision.

**Input:** `{ estimateId, revision }`
**Output:** `{ viewToken: string, viewUrl: string }`
**New file:** part of `render-estimate.ts`.

---

### `send_estimate` (small — hand-off)

Hands the rendered URL + summary to the **followup agent** for outbound delivery (SMS or email per tenant default channel). No direct provider calls here.

**Input:** `{ estimateId, channel: 'sms' | 'email', recipientHint?, sender? }`
**Output:** `{ enqueued: true, taskId: string }`
**State:** `sending`

The followup agent's `send_sms` / `send_email` skills do the actual provider call and report back via `estimate.sent` event when delivery is acknowledged.

---

### `record_view` (small — new)

When the hosted-view URL is fetched, record the view (estimate_id, viewed_at, ip, user_agent). No state change — `awaiting_response` stays `awaiting_response`. Useful for follow-up rule logic (`estimate_nudge_3d` should not fire if the estimate has been viewed in the last 24h, etc.).

**Input:** `{ estimateId, ip, userAgent }`
**Output:** `{ recorded: true }`
**State:** `awaiting_response` (no change)
**New file:** `packages/api/src/agents/estimate/record-view.ts`

---

### `accept_estimate` (small — wrap)

Customer clicks Accept on the hosted view (or dispatcher records acceptance manually). Snapshots the accepted revision via `approved-estimate-metadata.ts`. Transitions to `converting`.

**Input:** `{ estimateId, revision, signature?: { ip, userAgent, signedAt }, channel: 'web' | 'manual' }`
**Output:** `{ accepted: true, snapshotId: string }`
**Errors:** `EstimateExpired`, `RevisionMismatch` (acceptance for stale rev), `AlreadyAccepted`
**State:** `converting`
**Wraps:** `approved-estimate-metadata.ts`, `learning/approved-estimates.ts`.

---

### `decline_estimate` (small — new)

Customer or dispatcher records a decline. Suppresses follow-up nudges. Terminal.

**Input:** `{ estimateId, reason?: string, declinedBy: 'customer' | 'dispatcher' }`
**Output:** `{ declined: true }`
**State:** `declined`
**New file:** `packages/api/src/agents/estimate/decline-estimate.ts`

---

### `request_revision` (small — new)

Snapshot the current revision, increment rev counter, transition to `revising`. The dispatcher (or AI) then edits and resubmits.

**Input:** `{ estimateId, notes: string, requestedBy: 'customer' | 'dispatcher' }`
**Output:** `{ newRevision: number }`
**State:** `revising`
**Wraps:** `estimate-snapshots.ts`.

---

### `convert_to_invoice` (small — hand-off)

Emits the `estimate_accepted` event to the **invoice agent** with the accepted estimate's line items. The invoice agent's `create_invoice_draft({source: 'estimate_accepted', estimateId})` handles the rest.

**Input:** `{ estimateId, snapshotId }`
**Output:** `{ invoiceId: string }`
**State:** `converting → accepted`
**Wraps:** invoice agent entry point (cross-agent call via internal queue, not direct import — keeps modules decoupled).

---

### `expire_stale` (small — new)

Scheduler sweep every 1 hour: finds `awaiting_response` estimates past `expires_at`, transitions them to `expired`, emits audit, suppresses follow-up rules.

**Input:** `{ now: Date, lookbackDays?: number }`
**Output:** `{ expired: number }`
**State:** N/A (sweep)
**New file:** `packages/api/src/agents/estimate/expire-sweep.ts`

---

### `emit_audit` (shared)

Every transition emits an audit row. Reuses shared audit module.

## Build vs reuse summary

| Status | Skills |
|---|---|
| Reuse (no new code) | `compute_totals`, `emit_audit` |
| Wrap existing | `create_estimate_draft`, `apply_estimate_edit`, `accept_estimate`, `request_revision`, `queue_estimate_proposal` |
| Hand-off | `send_estimate` (followup), `convert_to_invoice` (invoice agent) |
| New (small) | `validate_estimate`, `check_auto_approve`, `mint_view_token`, `record_view`, `decline_estimate`, `expire_stale` |
| New (medium) | `render_estimate` (v1 HTML; v2 PDF) |

The agent itself is a thin state-machine module under `packages/api/src/agents/estimate/state-machine.ts` — same pattern as the invoice agent.

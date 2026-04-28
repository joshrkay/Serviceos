# Estimate Agent — Flow

**Purpose:** Orchestrate the lifecycle of an estimate from **draft → reviewed → sent → accepted (or declined / expired)**, then hand off to the **invoice agent** on acceptance. Wraps existing estimate skills (`estimate-task`, `estimate-edit-task`, `estimate-editor`, `estimate-snapshots`, `approved-estimate-metadata`) into a typed state machine.

The estimate agent is the **demand-capture mirror** of the invoice agent. They share many patterns (state-machine module, idempotency on source events, auto-approve policy, audit-replay) and most of the implementation roadmap is intentionally parallel.

The estimate agent does **not** dun for response — that's the customer-followup agent's `estimate_nudge_3d` and `estimate_nudge_7d` rules. The estimate agent's responsibility ends at "sent + view link active" and resumes only on lifecycle events: `estimate.viewed`, `estimate.accepted`, `estimate.declined`, `estimate.expired`, `estimate.revision_requested`.

**Companion files:** `skills.md`, `test-plan.md`, `implementation-roadmap.md`. **Framework:** `../README.md`.

## Trigger sources

| Trigger | Origin | State entered |
|---|---|---|
| Manual: dispatcher creates estimate in UI | API `POST /api/estimates` | `draft` |
| AI proposal: voice/follow-up agent drafts estimate | proposal engine `draft_estimate` | `draft` |
| Job inquiry / lead with `auto_estimate: true` | lead pipeline | `draft` (AI-drafted) |
| `estimate.viewed` event | hosted-view route token | (no state change — emits audit) |
| `estimate.accepted` event | hosted-view "Accept" button OR signed PDF flow | `accepted` |
| `estimate.declined` event | hosted-view "Decline" button OR explicit reply | `declined` |
| `estimate.revision_requested` | reply / dispatcher action | `revising` (back to editable) |
| Scheduled expiry (default 30d after sent) | scheduler tick | `expired` |

## State machine

```
              ┌──────┐
              │ idle │
              └──┬───┘
                 │ trigger (manual / AI / lead)
                 ▼
            ┌──────────┐
            │  draft   │
            └────┬─────┘
                 │ submit_for_review
                 ▼
        ┌─────────────────────┐  rejected
        │  validating         │──────────────┐
        └────┬────────────────┘              │
             │ valid                         │
             ▼                               │
        ┌─────────────────────┐              │
        │  awaiting_approval  │              │
        └────┬────────────────┘              │
             │ approved (auto or human)      │
             ▼                               │
        ┌─────────────────────┐              │
        │  sending            │              │
        └────┬────────────────┘              │
             │ sent (link delivered)         │
             ▼                               │
        ┌─────────────────────┐              │
        │  awaiting_response  │ ◀────────────┘ (back to draft on reject)
        └────┬────────────────┘
             │ accepted    declined    revision_req    expired
             ▼               │              │             │
        ┌─────────────────┐  ▼              ▼             ▼
        │  converting     │ ┌──────────┐ ┌──────────┐ ┌──────────┐
        └────┬────────────┘ │ declined │ │ revising │ │ expired  │
             │              └──────────┘ └────┬─────┘ └──────────┘
             │ invoice_created                │ resubmit
             ▼                                │ ▲
        ┌─────────────────┐                   │ │  back to draft
        │  accepted       │                   └─┘
        └─────────────────┘
```

### State definitions

| State | Description | Entry side effects | Exit |
|---|---|---|---|
| `idle` | No active estimate. | — | trigger |
| `draft` | Editable. Line items, taxes, totals computed via shared **billing engine**. | Persist draft. Compute totals. Emit `estimate.draft.created`. | `submit_for_review` |
| `validating` | `estimate-proposal-validator` (math, currency, customer, line items). | Run validator. | `valid` → `awaiting_approval`; `rejected` → `draft` |
| `awaiting_approval` | Auto-approve OR proposal queue. | Insert proposal OR auto-approve. | `approved`/`rejected` |
| `sending` | Generate hosted view + token; deliver via configured channel (followup-agent: SMS/email). | Stripe **not** involved (no payment until invoice). PDF/HTML render queued. Send queued via followup. | delivery ack |
| `awaiting_response` | Customer can view/accept/decline. | Audit `estimate.sent`. Schedule auto-expiry timer (default 30d). Emit followup nudge eligibility. | webhook / customer action / timer |
| `revising` | Revision requested; new revision drafted. | Snapshot prior revision via `estimate-snapshots`. | back to `draft` |
| `converting` | Estimate accepted; creating invoice via the **invoice agent**. | Emit `estimate_accepted` event → invoice agent enters `draft` w/ pre-populated line items. | invoice ack |
| `accepted` | Terminal. Linked to invoice id. | Audit `estimate.accepted`. Insert `approved-estimate-metadata` row. | terminal |
| `declined` | Terminal. Customer said no (or implicit decline). | Audit. Suppress further follow-ups for this estimate. | terminal |
| `expired` | Terminal. No response within window. | Audit. Followup-agent suppresses further nudges. | terminal |

## Events

**Input (to the agent):**
- `estimate.create_requested(payload, source)` — `source ∈ { manual, ai_proposal, lead_pipeline }`
- `estimate.edit_requested(estimateId, patch)` — only valid in `draft` or `revising`
- `estimate.submit_for_review(estimateId)`
- `estimate.approve(estimateId, approverId)` / `estimate.reject(estimateId, reason)`
- `estimate.send_failed(estimateId, reason)` — followup agent send error
- `estimate.viewed(estimateId, viewedAt)` — hosted-view audit only (no state change)
- `estimate.accepted(estimateId, signature?)`
- `estimate.declined(estimateId, reason?)`
- `estimate.revision_requested(estimateId, notes)`
- `estimate.expire_check(now)` — scheduler sweep

**Emitted (out):**
- `estimate.draft.created`
- `estimate.sent(estimateId, viewUrl)`
- `estimate.viewed(estimateId, viewedAt)` (audit)
- `estimate.accepted(estimateId, invoiceId)` ← consumed by invoice agent
- `estimate.declined(estimateId, reason)`
- `estimate.expired(estimateId)`

## Approval policy (per tenant)

| Tenant config | Auto-approve when | Otherwise |
|---|---|---|
| `auto_approve_estimates: false` (default) | never | always queue proposal |
| `auto_approve_estimates: true, max_amount_cents: 100000` | AI confidence ≥ 0.9 AND total ≤ $1000 AND source = `ai_proposal` | queue proposal |

Manual estimates (created in UI by dispatcher) bypass the agent's approval gate — UI submission **is** the approval.

## Idempotency

- Estimate creation: idempotency key = `tenantId:source:sourceRef` (e.g. `t1:lead_pipeline:lead_42`).
- Send: idempotency key = `estimate:${id}:rev:${rev}` so retries don't double-send.
- View tokens: 32-char URL-safe random; one token per revision; rotated on revision.

## Cost & rate caps

- **AI cost ceiling:** ≤ $0.05 per estimate draft (cheap-tier model for line composition; mid-tier on edit-delta evaluation).
- **Per-tenant estimate cap:** none, but burst > 100/min logs anomaly.
- **AI auto-draft confidence floor:** 0.7 minimum to route through `awaiting_approval`; below that → require dispatcher to manually edit before submit.

## Compliance

- **Acceptance binding:** v1 = "click to accept" + audit row with IP + timestamp. v2 = e-signature (Dropbox Sign / DocuSign) for high-value estimates.
- **Tax:** Per-tenant rate; agent never hard-codes. Same engine as invoice agent.
- **Retention:** Accepted/declined/expired estimates retained ≥ 7 years. Soft-delete only.

## Failure-mode → state map

| Failure | Detection | Behavior |
|---|---|---|
| Validator rejects | validator returns issues | back to `draft` w/ field errors |
| Send failure (followup agent SMS/email error) | event `estimate.send_failed` | back to `awaiting_approval`; alert dispatcher; retry on demand |
| Hosted-view token leaked | dispatcher rotates | new token issued; old token returns 404; no state change |
| Customer accepts after revision sent | acceptance arrives for stale revision | reject acceptance; re-prompt with current revision |
| LLM timeout during draft | gateway timeout | fall back to dispatcher manual entry; log degraded mode |

## Channel — where the agent surfaces

| Channel | How estimate work surfaces |
|---|---|
| Voice (in-app or telephony) | Calling agent → proposal `draft_estimate` → estimate agent enters `awaiting_approval` |
| Web UI (dispatcher) | Direct REST → `draft` → manual edits → `awaiting_approval` (auto-approves on submit) |
| Lead pipeline (auto-quote) | Lead in → AI drafts → `awaiting_approval` (gated by tenant policy) |
| Hosted view (customer) | View URL → Accept/Decline buttons → emits accept/decline events |

## Open questions

1. **E-signature for high-value estimates?** v1 = click to accept + IP audit. v2 = configurable threshold above which DocuSign/Dropbox Sign is required.
2. **Multi-revision UX?** v1 = each revision replaces the active one; old revisions stored in `estimate-snapshots`. v2 = side-by-side compare in customer view.
3. **Default expiry window?** Currently 30 days. Per-tenant override needed; surface in UI.
4. **Bundle / package estimates?** v1 = single estimate per opportunity. v2 = parent/child for option presentation ("Good / Better / Best").

---
title: "Interaction Model reconciliation — Governed Autonomy, edit recompute, SMS compliance"
date: 2026-06-22
track: knowledge
problem_type: architecture-patterns
module: "packages/api/src/proposals, packages/api/src/notifications/customer-message-delivery.ts, packages/web/src/components/shared/VoiceBar.tsx"
tags: ["governed-autonomy", "auto-approve", "proposal-edit", "catalog-resolver", "sms-consent", "interaction-model", "spec-reconciliation"]
related:
  - docs/solutions/workflow-issues/verify-spec-gaps-against-shipped-code.md
  - docs/solutions/conventions/line-item-price-field-estimate-vs-invoice.md
---

## Context

A section-by-section audit of the Interaction Model behavioral contract against
`/packages` found six divergences between spec language and shipped code. The
headline gap — auto-approve vs "never auto-execute" — was resolved as
**Governed Autonomy** (keep fenced behavior, make it honest in docs *and* audit).
The remaining gaps were concrete engineering fixes (edit recompute, message
expiry, voice affordances, SMS compliance). Plan:
`docs/plans/2026-06-22-001-fix-interaction-model-reconciliation-plan.md`.

## Guidance

### 1. Verify spec claims against code before planning

Treat backlog/spec "gaps" as hypotheses, not work orders. Several U7 items
looked like missing gates but the chokepoint already existed — see
`docs/solutions/workflow-issues/verify-spec-gaps-against-shipped-code.md`.

### 2. Governed Autonomy = docs + audit, not gate changes

Product decision: keep `decideInitialStatus()` auto-approve fences unchanged;
reconcile prose (`CLAUDE.md`, D-004/D-014) and make machine approvals auditable.

**Pattern — stamp provenance at birth, audit at persist:**

1. In `createProposal()`, when `status === 'approved'`, stamp
   `sourceContext.autoApprovalProvenance` (threshold, supervisorMode,
   confidenceScore, undoWindowMs, sourceTrustTier).
2. Wrap `ProposalRepository` with `AuditingProposalRepository` (see
   `packages/api/src/proposals/proposal-persistence.ts`) so `create` /
   `createMany` emit exactly one `proposal.approved` with
   `actorId: auto-approve-policy` and `channel: auto`.

Do **not** emit from every ad-hoc `proposalRepo.create` caller — one decorator
on the repo wired in `app.ts` covers all paths.

### 3. Edit recompute — one helper, every edit channel

Human edits must re-ground catalog prices and re-cap confidence before
(re-)approval. Extract `recomputePricedProposal()` in
`packages/api/src/ai/tasks/recompute-priced-proposal.ts` and use it from:

- `estimate-task.ts` / `invoice-task.ts` (draft path)
- `editProposal()` in `actions.ts` (all channels)

**Thread `catalogRepo` into every `editProposal` caller** — UI
(`routes/proposals.ts`), SMS (`reply-handler.ts`), voice
(`proposal-approval-task.ts`). Missing one channel leaves a stale-confidence
hole on that path.

**Invoice nuance:** catalog may price lines the LLM left price-less; drop
unpriced lines *after* catalog grounding, then rebuild `_meta` from the final
line items (estimate uses `unitPrice`; invoice uses `unitPriceCents` +
`totalCents` — see line-item-price-field convention doc).

**Security test:** edit a catalogued line to an uncatalogued description →
persisted `confidenceScore` ≤ `UNCATALOGUED_CONFIDENCE_CAP` (0.85) < 0.90
auto-approve floor.

### 4. Message proposal expiry — generalize schedule TTL

Do not add a new proposal type or migration. Add `MESSAGE_PROPOSAL_TYPES` and
`isExpirableProposalType() = schedule ∪ message`; reuse `defaultProposalExpiry`,
`proposal-expiry-worker`, and `reproposeProposal` gated on `isExpirableProposalType`.

Initial roster (all pending + time-sensitive): `send_payment_reminder`,
`notify_delay`, `send_estimate_nudge`, `request_feedback`. Exclude persistent
comms (`send_invoice`, `send_estimate`).

### 5. SMS compliance — additive ledger, correct ACH receipt vector

**Premise correction:** `sendCustomerMessage()` already gated on
`customer.smsConsent` + DNC. Full U7 work is *additive*:

- Layer `consent-events` ledger as source of truth via
  `resolveSmsConsentForOutbound()` — single combined decision with the boolean,
  not a second independent block.
- Emit `sms_blocked_by_compliance` audit (`reason: dnc | consent_revoked | no_consent`)
  when SMS is suppressed (gate was silent before).

**ACH receipt gotcha:** `recordProcessingPayment` correctly does **not** send a
receipt at `payment_intent.processing`. The missing receipt was on **settle** —
wire `notifyPaymentReceived` after `settleProcessingPayment` succeeds in the
`payment_intent.succeeded` branch (`webhooks/routes.ts`), not at processing time.

### 6. Voice UX — route-aware dispatch without root provider

`OnboardingShell` is outside `Shell`, so mount `VoiceBar` there for onboarding
mic reachability. Branch `handleSend` on `pathname.startsWith('/onboarding')` →
`useOnboardingVoice` (`POST /api/onboarding/conversation/turn`). Per-route
`VoiceSuggestionsStrip` uses `min-h-11` + `minmax(0, 1fr)` for 320px overflow.

## Why This Matters

Without these patterns, the trust promise ("AI drafts, human commits") is
ambiguous: auto-approve looks like silent execution, edits preserve stale high
confidence, stale message proposals accumulate, and compliance/receipt gaps are
easy to mis-scope.

## When to Apply

- Any spec↔production audit touching proposals, auto-approve, or outbound SMS.
- Adding a new `editProposal` call site — always pass `catalogRepo`.
- Adding a new time-sensitive comms proposal type — evaluate for
  `MESSAGE_PROPOSAL_TYPES`, not a new expiry mechanism.
- Any payment receipt work on ACH — trace processing vs settle webhooks separately.

## Examples

**Auto-approval audit (decorator only on create):**

```typescript
// app.ts
proposalRepo = new AuditingProposalRepository(
  new PgProposalRepository(pool),
  auditRepo,
);
```

**Edit channel parity:**

```typescript
await editProposal(
  proposalRepo, tenantId, proposalId, actorId, 'owner',
  edits, auditRepo, correctionRepo, catalogRepo, // all channels
);
```

**ACH receipt on settle:**

```typescript
if (result.settled && result.payment && deps.paymentReceiptNotifier) {
  await deps.paymentReceiptNotifier.notifyPaymentReceived(
    tenantId, invoiceId, result.payment.amountCents,
  );
}
```

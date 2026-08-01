# fix: Enforce human approval for all voice-originated mutations

**Created:** 2026-07-22  
**Depth:** Deep  
**Status:** plan

## Summary
Browser validation proved an in-app voice command could create and execute a
customer after the caller’s conversational “yes,” without an inbox/SMS/one-tap
human approval. The defect is isolated to `InAppVoiceAdapter`, which sets
`sourceTrustTier: 'autonomous'` on generic capture proposals and omits
supervisor/unsupervised safeguards. This plan makes voice intent confirmation
mean “the system understood” only; authorization remains a deliberate human
approval action.

## Problem Frame
Live QA proof:

1. Voice command created proposal `ebeb64f8-7469-40d6-9e7b-9a3e4cc80582`.
2. The browser showed `QA Browser Validation Customer` persisted.
3. API returned `status: "executed"` with `approvedAt` and `executedAt`.
4. The proposal did not appear in the inbox because it was born `approved`.

This violates the product invariant: all mutations require human approval.
The voice readback confirmation is not an authorization event.

## Requirements
- R1. No in-app, telephony, memo, or assistant voice-originated mutation is
  created in `approved` status solely from an intent-confirmation utterance.
- R2. Voice confirmation may create a `draft` or `ready_for_review` proposal
  only; a subsequent explicit human channel action is required for approval.
- R3. UI inbox, SMS reply/one-tap, and verified voice approval remain the only
  valid approval channels.
- R4. Money, comms, irreversible, identity/CRM, and emergency mutations never
  auto-execute from classifier confidence.
- R5. Existing autonomous booking remains a narrowly documented exception only
  when every lane gate passes and carries undo/audit evidence.
- R6. Every execution has a complete audit chain proving proposal creation,
  explicit approval channel, undo-window handling, and execution.
- R7. Browser acceptance proves voice → draft inbox card → human approve →
  persisted record, with no persisted record before approval.

## Key Technical Decisions
- **Central policy backstop plus path parity** — Add a voice-originated HITL
  guard at `decideInitialStatus()` so future callers cannot reintroduce this
  bug, then remove `sourceTrustTier: 'autonomous'` from in-app generic voice
  mutations or route them through the existing handler registry.
- **Treat `create_customer` as identity-sensitive** — It never receives
  autonomous trust, matching `CreateCustomerVoiceTaskHandler`.
- **Scope auto-approval exception narrowly** — Only autonomous booking lane
  types, with explicit tenant opt-in and all gates, may skip human approval.
  Do not use conversational confirmation as a substitute for a tap/SMS/PIN.
- **Test the user-visible chain** — Handler/unit tests are insufficient. Add
  API/DB audit assertions and a Playwright UI path.

## Scope Boundaries
**In scope:** in-app voice, telephony, memo/router, assistant paths; proposal
creation policy; execution guards; audit and browser/API acceptance evidence.

**Non-goals:** weakening emergency on-call routing; removing the approved
autonomous booking lane; changing entity alias/context features except where
needed to prove a voice proposal safely remains pending.

## Repository invariants touched
- No automation mutates canonical truth without human approval.
- Every mutation emits audit events.
- Proposals remain typed/Zod-validated and tenant-scoped.
- Tenant isolation applies to every status/audit assertion.

## Implementation Units

### U1. Add a central voice human-approval policy guard
- **Goal:** Ensure voice-originated mutation proposals are never born
  `approved` merely because confidence is high.
- **Requirements:** R1–R5
- **Dependencies:** none
- **Files:** `packages/api/src/proposals/proposal.ts`,
  `packages/api/src/proposals/auto-approve.ts`,
  `packages/api/test/proposals/proposal.test.ts`,
  `packages/api/test/proposals/auto-approve.test.ts`
- **Approach:** Carry an explicit source/channel marker into proposal creation.
  Deny `approved` for voice mutation sources unless the existing autonomous
  booking lane evaluation is eligible. Preserve read-only, clarification,
  callback, and emergency behavior.
- **Test scenarios:**
  - All voice mutation proposal types with autonomous/high confidence → draft or
    ready_for_review, never approved.
  - Money/comms/irreversible/identity types remain non-auto-approvable.
  - Eligible autonomous booking retains its explicit exception.
  - Missing fields/low meta confidence always block approval.
- **Verification:** A property-style test loops relevant proposal types and
  proves voice source cannot produce `approved` outside lane exception.

### U2. Align in-app voice proposal creation with shared handler policy
- **Goal:** Remove the divergent in-app `sourceTrustTier: 'autonomous'` path.
- **Requirements:** R1–R4
- **Dependencies:** U1
- **Files:** `packages/api/src/ai/agents/customer-calling/inapp-adapter.ts`,
  `packages/api/src/ai/orchestration/handler-registry.ts`,
  `packages/api/src/ai/tasks/create-customer-task.ts`,
  `packages/api/test/ai/agents/customer-calling/inapp-adapter.test.ts`,
  `packages/api/test/ai/tasks/create-customer-task.test.ts`
- **Approach:** Route identity-sensitive intents through the same dedicated
  task handlers as memo/assistant/telephony or explicitly strip trust tier and
  wire `supervisorPresent=false` as a defense-in-depth fallback. Preserve FSM
  readback behavior but make its output a pending proposal.
- **Test scenarios:**
  - In-app create customer → “yes” → proposal exists but customer row does not.
  - Proposal status is draft/ready_for_review and appears in inbox.
  - Explicit subsequent UI/SMS approval allows execution.
- **Verification:** Reproduce the QA Browser Validation command with no
  customer record before an explicit approval action.

### U3. Pin explicit approval channels and execution timing
- **Goal:** Prove only approved UI/SMS/one-tap/verified voice actions can move
  a voice proposal to execution.
- **Requirements:** R2, R3, R6
- **Dependencies:** U1, U2
- **Files:** `packages/api/src/proposals/actions.ts`,
  `packages/api/src/proposals/lifecycle.ts`,
  `packages/api/src/workers/execution-worker.ts`,
  `packages/api/test/integration/voice-human-approval.test.ts`,
  existing SMS/one-tap/voice-approval tests.
- **Approach:** Add a Docker-gated integration matrix for voice-created
  draft/ready proposals: no execution before explicit approval; undo window
  blocks executor; approved action emits audit with channel; execution commits
  row and audit atomically.
- **Test scenarios:**
  - Inbox approval → approved → execution after undo window.
  - No approval → worker sweep does not execute.
  - Undo before window closes → no execution.
  - Missing fields → approval rejected.
  - System actor approval denied.
- **Verification:** Integration test reads real proposal/data/audit tables.

### U4. Add browser acceptance and audit evidence
- **Goal:** Show the real application behavior, not only API tests.
- **Requirements:** R6, R7
- **Dependencies:** U1–U3
- **Files:** `e2e/voice-human-approval.spec.ts`,
  Clerk test setup/storage state, `docs/verification-runs/`
- **Approach:** Use a dedicated Clerk QA session and clearly named QA entity:
  voice command → confirmation → pending inbox card → screenshot/video → UI
  approve → undo window → persisted record → audit/inbox status. Do not
  approve unrelated proposals.
- **Test scenarios:**
  - Draft present and customer absent before approval.
  - UI approve updates status and record appears only after execution.
  - Emergency path records callback/on-call, not auto-executed mutation.
- **Verification:** Saved browser video/screenshots plus API/audit artifact.

## Risks & Dependencies
- Existing capture auto-approve behavior may have intentional supervised use
  cases. This plan preserves the explicit autonomous booking exception and
  makes any remaining exceptions deliberate, tested policy entries.
- Browser proof requires a Clerk testing token or dedicated QA test session.
- Because this is a canonical mutation guard, all code paths must be reviewed
  for source/channel metadata completeness before release.

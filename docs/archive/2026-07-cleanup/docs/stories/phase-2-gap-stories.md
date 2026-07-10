# Phase 2 — Proposal Engine + AI Safety: Launch Readiness Gaps

> **4 stories** | Continues from P2-031

---

## Purpose

The proposal engine and AI gateway are well-built on the backend. The gap is connecting the frontend to the real AI pipeline instead of demo data.

## Exit Criteria

Frontend proposal generation calls the real AI gateway; dispatchers receive real-time awareness of new proposals.

## Gap Summary

| ID | Title | Size | Layer | AI Build | Human Review | Dependencies |
|----|-------|------|-------|----------|--------------|-------------|
| P2-032 | Wire frontend proposal generation to backend AI gateway | S | AI/UI | Medium | Heavy | P0-023, P0-029, P0-030, P2-007 |
| P2-033 | Proposal notification and inbox refresh | S | UI | High | Moderate | P2-004, P0-032 |

---

## Story Specifications

### P2-032 — Wire frontend proposal generation to backend AI gateway

> **Size:** S | **Layer:** AI/UI | **AI Build:** Medium | **Human Review:** Heavy

**Dependencies:** P0-023, P0-029, P0-030, P2-007

**Allowed files:** `packages/web/src/components/assistant/**, packages/web/src/hooks/**, packages/api/src/routes/**`

**Build prompt:** The `AssistantPage` (and `ConversationalIntake`) currently use a hardcoded `AI_REPLIES` dictionary to simulate AI responses. Replace this with real API calls to the backend AI orchestration endpoints. When a user sends a message: (1) POST to `/api/conversations/:id/messages` with the message content. (2) The backend routes the message through the AI task orchestrator. (3) The AI gateway generates a proposal (or clarification request). (4) The frontend polls or receives the response and renders it inline. Replace all keyword-matching reply logic with real API responses. Keep the existing UI components (ProposalCard, ClarificationCard) — they already handle the right data shapes.

**Review prompt:** Verify all hardcoded `AI_REPLIES` references are removed. Verify the frontend calls real API endpoints. Verify loading states while waiting for AI response. Verify error handling if AI gateway is unavailable. Verify clarification requests are rendered and respondable. Check that conversation context (customer, job) is passed to the API.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P2-032"
grep -r "AI_REPLIES" packages/web/src/ | wc -l  # Should be 0
```

**Required tests:**
- [ ] Happy path — message sent, real AI response rendered
- [ ] Loading state — spinner shown while AI processes
- [ ] Error state — network failure shows error toast, not fake reply
- [ ] Clarification — AI requests clarification, user can respond
- [ ] Proposal — AI generates proposal card with approve/reject actions
- [ ] Context — customer and job info sent with message

---

### P2-033 — Proposal notification and inbox refresh

> **Size:** S | **Layer:** UI | **AI Build:** High | **Human Review:** Moderate

**Dependencies:** P2-004, P0-032

**Allowed files:** `packages/web/src/components/layout/**, packages/web/src/hooks/**`

**Build prompt:** Add a notification indicator in the Shell navigation that shows a count of pending proposals requiring review. Poll `GET /api/proposals?status=ready_for_review` every 30 seconds (or use server-sent events if available). When a new proposal is generated from a conversation, show a toast notification with a link to the proposal detail. The proposal list view should auto-refresh when navigated to. Badge count should update in real time as proposals are approved/rejected.

**Review prompt:** Verify polling interval is reasonable (not too aggressive). Verify badge count resets when proposals are actioned. Verify toast links navigate to the correct proposal. Check that polling stops when the tab is inactive (visibility API).

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P2-033"
```

**Required tests:**
- [ ] Badge count — shows correct number of pending proposals
- [ ] Auto-refresh — new proposal appears without manual refresh
- [ ] Toast — new proposal notification links to detail
- [ ] Tab inactive — polling paused when tab hidden
- [ ] Action — badge count decrements after approval

---

### P2-034 — Inbound SMS content dispatcher

> **Size:** S | **Layer:** SMS | **AI Build:** High | **Human Review:** Heavy | **Wave:** Wave-C blocker B3

**Dependencies:** P0-014, P7-001

**Allowed files:** `packages/api/src/sms/inbound-dispatch.ts`, `packages/api/src/webhooks/routes.ts`

**Build prompt:** The Twilio inbound-SMS webhook at `packages/api/src/webhooks/routes.ts` (the `recordTwilio('sms')` arm of `POST /twilio/sms/:tenantId`) today verifies the Twilio signature, records the receipt for idempotency, and returns 200. The message body is never parsed and there is no dispatch surface for downstream features (P6-028 tech-status keywords first, future stories second). Create `packages/api/src/sms/inbound-dispatch.ts` exporting: (1) a `KeywordHandler` interface `{keywords: readonly string[]; handle(ctx: InboundSmsContext): Promise<HandlerResult>}`; (2) a `registerKeywordHandler(handler)` function; (3) `dispatchInboundSms({tenantId, fromE164, body, messageSid}): Promise<{handled: boolean, handler?: string, reason?: string}>` that case-insensitively matches the first whitespace-trimmed token of `body` against registered keywords. Modify `webhooks/routes.ts` to call `dispatchInboundSms` after `markProcessed` succeeds. The dispatcher must not throw — failed handlers log/audit and return `{handled: false, reason: 'handler_error'}` so Twilio never sees a 500. Unmatched messages return `{handled: false, reason: 'no_matching_handler'}` and are audited but not 5xx'd.

**Review prompt:** Verify the dispatcher is invoked only AFTER `markProcessed` so duplicates short-circuit before dispatch. Verify signature verification is unaffected — the existing flow remains the first gate. Verify two handlers cannot register the same keyword (registration throws). Verify the dispatcher is concurrency-safe (a registry that's mutated only at module-init time is sufficient — but assert it). Confirm no handler can crash the webhook 500.

**Automated checks:**
```bash
cd packages/api && npx tsc --project tsconfig.build.json --noEmit
cd packages/api && npm test -- --grep "P2-034"
```

**Required tests:**
- [ ] Keyword router: `OUT` (case-insensitive, trimmed) routes to a registered handler
- [ ] Unmatched keyword returns `{handled: false}` without throwing
- [ ] Handler that throws is caught and audited; webhook still returns 200
- [ ] Duplicate keyword registration throws at module-init time
- [ ] Existing signature + idempotency path stays green
- [ ] Cross-tenant isolation — handler invocation includes `tenantId` and `fromE164` only

---

### P2-035 — Batch proposal approval (APPROVE ALL)

> **Size:** S | **Layer:** Proposals/API | **AI Build:** High | **Human Review:** Heavy | **Wave:** Wave-C blocker B2

**Dependencies:** P2-002

**Allowed files:** `packages/api/src/proposals/actions.ts`, `packages/api/src/routes/proposals.ts`

**Build prompt:** Today proposals are approved one at a time via POST `/api/proposals/:id/approve` (see `packages/api/src/routes/proposals.ts`). P6-028's "tech goes out, four customers need rescheduling" scenario requires the owner to APPROVE ALL in one tap. Add `approveProposalsBatch(proposalRepo, tenantId, proposalIds: string[], actorId, actorRole, auditRepo): Promise<{approved: string[], failed: {id: string, reason: string}[]}>` in `packages/api/src/proposals/actions.ts`. It iterates the IDs (no transaction across proposals — partial success is the desired outcome) and delegates each to the existing `approveProposal()`. Add POST `/api/proposals/approve-batch` in `routes/proposals.ts` accepting `{proposalIds: string[]}` (Zod-validated, max 50 IDs to bound blast radius), enforcing the same RBAC as the singular endpoint, and emitting one audit event per approved proposal (do NOT collapse to a single batch audit — the singular events are what downstream consumers index). The 3+ threshold for showing the APPROVE ALL affordance is client-side, not a server constraint.

**Review prompt:** Verify partial-success semantics: one stale/rejected ID does not block the rest. Verify RBAC is enforced per proposal (not just at the route boundary). Verify the audit trail still has one event per approval. Verify the 50-ID cap is enforced and surfaces a clear validation error. Confirm `approveProposal` is reused — no duplicated approval logic.

**Automated checks:**
```bash
cd packages/api && npx tsc --project tsconfig.build.json --noEmit
cd packages/api && npm test -- --grep "P2-035"
```

**Required tests:**
- [ ] Happy path — 5 proposals, all approved, 5 audit events
- [ ] Partial failure — one ID has wrong status; others succeed; failed reports `{id, reason}`
- [ ] Empty array → 400
- [ ] Over 50 IDs → 400
- [ ] Non-owner role → 403 (per-proposal RBAC enforced)
- [ ] Cross-tenant ID in the batch → that ID returns `failed` with reason `not_found` (does NOT 500)

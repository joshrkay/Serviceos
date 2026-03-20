# Phase 2 — Proposal Engine + AI Safety: Launch Readiness Gaps

> **2 stories** | Continues from P2-031

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

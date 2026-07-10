# Phase 3 — Conversation + Voice Experience: Launch Readiness Gaps

> **4 stories** | Continues from P3-015

---

## Purpose

The conversation and voice UI components exist but are connected to mock data. Close the gap by wiring them to the real backend AI gateway, STT pipeline, and proposal orchestration.

## Exit Criteria

Voice recordings produce real transcripts; conversation messages trigger real AI proposals; proposal trigger modes work end-to-end; conversation state persists through page navigation.

## Gap Summary

| ID | Title | Size | Layer | AI Build | Human Review | Dependencies |
|----|-------|------|-------|----------|--------------|-------------|
| P3-016 | Connect AssistantPage to backend AI conversation endpoints | S | Conversation UI | Medium | Heavy | P0-027, P2-032, P3-001 |
| P3-017 | Connect voice capture to real STT endpoint | S | Voice UI | Medium | Heavy | P0-027, P3-002 |
| P3-018 | Wire proposal trigger modes to real AI orchestration | S | Orchestration UX | Medium | Moderate | P2-032, P3-010 |
| P3-019 | Conversation state persistence across navigation | S | Reliability | High | Moderate | P0-021, P3-001 |

---

## Story Specifications

### P3-016 — Connect AssistantPage to backend AI conversation endpoints

> **Size:** S | **Layer:** Conversation UI | **AI Build:** Medium | **Human Review:** Heavy

**Dependencies:** P0-027, P2-032, P3-001

**Allowed files:** `packages/web/src/components/assistant/**, packages/web/src/pages/dispatcher/**`

**Build prompt:** Replace all hardcoded AI behavior in AssistantPage.tsx and ConversationalIntake.tsx. Currently: (1) `AI_REPLIES` dict (lines 57-153) maps keywords to fake responses. (2) Voice recorder selects from 4 hardcoded transcript strings (lines 373-390). (3) Confidence scores are fake random numbers. (4) Suggestion chips are static arrays. Replace with: (1) Real message send via `POST /api/conversations/:id/messages`. (2) Real AI response from the backend conversation flow. (3) Real confidence scores from AI guardrails. (4) Dynamic suggestion chips based on conversation context. Keep the existing UI layout — only replace data sources.

**Review prompt:** Verify ALL hardcoded reply banks are removed. Verify the 4 mock transcript strings are removed. Verify fake confidence scores are removed. Verify the conversation creates a real backend conversation record. Check that the existing ProposalCard/ClarificationCard components receive real data shapes from the API.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P3-016"
grep -r "AI_REPLIES" packages/web/src/ | wc -l  # Should be 0
grep -r "mock.*transcript" packages/web/src/components/assistant/ | wc -l  # Should be 0
```

**Required tests:**
- [ ] Happy path — send message, receive real AI response
- [ ] Voice message — recording sent to STT, transcript used as message
- [ ] Proposal generated — AI response includes proposal card
- [ ] Clarification — AI requests clarification, renders correctly
- [ ] Error handling — AI gateway timeout shows retry option
- [ ] Conversation persistence — messages survive page refresh

---

### P3-017 — Connect voice capture to real STT endpoint

> **Size:** S | **Layer:** Voice UI | **AI Build:** Medium | **Human Review:** Heavy

**Dependencies:** P0-027, P3-002

**Allowed files:** `packages/web/src/components/voice/**, packages/web/src/components/shared/VoiceBar.tsx, packages/web/src/hooks/**`

**Build prompt:** The VoiceRecorder and VoiceBar components currently capture audio but return mock transcriptions. Wire them to the real STT endpoint: (1) After recording stops, upload the audio blob to `POST /api/voice/transcribe` (multipart form data). (2) Show a "Transcribing..." status while waiting. (3) Render the real transcript when it returns. (4) Allow the user to edit the transcript before sending as a message (TranscriptEditor already supports this). Handle microphone permission denial gracefully. Support the existing voice update workflow for technicians (VoiceUpdate.tsx).

**Review prompt:** Verify audio is uploaded as multipart, not base64 encoded. Verify the mock transcript selection is removed. Verify transcription status is shown (recording → uploading → transcribing → ready). Verify microphone permission denial shows a clear message. Check audio format compatibility (WebM from MediaRecorder is standard).

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P3-017"
```

**Required tests:**
- [ ] Happy path — record audio, upload, receive real transcript
- [ ] Status flow — recording → uploading → transcribing → ready
- [ ] Edit transcript — user can modify before sending
- [ ] Mic denied — clear error message, no crash
- [ ] Network error — upload failure shows retry option
- [ ] Large recording — 60-second recording uploads successfully

---

### P3-018 — Wire proposal trigger modes to real AI orchestration

> **Size:** S | **Layer:** Orchestration UX | **AI Build:** Medium | **Human Review:** Moderate

**Dependencies:** P2-032, P3-010

**Allowed files:** `packages/web/src/components/assistant/**, packages/web/src/pages/dispatcher/**, packages/api/src/ai/orchestration/**`

**Build prompt:** P3-010 defines proposal trigger modes: automatic (AI generates proposal after voice update), user-triggered (dispatcher explicitly requests a proposal), and hybrid. Wire these modes to the real AI orchestration layer. For automatic mode: after a technician voice update is transcribed, the backend should automatically generate an estimate or invoice proposal. For user-triggered mode: add a "Generate Proposal" button in the conversation UI that explicitly calls the AI task orchestrator. The trigger mode should be configurable in tenant settings.

**Review prompt:** Verify automatic triggers fire after transcription completes. Verify user-triggered mode requires explicit button press. Verify the trigger mode is read from tenant settings. Check that automatic mode doesn't generate proposals for every message — only after substantive voice updates.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P3-018"
```

**Required tests:**
- [ ] Automatic — voice update triggers proposal generation
- [ ] User-triggered — proposal generated only on button press
- [ ] Setting — trigger mode configurable per tenant
- [ ] Guard — trivial messages don't trigger automatic proposals
- [ ] Loading — UI shows generation progress

---

### P3-019 — Conversation state persistence across navigation

> **Size:** S | **Layer:** Reliability | **AI Build:** High | **Human Review:** Moderate

**Dependencies:** P0-021, P3-001

**Allowed files:** `packages/web/src/components/conversations/**, packages/web/src/hooks/**`

**Build prompt:** Currently, navigating away from a conversation and back may lose draft messages and scroll position. Fix by: (1) Persisting draft messages in a lightweight client-side store (localStorage or React state manager). (2) Saving scroll position when navigating away. (3) Restoring conversation state when navigating back. (4) Showing unread message indicators for conversations with new messages. All actual conversation data should load from the API — only ephemeral UI state (drafts, scroll) is cached locally.

**Review prompt:** Verify draft messages persist across navigation. Verify scroll position is restored. Verify stale data is refreshed from API on return. Verify localStorage cleanup (drafts removed after sending). Check that this doesn't introduce memory leaks for long-running sessions.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P3-019"
```

**Required tests:**
- [ ] Draft persistence — draft message survives navigation
- [ ] Scroll restore — returns to previous scroll position
- [ ] Data freshness — new messages loaded on return
- [ ] Cleanup — sent draft removed from localStorage
- [ ] Unread indicator — badge shows for conversations with new messages

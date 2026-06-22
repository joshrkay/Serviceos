# feat: Conversational AI Core (Epic 3) — The Brain

**Created:** 2026-06-22
**Depth:** Deep
**Status:** plan

> **Audit note (read first):** Epic 3 is **already implemented and CI-green on
> PR #611** (branch `claude/brave-hopper-7sdk79`). This document is the
> retroactive, durable implementation plan for all 12 stories, with a per-unit
> **Status** line recording what shipped vs. what remains. Use it to re-verify
> coverage and to drive the small deferred follow-ups via `/ce-work`. Each unit
> cites repo-relative source **and** test paths so coverage is auditable.

## Summary
Build the shared conversational agent runtime — one persistent thread where a
contractor speaks or types, a single combined classify+extract call interprets
intent, and an inline proposal card appears for one-tap approve/edit/reject.
Every state-changing action is a Zod-typed proposal a human approves; nothing
auto-executes. This loop is the substrate every other epic plugs into.

## Problem Frame
The contractor needs one place to run the business by voice or text. Without a
single agent loop, each capability (estimates, invoices, scheduling) would grow
its own ad-hoc input path, intent handling, and confirmation UX — inconsistent,
unsafe (silent writes), and impossible to improve centrally. Epic 3 centralizes
input → interpretation → proposal → human approval → deterministic execution,
and the learning signal (corrections) that improves it over time.

## Requirements
- **R1 (3.1)** A persistent conversation thread shows the contractor's messages,
  agent replies, and proposal cards inline; it persists to the conversations/
  messages tables and is surfaced prominently on HomePage.
- **R2 (3.2)** Voice dictation streams mic → Deepgram Nova-3 over WebSocket using
  a short-TTL (30s) grant token (never a long-lived key in the browser); partial
  transcripts render live and the final transcript feeds the agent.
- **R3 (3.3)** A single Claude call returns intent + structured fields, sub-3s
  p50, validated against a schema before a card is built.
- **R4 (3.4)** A versioned intent taxonomy covers add customer, schedule job,
  build estimate, create invoice, record payment, send message, log inventory,
  ask a question; unknown intent triggers a clarifying question, never a silent
  guess.
- **R5 (3.5)** Every state-changing intent produces a proposal card (entity,
  fields, exact action) — never an immediate write.
- **R6 (3.6)** Cards render inline at the point of request; card state
  (pending/approved/edited/expired) is visible; approved cards collapse to a
  compact confirmed state.
- **R7 (3.7)** Approve writes the entity; edit opens fields inline and
  re-validates before writing; reject discards with an optional reason.
- **R8 (3.8)** The agent asks only for required fields it could not extract;
  once fields are complete it proposes immediately.
- **R9 (3.9)** Each edit a user makes to a proposal writes a row to a Corrections
  table (field, before, after, intent), queryable per tenant and per intent, to
  feed prompt/routing improvement.
- **R10 (3.10)** ~60–70% of turns route to a lighter model; complex reasoning
  routes to Sonnet; routing decision + model are logged.
- **R11 (3.11)** The full thread persists with timestamps and linked entities;
  history is searchable by customer, job, or text; linked cards deep-link to the
  created entity.
- **R12 (3.12)** Low-confidence extractions become clarifying questions;
  tool/model failures show a retry and never a silent partial write; errors are
  logged with correlation IDs.

## Key Technical Decisions
- **Single shared agent loop, not per-feature flows** — every capability emits a
  typed proposal into one thread. Rationale: consistency + one place to improve.
- **Proposal-first, human-approved; deterministic services execute** — AI never
  writes business state directly. Rationale: the core safety invariant; an LLM
  mis-extraction can never silently mutate tenant data.
- **All model calls go through the LLM gateway** (`packages/api/src/ai/gateway`)
  — never a provider SDK directly. Rationale: caching, cost/latency accounting,
  tiered routing, correlation IDs, cassette testing.
- **Deepgram browser auth via a 30s grant token minted server-side**, passed on
  the WebSocket `bearer` subprotocol — the long-lived `DEEPGRAM_API_KEY` stays on
  the server. Rationale: browsers can't set WS Authorization headers and a
  long-lived key must never reach the client. (Alternative: proxy audio through
  our server — rejected: added latency + server bandwidth for no security gain
  over a short-TTL token.)
- **Corrections (raw per-edit log) is distinct from `correction_lessons`** — the
  latter (migration 185) records conservative, cascading *config* lessons only on
  succeeded execution, keyed by day/source-proposal; it is **not** queryable per
  intent and does not capture every edit. R9 needs the unfiltered per-field
  training signal, so a new `corrections` table is correct, not a rebuild.
  (Alternative: extend `correction_lessons` — rejected: different grain, gate,
  and query axis.)
- **HomePage keeps the dashboard and adds the thread as a prominent panel** (not
  a full-screen replacement) — product decision. The panel hands off to the
  persistent `/assistant` thread via its existing `?q=` auto-submit param so a
  message started on Home continues the same persisted conversation, keeping the
  approve/edit/reject card engine in one place.
- **`log_inventory` maps to `log_expense`** — the product has no inventory
  domain; material/stock intake is recorded as an expense (category `materials`)
  via a deterministic phrasing matcher, so the taxonomy "covers" it without dead,
  unwired code. (Product decision, confirmed.)
- **Client-pinned conversation id for assistant persistence** — the chat request
  carries an optional `conversationId`; the server get-or-creates and echoes it,
  so turns append to one thread and survive reload, without a server-side
  "find the user's open thread" query.

## Scope Boundaries
**In scope:** `packages/api/src/{ai,conversations,proposals}/**`, the
conversation-thread surfaces in `packages/web/**`, and proposal contracts in
`packages/shared/**`. Reconciling the assistant/conversations route layer
(`packages/api/src/routes/{assistant,conversations}.ts`) where persistence /
search / correlation IDs are wired.

**Non-goals:** bypassing the LLM gateway; any auto-executing AI path; rebuilding
the proposal engine, gateway, or model router (audit & close gaps only); building
an inventory domain; native VoIP/telephony (separate epic).

### Deferred to follow-up work
- **U9-followup:** wrap `recordAssistantTurn`'s create-conversation + add-message
  writes in a single transaction (today a partial failure can leave an empty
  conversation; benign — it never surfaces, inbox requires ≥1 message — and the
  route persists failure-soft). Needs a repo-level transaction primitive across
  the `ConversationRepository` interface.
- **U3/U10 SLO assertions:** the sub-3s p50 (R3) and ~60–70% lighter-model ratio
  (R10) are instrumented/logged but not pinned by an enforced threshold test; add
  a metrics-backed assertion if these become regression-prone.

## Repository invariants touched
- **Integer cents** — corrections `before/after` ride as JSONB; integer cents
  round-trip losslessly (no float coercion). Proposal money stays cents.
- **tenant_id + FORCE RLS** — new `corrections` table (migration 207) is
  tenant-scoped with FORCE RLS and a cross-tenant isolation integration test;
  conversations/messages already RLS'd; `searchMessages` filters by tenant_id as
  the first predicate alongside RLS.
- **Audit events** — proposal approve/edit/reject/undo emit audit events; the
  assistant turn persists through the audited conversation create path.
- **LLM gateway** — classify+extract, the fallback assistant reply, and tiered
  routing all go through `packages/api/src/ai/gateway`; no provider SDK on the
  hot path. Correlation IDs flow into gateway + route error logs.
- **Zod proposals / human-approval gate** — every state-changing intent yields a
  Zod-validated proposal; `editProposal` re-validates the merged payload; nothing
  executes without approval.
- **Catalog/entity resolvers** — AI-drafted line items remain grounded via the
  catalog resolver; voice free-text refs resolve via the entity resolver with
  one-tap `voice_clarification` on ambiguity (unchanged by this epic).

## High-Level Technical Design
```
 mic/text ─► [Web thread]                         [API]
   │           AssistantPage / HomeConversationPanel
   │              │ POST /api/assistant/chat {messages, conversationId}
   │              ▼
   │        classifyIntent (1 call, gateway) ──► tiered model router
   │              │  intent + fields (+ taxonomyVersion)
   │              ▼
   │        recognized state-changing intent ──► task handler ──► Zod proposal (status: draft/ready)
   │              │                                                   │ persist (proposal repo)
   │              ▼                                                   ▼
   │        unknown / low-conf / missing field ──► clarifying question (no write)
   │
   └─◄ inline proposal card (pending) ──► approve | edit | reject
                                            │ approve → deterministic executor writes entity + audit
                                            │ edit → re-validate → write; log per-field corrections
                                            └ reject → discard (+ reason)
 persistence: conversations + messages (timestamps, linked entity); searchable; cards deep-link
 learning: corrections (raw per-edit) feeds prompt/routing; correction_lessons cascades config
```

## Implementation Units

### U1. Conversation thread UI + HomePage panel (Story 3.1)
- **Status:** SHIPPED (PR #611). HomePage panel added; persistence wired in U11.
- **Goal:** One persistent thread showing messages, agent replies, and inline
  proposal cards; prominent on HomePage.
- **Requirements:** R1. **Dependencies:** U5–U7 (cards), U11 (persistence).
- **Files:** `packages/web/src/components/assistant/AssistantPage.tsx`;
  `packages/web/src/components/home/HomeConversationPanel.tsx`;
  `packages/web/src/components/home/HomePage.tsx`;
  `packages/web/src/pages/conversations/ConversationThread.tsx`.
  Tests: `packages/web/src/components/home/HomeConversationPanel.test.tsx`.
- **Approach:** AssistantPage is the persistent thread (renders messages +
  `AIProposalCard`). HomeConversationPanel previews recent turns and hands off to
  `/assistant?q=…` (existing auto-submit) so Home continues the same thread; the
  approve/edit/reject engine lives only in AssistantPage. Lazy `useState` for the
  `localStorage` conversation-id read (no render-time I/O).
- **Patterns to follow:** existing HomePage card sections; `useDetailQuery`.
- **Test scenarios:** empty state with no conversation; preview renders
  user+agent turns; composer hands off to `/assistant?q=`; Enter submits /
  Shift+Enter doesn't; ≥44px tap targets (size-11 / min-h-11) class contract.
- **Verification:** Home shows the conversation panel; a typed/dictated message
  continues the persisted `/assistant` thread; panel tests green.

### U2. Voice dictation → Deepgram Nova-3 (Story 3.2)
- **Status:** SHIPPED (PR #611).
- **Goal:** Mic → Deepgram Nova-3 over WebSocket with a 30s grant token; live
  partials; final transcript feeds the agent.
- **Requirements:** R2. **Dependencies:** U1.
- **Files:** `packages/web/src/hooks/useDeepgramDictation.ts`;
  `packages/api/src/voice/deepgram-token.ts`; the `/api/voice/stream-token`
  route; consumed by `HomeConversationPanel.tsx` (mic control).
  Tests: `packages/web/src/hooks/useDeepgramDictation.test.ts`;
  `packages/api/test/voice/deepgram-token.test.ts`.
- **Approach:** server mints a short-TTL Deepgram grant token (long-lived key
  stays server-side); browser opens `wss://api.deepgram.com/v1/listen` with the
  token on the `bearer` subprotocol; MediaRecorder webm/opus chunks stream up;
  interim results update `partial` live, finals accumulate and deliver on stop.
  Token mint wraps `res.json()` in try/catch → typed `DeepgramTokenMintError`;
  hook keeps `onPartial/onFinal` in refs to avoid `start/stop` identity churn.
- **Patterns to follow:** existing `transcription-providers.ts` Deepgram
  streaming (telephony path); 503 when no key configured.
- **Test scenarios:** token mint success/missing-key(503)/non-JSON body; hook
  feature-detection unsupported; start/stop toggles; partial → composer; mic
  permission error surfaced (never silent).
- **Verification:** dictation streams live partials into the composer; no
  long-lived key in any browser payload; tests green.

### U3. Combined classify + extract (Story 3.3)
- **Status:** SHIPPED (pre-existing; audited). SLO test deferred.
- **Goal:** One gateway call returns intent + structured fields, schema-validated
  before a card is built, sub-3s p50.
- **Requirements:** R3. **Dependencies:** U10 (router), gateway.
- **Files:** `packages/api/src/ai/orchestration/intent-classifier.ts` (+ its
  `ClassifyContext`, `parseClassifierJson`). Tests:
  `packages/api/test/ai/orchestration/intent-classifier.test.ts`.
- **Approach:** `classifyIntent` composes system prompt (+ optional gated context
  sections) and calls the gateway once with `responseFormat:'json'`;
  `parseClassifierJson` validates the shape; low-confidence → unknown.
- **Patterns to follow:** existing gateway `complete` usage; gated prompt-section
  appends (RV-071 pattern) to keep cassette/cache keys stable.
- **Test scenarios:** well-formed parse; invalid JSON → null; unsupported intent
  → null; confidence threshold → unknown; token-usage surfaced.
- **Verification:** one call yields validated intent+fields; classifier suite
  green. *(Deferred: an explicit p50<3s metrics assertion.)*

### U4. Versioned intent taxonomy (Story 3.4)
- **Status:** SHIPPED (PR #611) — `INTENT_TAXONOMY_VERSION` + `log_inventory`→
  `log_expense` mapping.
- **Goal:** Versioned taxonomy covering the eight required intents; unknown →
  clarifying question.
- **Requirements:** R4. **Dependencies:** U3.
- **Files:** `packages/api/src/ai/orchestration/intent-classifier.ts`
  (`IntentType`, `SUPPORTED_INTENTS`, `INTENT_TAXONOMY_VERSION`,
  `isInventoryLoggingPhrasing`). Tests:
  `packages/api/test/ai/orchestration/intent-classifier.test.ts`.
- **Approach:** stamp `taxonomyVersion` on every classification at one wrapper
  choke point (covers all return paths) — no prompt-byte change. Inventory
  logging phrasings map deterministically to `log_expense` (category materials),
  preserving any LLM-extracted amount; the result is a draft proposal a human
  approves.
- **Patterns to follow:** existing `isCreateCustomerSignupPhrasing` deterministic
  matcher; bump-on-change doc policy in the version comment.
- **Test scenarios:** semver-shaped version; stamped on success / empty-transcript
  short-circuit / low-confidence path; inventory phrasing → log_expense; stock
  *query* not treated as logging; genuine log_expense untouched.
- **Verification:** taxonomy versioned + covers all eight; unknown → clarify;
  suite green.

### U5. Proposal card generation (Story 3.5)
- **Status:** SHIPPED (pre-existing engine; audited — not rebuilt).
- **Goal:** Every state-changing intent yields a Zod proposal (entity, fields,
  exact action), never an immediate write.
- **Requirements:** R5. **Dependencies:** U3/U4.
- **Files:** `packages/api/src/proposals/proposal.ts` (`createProposal`,
  `decideInitialStatus`); `packages/api/src/proposals/contracts.ts`
  (`validateProposalPayload`); `packages/shared/src/contracts/proposal*.ts`.
  Tests: `packages/api/test/proposals/*.test.ts`,
  `packages/shared/src/contracts/*proposal*.test.ts`.
- **Approach:** task handlers build typed payloads; `createProposal` returns an
  in-memory object (no write) whose status (draft/ready_for_review/approved) is
  decided by trust tier + confidence; persistence is an explicit repo call.
- **Patterns to follow:** existing 40+ proposal types + Zod contracts.
- **Test scenarios:** state-changing intent → proposal not write; payload
  Zod-validated; uncatalogued line caps confidence below auto-approve.
- **Verification:** no write occurs before approval; contract tests green.

### U6. Inline cards with visible state (Story 3.6)
- **Status:** SHIPPED (pre-existing; audited).
- **Goal:** Cards render inline; state (pending/approved/edited/expired) visible;
  approved collapses to compact confirmed.
- **Requirements:** R6. **Dependencies:** U5.
- **Files:** `packages/web/src/components/shared/AIProposalCard.tsx`;
  `packages/web/src/components/conversations/ProposalCard.tsx`. Tests:
  `packages/web/src/components/conversations/ProposalCard.test.tsx`.
- **Approach:** card renders by status; approved → compact green confirmed row
  with optional deep-link (U11); rejected → collapsed dismissed row.
- **Patterns to follow:** existing `AIProposalCard` status switch.
- **Test scenarios:** pending full card; approved compact; rejected collapsed;
  status badge reflects payload status.
- **Verification:** inline cards show correct state transitions.

### U7. Approve / edit / reject (Story 3.7)
- **Status:** SHIPPED (pre-existing backend + UI; corrections wired in U9).
- **Goal:** Approve writes the entity; edit re-validates then writes; reject
  discards with optional reason.
- **Requirements:** R7. **Dependencies:** U5/U6.
- **Files:** `packages/api/src/proposals/actions.ts`
  (`approveProposal`/`editProposal`/`rejectProposal`/`undoProposal`);
  `packages/api/src/routes/proposals.ts`;
  `packages/web/src/components/shared/AIProposalCard.tsx`. Tests:
  `packages/api/test/proposals/actions.test.ts`.
- **Approach:** approve transitions + executes via deterministic handler + audit;
  edit merges delta, `validateProposalPayload`, writes, audits edited fields;
  reject stores reason/details + audit; all RBAC-gated; edit only from
  draft/ready_for_review.
- **Patterns to follow:** existing action helpers + RBAC + `logProposalEvent`.
- **Test scenarios:** approve happy/RBAC-deny; edit validates against contract +
  tracks changed fields; reject stores reason; cannot edit non-draft.
- **Verification:** the three actions behave per AC; actions suite green.

### U8. Clarifying questions, missing-field only (Story 3.8)
- **Status:** SHIPPED (pre-existing; audited).
- **Goal:** Ask only for required fields that couldn't be extracted; once
  complete, propose immediately.
- **Requirements:** R8. **Dependencies:** U3/U5.
- **Files:** `packages/api/src/proposals/proposal.ts` (`missingFieldsFor`);
  `packages/api/src/ai/clarification/**`,
  `packages/api/src/conversations/clarification.ts`. Tests:
  `packages/api/test/conversations/clarification.test.ts`.
- **Approach:** missing required fields force `draft` and emit a clarifying
  prompt for exactly those fields; chain-ref fields excluded (resolve at exec);
  when complete, the proposal is offered without further back-and-forth.
- **Test scenarios:** missing required field → clarify only that field; complete
  payload → immediate proposal; chain-ref not treated as missing.
- **Verification:** no interrogation beyond missing required fields.

### U9. Correction capture (Story 3.9)
- **Status:** SHIPPED (PR #611) — `corrections` table (migration 207). Tx
  deferred (see Deferred to follow-up).
- **Goal:** Each edit writes a row (field, before, after, intent), queryable per
  tenant and per intent.
- **Requirements:** R9. **Dependencies:** U7.
- **Files:** `packages/api/src/db/schema.ts` (migration `207_create_corrections`);
  `packages/api/src/proposals/corrections/correction.ts` (pure
  `computeCorrections` + in-memory repo); `.../corrections/pg-correction.ts`;
  wired in `packages/api/src/proposals/actions.ts` (`editProposal`); constructed
  in `packages/api/src/app.ts`, threaded via `routes/proposals.ts`. Tests:
  `packages/api/test/proposals/corrections.test.ts`;
  `packages/api/test/integration/corrections.test.ts` (Docker-gated: real
  columns, per-intent query, FORCE RLS isolation).
- **Approach:** `computeCorrections` emits one row per genuinely-changed field
  (no-op/deep-equal yield nothing); `intent` = proposal type. Capture wired into
  `editProposal` (the single function all three edit UIs funnel through),
  failure-soft (payload already written). Pg `recordMany` sends the batch as one
  jsonb param expanded via `jsonb_array_elements` (never `jsonb[]` bind params);
  `parseJsonb` returns node-pg's already-parsed value (no double-parse).
- **Patterns to follow:** `learning/corrections/pg-correction-lesson.ts` (RLS +
  withTenant); migration-immutability snapshot discipline.
- **Test scenarios:** one row per changed field, before/after captured; no-op
  edit → nothing; queryable per tenant + per intent; integration pins real
  columns + cross-tenant isolation; failure-soft (capture error never breaks the
  edit).
- **Verification:** edits log per-field corrections; integration green in CI.

### U10. Tiered model routing (Story 3.10)
- **Status:** SHIPPED (pre-existing; audited). Ratio assertion deferred.
- **Goal:** Route easy turns to a lighter model; complex reasoning → Sonnet; log
  the routing decision + model.
- **Requirements:** R10. **Dependencies:** gateway.
- **Files:** `packages/api/src/ai/gateway/router.ts`,
  `packages/api/src/ai/gateway/routing-config.ts`. Tests:
  `packages/api/test/ai/gateway-model-routing.test.ts`,
  `packages/api/test/ai/gateway-router.test.ts`.
- **Approach:** per-task tier selection with the lighter model as default and an
  escalation path to Sonnet for complex reasoning; the chosen model + decision
  are logged for observability.
- **Test scenarios:** light-tier task → light model; complex task → Sonnet;
  routing decision logged. *(Deferred: an enforced ~60–70% ratio assertion.)*
- **Verification:** routing suite green; logs carry model + decision.

### U11. Conversation persistence, history & search (Story 3.11)
- **Status:** SHIPPED (PR #611) — persistence + `/search` endpoint + deep-links +
  inbox search UI.
- **Goal:** Full thread persists (timestamps, linked entities); searchable by
  customer/job/text; cards deep-link to the created entity.
- **Requirements:** R11. **Dependencies:** U1, U7.
- **Files:** `packages/api/src/conversations/conversation-service.ts`
  (`recordAssistantTurn`, `searchMessages`, `MessageSearchHit`);
  `.../conversations/pg-conversation.ts` (`searchMessages` SQL);
  `packages/api/src/routes/assistant.ts` (persist turn, echo `conversationId`);
  `packages/api/src/routes/conversations.ts` (`GET /search`);
  `packages/web/src/components/assistant/AssistantPage.tsx` (pin conversationId);
  `packages/web/src/api/conversations.ts` (`searchConversations`);
  `packages/web/src/pages/conversations/CommsInboxPage.tsx` (SearchBar wiring);
  `packages/web/src/components/shared/AIProposalCard.tsx` (View deep-link). Tests:
  `packages/api/test/conversations/assistant-turn-and-search.test.ts`;
  `packages/api/test/routes/assistant.route.test.ts`;
  `packages/api/test/routes/conversations.route.test.ts`;
  `packages/api/test/integration/conversations.test.ts` (searchMessages SQL +
  FORCE RLS); `packages/web/src/api/conversations.test.ts`;
  `packages/web/src/pages/conversations/CommsInboxPage.test.tsx`.
- **Approach:** `recordAssistantTurn` get-or-creates the thread and writes the
  user + agent messages; the chat request carries an optional client-pinned
  `conversationId`, echoed back. `searchMessages` does tenant-scoped text ILIKE
  and/or entity (customer/job) filters; the `/search` route is registered before
  `/:id` and 400s without a criterion. Approved card "View" maps proposal type →
  detail route via `relatedId`.
- **Test scenarios:** turn persists (user+agent) and reuses pinned id; search by
  text / customer / job; no `/:id` collision; deep-link per type / no-link when
  ambiguous; integration pins searchMessages columns + cross-tenant isolation.
- **Verification:** conversation survives reload; search returns matches; cards
  navigate to created entities; suites green.

### U12. Agent error & fallback handling (Story 3.12)
- **Status:** SHIPPED (PR #611) — retry + correlation IDs; low-conf clarify
  pre-existing.
- **Goal:** Low-confidence → clarifying question; tool/model failures show a
  retry (never a silent partial write); errors logged with correlation IDs.
- **Requirements:** R12. **Dependencies:** U3, U7, U11.
- **Files:** `packages/api/src/routes/assistant.ts` (per-turn correlationId →
  gateway metadata + every error log; failure-soft persistence);
  `packages/api/src/ai/gateway/gateway.ts` (correlationId in failure logs);
  `packages/web/src/components/assistant/AssistantPage.tsx` (one-tap retry on a
  failed turn). Tests: `packages/api/test/routes/assistant.route.test.ts`;
  `packages/api/test/ai/gateway*.test.ts`.
- **Approach:** one correlationId per chat turn (honors inbound
  `x-correlation-id`), threaded into the gateway call + assistant-route error
  logs + the reply envelope; the client surfaces a retry for the failed input and
  re-sends (nothing persisted on the failed turn).
- **Test scenarios:** low-confidence → clarify; gateway throw → degraded reply
  with correlationId (HTTP 200, no partial write); client retry recovers;
  x-correlation-id honored.
- **Verification:** failures degrade gracefully with traceable IDs; suites green.

## Risks & Dependencies
- **Migration numbering collisions across parallel branches** (already bit this
  epic: main's 204–206 vs. corrections) — when adding a migration, re-check
  `main` for the next free number and update the immutability snapshot.
- **Docker-gated integration tests can't run in some sandboxes** (Hub rate
  limit) — they run in PR CI; verify migration SQL via `migrate:dryrun` locally.
- **node-postgres auto-parses jsonb** — never `JSON.parse` a jsonb column value
  again (caused a corrections regression).
- **Prompt-byte stability** — gated prompt sections only (RV-071) so cassette
  hashes / gateway cache keys stay stable.

## Open Questions (deferred to implementation)
- Exact transaction primitive for `recordAssistantTurn` (interface-level vs.
  Pg-only) — see Deferred to follow-up U9-followup.
- Whether to enforce the p50<3s (R3) and 60–70% light-model (R10) targets with
  metrics-backed threshold tests, and where the metrics sink lives.

## Sources & Research
- Live-repo audit performed during the Epic 3 implementation this session
  (parallel Explore of `packages/web/**`, `packages/api/src/{ai,conversations,
  proposals}/**`, `db/schema.ts`, gateway, voice).
- PR #611 CI history (the three merge-damage fixes: dropped imports, dropped
  migrations 204–206, jsonb double-parse) — captured here as Risks.
- `CLAUDE.md` Core Patterns + Code Hygiene; `correction_lessons` (migration 185)
  for the corrections-vs-lessons distinction.

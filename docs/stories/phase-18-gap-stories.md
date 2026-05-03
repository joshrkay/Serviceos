# Phase 18 — Voice/UI Parity Closure: Acceptance Criteria + Edge Cases

> **10 stories** | Closing the asymmetry between UI and voice surfaces. Every action a user can do via UI must be doable via voice (and vice versa) — or the asymmetry must be intentionally documented.

---

## Purpose

The parity audit (Section 1 of `docs/quality/crm-deep-state-and-edges.md`) found that **1 of 26 user actions has full bidirectional parity**. Phase 18 closes the 10 worst gaps. Each story includes:

1. **Acceptance criteria** (4-6 bullets)
2. **Cross-surface parity statement** — what the OTHER surface should do
3. **15 secondary paths** — explicit edge case scenarios with expected behavior
4. **Test coverage status checklist**

Stories are independently dispatchable. Wave plan in `p17-dispatch-addendum.md`.

---

## P18-001 — `create_customer` voice intent (BLOCKER)

**Why this is the highest-priority story in the entire roadmap:** today, the voice agent literally cannot capture a new customer. Caller must be transferred to a human. Every inbound call from a non-customer is a leak. The intent classifier returns `'unknown'` for "I'd like to sign up as a new customer." Test AST-01 documents this regression.

**Status:** queued

**Allowed files:** `packages/api/src/ai/orchestration/intent-classifier.ts (modify — add prompt examples + parse branch), packages/api/src/ai/tasks/create-customer-task.ts (new — task handler), packages/api/src/ai/tasks/__tests__/create-customer-task.test.ts (new), packages/api/test/ai/tasks/create-customer-task.test.ts (new), packages/api/src/proposals/contracts/create-customer-contract.ts (new — Zod payload), packages/api/src/proposals/execution/create-customer-handler.ts (new — execution path), packages/api/src/telephony/twilio-adapter.ts (modify — wire create_customer routing only)`

**Acceptance criteria:**
- AC-1: Caller saying "I'd like to sign up", "I'm a new customer", "Can you set up an account for me?" or 5+ similar phrasings → classifier returns `create_customer` intent with confidence ≥ 0.75
- AC-2: Skill creates a `create_customer` proposal with name + phone + email extracted from transcript
- AC-3: Proposal queued for human approval (NOT auto-executed — money/identity creation is human-gated)
- AC-4: Once approved, customer record is created with audit event tying to the voice session via `correlationId`
- AC-5: Voice agent confirms via TTS: "Got it, I've sent your info to the office; we'll send you a confirmation"
- AC-6: Test AST-01 (currently failing in `task-router-guardrails.test.ts`) now passes

**Cross-surface parity:**
- UI: customer creation today is embedded in CustomerPicker autocomplete flows. P18-001 does not change UI behavior. (Open question: does this story also create a dedicated CustomerCreate page for parity? Recommend deferring to a follow-up — voice path is the urgent gap.)
- Voice: this story
- Symmetry test: customer created via voice proposal appears in UI customer list immediately after approval.

**15 secondary paths:**
1. **Caller already exists** (matched on phone via `identify_caller`) — agent confirms identity instead of creating; no proposal generated
2. **Caller refuses to give name** — clarification skill kicks in; if 2 reprompts fail with no extractable name → escalate to human via `escalate_to_human`
3. **Caller gives partial info** (name only, no email) — proposal created with name + phone-from-callerID; email omitted (acceptable per Customer schema where email is optional)
4. **Phone number on caller-id is blocked/private** — agent must explicitly ask for callback number; rejects creation if no callback provided
5. **Caller's phone matches an existing LEAD (not customer)** — agent says "I see we already have you in our system; want me to set you up as a customer?" → triggers convert-lead-to-customer path (not pure create)
6. **Caller speaks Spanish** (P11-002 path) — same flow with Spanish prompts via i18n catalog; classifier examples include Spanish phrasings
7. **Caller mid-sentence interrupted by hangup** — partial proposal saved; status='draft'; not auto-deleted; flagged for office review
8. **Two callers concurrently from same number** (call-waiting weirdness, rare) — sessions are independent; both create proposals; admin will dedupe at approval time
9. **Caller says malicious input** ("DROP TABLE customers", SQL injection attempts in name field) — Zod validates; prepared statements prevent injection; raw input audit-logged (with PII redaction) for security review
10. **Tenant has SMS-consent default OFF** — proposal includes `smsConsent: false`; consent must be explicitly set via approval UI before SMS to this customer
11. **Voice classifier confidence between 0.6 and 0.75** — clarification reprompt: "Did I hear that right? You want to sign up as a new customer?" Confirmation YES → proceed; NO → re-classify
12. **Cost cap exceeded mid-creation** — escalate to human; partial proposal preserved; office completes manually
13. **Tenant isolation** — proposal scoped to caller's resolved tenant via TwilioAccountSid → tenant mapping; never cross-tenant
14. **Audit + observability** — `proposal.created` audit row with `type='create_customer'`, `actor='voice_agent'`, `sessionId`, `correlationId`; PII (full phone, full name) redacted in logs; only first 2 chars + last 2 visible
15. **Approval UI shows clear context** — proposal detail page surfaces: voice-session link, recording playback, transcript excerpt, classifier confidence, extracted fields. The human reviewer must see why the voice agent thought this was a create-customer intent.

**Test coverage status:**
- [ ] AC-1..6 happy path (one test per AC)
- [ ] 15 edges covered (12 unit, 3 integration with mocked Twilio)
- [ ] Cross-surface symmetry test (voice creates → UI list refreshes → customer present)
- [ ] AST-01 regression test passes

---

## P18-002 — `update_customer` voice intent + skill

**Why this matters:** real callers say things like "Can you update my email to ...?" or "Take this number off my account; I have a new one." Today these are unhandled.

**Status:** queued

**Allowed files:** `packages/api/src/ai/orchestration/intent-classifier.ts (modify — add intent + prompt examples), packages/api/src/ai/tasks/update-customer-task.ts (new), packages/api/src/proposals/contracts/update-customer-contract.ts (new), packages/api/src/proposals/execution/update-customer-handler.ts (new), packages/api/test/ai/tasks/update-customer-task.test.ts (new), packages/api/src/telephony/twilio-adapter.ts (modify — wire routing only)`

**Acceptance criteria:**
- AC-1: Phrasings like "update my email", "change my phone number", "update my address" → classifier returns `update_customer` with confidence ≥ 0.75
- AC-2: Skill must verify caller identity FIRST (must be matched customer, not unknown caller); if unknown, refuse and escalate
- AC-3: Skill extracts the field + new value; creates proposal with field-level diff
- AC-4: Proposal requires human approval (identity-bearing changes)
- AC-5: After approval, customer record updated with audit event capturing before/after values
- AC-6: Voice confirms: "Done, I've updated your [field]" (after approval) OR "I've sent that to the office for confirmation" (proposal pending)

**Cross-surface parity:**
- UI: P11-007 just shipped CustomerEdit page (#243). UI path complete.
- Voice: this story
- Symmetry test: voice update → UI shows new value on next refresh; UI update → voice `lookup_account_summary` returns new value

**15 secondary paths:**
1. **Caller is unknown** (no identify_caller match) — skill refuses ("I need to confirm who I'm speaking with first"); escalate
2. **Caller says "update my address" but address isn't on Customer entity** — clarification ("Is that your billing address or service location?")
3. **Caller wants to change phone** — must verify via callback to old number OR escalate; can't blindly trust
4. **Caller asks to change company name** — accepted; lower-risk than phone/email
5. **Caller asks to change something not on the schema** ("update my preferred plumber") — agent says "I don't think I can change that, let me get someone for you"
6. **Multiple fields in one utterance** ("change my email and phone") — extract both; create one proposal with both diffs
7. **New value is identical to old value** — skip proposal; agent acknowledges "looks like that's already on file"
8. **Validation failure on new value** (bad email format) — agent reprompts ("That didn't sound like a valid email; can you spell it?")
9. **Tenant isolation** — proposal scoped to customer's tenant; can never update across tenants
10. **Cost cap exceeded mid-conversation** — escalate; partial proposal preserved
11. **Concurrent UI edit** — voice creates proposal; office worker edits same field directly via UI; whichever is approved/saved last wins. UI should warn "this customer was changed via voice 3 min ago; review."
12. **SMS consent revocation via voice** ("stop texting me") — handled separately by P15-004 STOP keyword; the update_customer path can ALSO accept it; both paths must converge on `smsConsent=false`
13. **Audit / observability** — `customer.updated` audit row with field-level diff (old → new); PII in diff is redacted in logs but visible in audit detail
14. **Caller speaks Spanish** — Spanish prompts; Whisper extracts the field name + value; same proposal flow
15. **Recovery / error surfacing** — proposal-execution failure (e.g., email already in use by another customer) → voice agent says "There was a problem updating your email; let me transfer you to the office"

**Test coverage status:**
- [ ] AC-1..6 happy paths
- [ ] 15 edges covered
- [ ] Cross-surface symmetry test

---

## P18-003 — `add_note` end-to-end (UI handler completion + voice intent test)

**Why this matters:** notes are the most-used context-capture in service businesses. Tech adds a note from mobile, dispatcher adds a note from desk, voice agent adds a note based on caller statement. Today: voice intent wired but no test; UI Note composer is part of P11-008 (queued).

**Status:** queued (depends on P11-008 for UI half)

**Allowed files:** `packages/api/src/ai/tasks/add-note-task.ts (modify or extend — add tests), packages/api/test/ai/tasks/add-note-task.test.ts (new), packages/api/src/proposals/execution/add-note-handler.ts (verify exists; add test), packages/api/test/proposals/execution/add-note-handler.test.ts (new)`

**Acceptance criteria:**
- AC-1: Voice phrases like "add a note that...", "make a note...", "remember that..." → `add_note` intent with confidence ≥ 0.75
- AC-2: Skill extracts entity (job/customer/invoice/estimate/appointment) from context — falls back to current customer if unspecified
- AC-3: Skill extracts note body from transcript (text after "note that...")
- AC-4: Note creation is direct (NOT proposal) — notes are low-risk; if voice agent makes one, the audit captures the recording
- AC-5: UI ConversationThread shows note as system event on next refresh (cross-surface symmetry)
- AC-6: Tests cover happy path + 15 edges

**Cross-surface parity:**
- UI: P11-008 ships NotesComposer (queued)
- Voice: this story
- Symmetry: note via voice immediately visible in UI thread; note via UI visible to voice agent on next `lookup_account_summary` (notes are part of timeline, not separately fetched)

**15 secondary paths:**
1. **No active customer in session** — skill refuses ("I'd need to know which customer that's for"); escalate or redirect
2. **Empty note body** ("just add a note") — clarification ("what should the note say?")
3. **Very long note** (>5000 chars from a long voice utterance) — server 422; voice agent says "that's a long note; can you give me the short version?"
4. **Customer has 100+ existing notes** — appended cleanly; no scaling issue
5. **Customer archived mid-call** — note creation fails; agent says "looks like this customer was archived; do you want me to flag it?"
6. **Tenant isolation** — note scoped to caller's tenant; cross-tenant impossible
7. **Concurrent edit** — two notes added simultaneously (voice + UI); both succeed (notes are append-only; no conflict)
8. **PII in note** — caller says "note that her social is 123-45-6789" — DO WE SCRUB? Decision: store as-is; tenant has consented to recording; PII scrubbing is a tenant-config option (deferred to Phase 18)
9. **Spanish caller** — note saved in Spanish; UI displays as-is (no auto-translate)
10. **Caller says "scratch that"** — voice agent should not save the partial note; need explicit "save this note" trigger or post-utterance summary
11. **Validation rejection on entity ID** — entity doesn't exist (caller hallucinates a job number) → agent asks for clarification
12. **Cost cap exceeded** — escalate; note discarded (no half-finished note saved)
13. **Voice/UI mismatch** — note added via UI: should voice agent's `lookup_account_summary` mention recent notes? Recommend: yes, last 1-2 notes summarized in the digest.
14. **Audit + observability** — `note.created` audit row with `actor='voice_agent'` or `actor=<userId>`; PII redacted in summary logs
15. **Recovery** — DB write fails — agent says "there was a problem saving that; let me transfer you"

**Test coverage status:**
- [ ] AC-1..6 happy paths
- [ ] 15 edges
- [ ] Cross-surface symmetry test

---

## P18-004 — Lookup skills test pack (5 skills)

**Why this matters:** P11-001 shipped 6 lookup skills. Only `lookup_appointments` and `lookup_account_summary` have isolated unit tests. The others (`lookup_invoices`, `lookup_jobs`, `lookup_balance`, `lookup_agreements`, `lookup_availability`) are tested only in flow tests. Test coverage gap.

**Status:** queued (low complexity, high volume)

**Allowed files:** `packages/api/test/ai/skills/lookup-invoices.test.ts (new), packages/api/test/ai/skills/lookup-jobs.test.ts (new), packages/api/test/ai/skills/lookup-balance.test.ts (new), packages/api/test/ai/skills/lookup-agreements.test.ts (new), packages/api/test/ai/skills/lookup-availability.test.ts (new — verify if test exists; if so, expand)`

**Acceptance criteria:**
- AC-1: Each skill has a unit test file
- AC-2: Each test file covers happy path (single result, multi result, empty result)
- AC-3: Each test file covers tenant isolation
- AC-4: Each test asserts TTS-friendly summary string format
- AC-5: Each test asserts the underlying repo method is called with `tenantId` first
- AC-6: All 5 test files combined add ≥ 30 new test cases

**Cross-surface parity:**
- UI: NO equivalent UI surface for these lookups (intentional — lookups are voice-native; UI shows aggregated dashboards instead)
- Voice: tested in this story

**15 secondary paths (per skill — apply variants):**
1. **Single result** — TTS string is grammatical for "1 invoice"
2. **Empty result** — friendly TTS ("you have no open invoices")
3. **Multi result** (3+) — TTS string lists top N with summary count
4. **Result with $0** — money formatting handles zero
5. **Result with very large amount** ($100k+) — money formatting handles big numbers
6. **Customer with archived invoices** — excluded from lookup
7. **Tenant isolation** — invoices from tenant A invisible to caller in tenant B
8. **Cross-customer leak** — token/identity for customer A returns only A's data, not other customers in same tenant
9. **Time formatting** — dates rendered in tenant timezone
10. **Spanish output** — when called with `language='es'`, summary is Spanish
11. **Lookup with date filter** — only events in the requested range
12. **Lookup with kinds filter** — only matching kinds
13. **Repo throws error** — skill returns `status='error'` with friendly summary
14. **Customer with very old data** (5+ years of invoices) — pagination cap honored
15. **Performance** — lookup completes in <500ms for typical customer

**Test coverage status:**
- [ ] All 5 skills have isolated tests
- [ ] 30+ new test cases
- [ ] Each skill's tenant isolation guarded

---

## P18-005 — Voice proposal-task tests (3 tasks)

**Why this matters:** `create_invoice`, `create_job`, `record_payment` voice tasks are tested in flow tests but not as isolated units. When the flow changes, these tests don't isolate the failure mode.

**Status:** queued

**Allowed files:** `packages/api/test/ai/tasks/create-invoice-task.test.ts (new), packages/api/test/ai/tasks/create-job-task.test.ts (new), packages/api/test/ai/tasks/record-payment-task.test.ts (new)`

**Acceptance criteria:**
- AC-1: Each task has unit test file with mocked deps (proposal repo, audit repo)
- AC-2: Tests cover proposal-creation happy path (input → proposal)
- AC-3: Tests cover validation rejection (Zod failure → error)
- AC-4: Tests cover tenant isolation
- AC-5: Tests cover idempotency (same input twice → one proposal, not two)
- AC-6: Tests cover audit event emission

**15 secondary paths (per task — common patterns):**
1. Empty input — rejected with clear error
2. Boundary values — $0 invoice, max-int line item
3. Tenant isolation — proposal scoped to caller's tenant
4. Validation rejection — Zod error surfaced as task error
5. Idempotency — same call twice produces one proposal
6. Concurrent calls — two tasks same session, both create distinct proposals
7. Money safety — decimals rejected at schema level
8. Stripe payment-link generation failure (record_payment) — task succeeds, link is null, warning logged
9. Customer not found — proposal references customerId but lookup fails → task creates proposal anyway (proposal will be rejected at approval)
10. Cost cap exceeded — task fails gracefully
11. Audit row written for every proposal-create
12. Voice transcript excerpt captured in proposal metadata
13. Tenant isolation — cross-tenant tasks impossible
14. Recovery — proposal repo down → task surfaces error to adapter
15. Confidence below threshold — task not invoked (handled at intent classifier level, but assert in adapter routing test)

**Test coverage status:**
- [ ] 3 isolated test files
- [ ] Each covers AC-1..6
- [ ] 45+ new test cases (15 × 3)

---

## P18-006 — Appointment FSM isolated voice tests

**Why this matters:** `reschedule_appointment`, `reassign_appointment`, `cancel_appointment` are FSM-handled. UI tests exist for the drag-drop path; voice path is tested only in `transitions.test.ts` at a high level. Need isolated voice flow tests.

**Status:** queued

**Allowed files:** `packages/api/test/ai/agents/customer-calling/voice-reschedule.test.ts (new), packages/api/test/ai/agents/customer-calling/voice-reassign.test.ts (new), packages/api/test/ai/agents/customer-calling/voice-cancel.test.ts (new)`

**Acceptance criteria:**
- AC-1: Each test file simulates a full voice session ending in a reschedule/reassign/cancel proposal
- AC-2: Tests assert the right FSM transitions fire
- AC-3: Tests assert the proposal payload is correct
- AC-4: Tests cover at least 5 edges per file
- AC-5: Tests run in <2s each (fast feedback loop)
- AC-6: Tests use the existing FSM mock infrastructure, not new harness

**15 secondary paths (across 3 stories):**
1. Reschedule to a slot that conflicts — proposal still created (conflict resolved at approval)
2. Reschedule past the appointment time — agent rejects ("that's already passed")
3. Reschedule to a slot 2+ years out — accepted with warning
4. Reassign to a tech who is off that day — proposal created with conflict flag
5. Reassign to a non-existent user — clarification or escalate
6. Cancel a completed appointment — agent rejects
7. Cancel a cancelled appointment — agent acknowledges idempotently
8. Caller hangs up mid-reschedule — partial proposal saved as draft
9. Voice transcript ambiguous about which appointment ("Tuesday" — which Tuesday?) — clarification
10. Voice transcript ambiguous about target tech ("Mike" — which Mike if multiple?) — clarification
11. Tenant isolation — proposals scoped to caller's tenant
12. Cost cap exceeded — escalate; partial proposal preserved
13. Concurrent UI drag — voice proposal queued; UI proposal queued; approval order determines winner
14. Spanish caller — flows in Spanish via P11-002 i18n
15. Audit captures the originating session + transcript excerpt

**Test coverage status:**
- [ ] 3 test files
- [ ] 15+ test cases distributed across the 3 actions
- [ ] FSM mock used; no real Postgres

---

## P18-007 — `approve_estimate` voice intent

**Why this matters:** customers regularly call to approve an estimate verbally ("yeah, the $1200 quote, go ahead"). Today this requires office to manually mark it approved. Voice should handle.

**Status:** queued

**Allowed files:** `packages/api/src/ai/orchestration/intent-classifier.ts (modify), packages/api/src/ai/tasks/approve-estimate-task.ts (new), packages/api/src/proposals/contracts/approve-estimate-contract.ts (new), packages/api/src/proposals/execution/approve-estimate-handler.ts (new), packages/api/test/ai/tasks/approve-estimate-task.test.ts (new), packages/api/src/telephony/twilio-adapter.ts (modify — routing)`

**Acceptance criteria:**
- AC-1: Phrasings like "approve the estimate", "go ahead with the quote", "I'm good with that price" → `approve_estimate` with confidence ≥ 0.75
- AC-2: Skill identifies which estimate via context (most recent unresolved estimate for customer; if multiple, clarification)
- AC-3: Creates proposal type `approve_estimate` with the target estimate ID
- AC-4: Proposal queued for human approval (verbal approval is high-trust but human review prevents fraud)
- AC-5: After approval, estimate status flips to `'approved'` with audit event referencing voice session
- AC-6: Voice agent confirms: "Got it, the $1200 estimate is approved; we'll get someone scheduled"

**Cross-surface parity:**
- UI: estimate detail page has approve button (existing)
- Voice: this story
- Symmetry: approval via voice → UI shows status='approved'; UI approval → voice `lookup_account_summary` reflects it

**15 secondary paths:**
1. **No outstanding estimate for customer** — agent says "I don't see any open estimates for you"
2. **Multiple outstanding estimates** — clarification ("you have a $1200 plumbing estimate and a $400 HVAC estimate; which one?")
3. **Estimate is expired** (past view-token expiry or `expiresAt`) — agent rejects ("that quote has expired; let me get someone to refresh it")
4. **Estimate already approved** — agent acknowledges idempotently
5. **Caller is not the customer on the estimate** — agent must verify identity; if mismatch, escalate
6. **Caller approves but adds modifications** ("approve but knock off $100") — clarification or escalate (modifications need human handling)
7. **Estimate amount > tenant-configured high-value threshold** (e.g., $10k) — proposal flagged for owner-only approval
8. **Spanish caller approves** — flow works in Spanish; signature step happens later via portal
9. **Cost cap exceeded mid-approval** — escalate; partial proposal preserved
10. **Tenant isolation** — proposal scoped to caller's tenant
11. **Customer's payment method on file** — if Stripe customer exists, proposal can include "auto-charge approval" option (future enhancement; document)
12. **Audit captures session + transcript excerpt** — required for legal compliance (verbal approval is binding)
13. **Concurrent UI edit** — office worker editing the estimate while caller approves — proposal queues; approval order determines outcome
14. **Recovery** — proposal-execution fails (estimate state changed) — agent says "there was a problem; transferring you to the office"
15. **Voice/UI mismatch** — UI shows estimate as "verbal approval pending" between proposal creation and human approval

**Test coverage status:**
- [ ] AC-1..6
- [ ] 15 edges
- [ ] Cross-surface symmetry test

---

## P18-008 — `execute_agreement` voice intent + UI handler completion

**Why this matters:** customers call to "set up a maintenance plan" or "sign up for the quarterly tune-up". Today: agreements created via UI form; no voice path. UI execute button stubbed.

**Status:** queued

**Allowed files:** `packages/api/src/ai/orchestration/intent-classifier.ts (modify), packages/api/src/ai/tasks/execute-agreement-task.ts (new), packages/api/src/proposals/contracts/execute-agreement-contract.ts (new), packages/api/src/proposals/execution/execute-agreement-handler.ts (new), packages/api/test/ai/tasks/execute-agreement-task.test.ts (new), packages/web/src/pages/agreements/AgreementDetail.tsx (modify — wire execute button), packages/web/src/pages/agreements/__tests__/AgreementDetail.test.tsx (modify — add execute test)`

**Acceptance criteria:**
- AC-1: Voice phrasings like "sign me up for the maintenance plan", "I'll do the quarterly service" → `execute_agreement` intent with conf ≥ 0.75
- AC-2: Skill identifies which agreement template (offered to caller during the call) and creates agreement-instance proposal
- AC-3: UI execute button creates the agreement directly (UI is human-driven, no proposal needed)
- AC-4: Tenant isolation enforced
- AC-5: Audit captures the originating action (voice session ID OR UI user ID)
- AC-6: Newly executed agreement appears in agreement list immediately

**Cross-surface parity:**
- UI: this story (button completion)
- Voice: this story (new intent + skill)
- Symmetry: agreement created via voice → UI list refreshes; UI agreement → voice `lookup_agreements` returns it

**15 secondary paths:**
1. Customer already has same agreement type — agent acknowledges, no duplicate
2. Tenant has no agreement templates configured — agent says "we don't offer that yet; let me transfer you"
3. Caller asks for a custom term ("monthly instead of quarterly") — escalate or accept based on tenant-configured flexibility
4. Caller asks for a discount on agreement — escalate
5. Customer has insufficient payment method on file — voice agent collects callback for office; proposal flagged
6. Agreement starts_on date in the past — accepted with warning
7. Tenant isolation
8. Concurrent voice + UI on same customer — both create proposals; approval order determines outcome
9. Spanish caller — flow in Spanish
10. Cost cap exceeded — escalate
11. UI execute button: optimistic UI vs strict server confirmation — recommend strict (button pending until 200)
12. UI execute button race — two clicks, one POST (debounce or disabled-while-pending)
13. Audit captures the originating action
14. Customer cancels mid-creation (caller hangs up before confirming) — proposal saved as draft
15. Recovery — execute fails server-side — UI surfaces error toast; voice agent transfers to office

**Test coverage status:**
- [ ] AC-1..6
- [ ] 15 edges
- [ ] Cross-surface symmetry test

---

## P18-009 — `archive_customer` end-to-end

**Why this matters:** today UI archive button is stubbed (no handler); no voice intent exists. Owners need to archive customers (moved away, fraud, closed business). Both surfaces should support.

**Status:** queued

**Allowed files:** `packages/api/src/ai/orchestration/intent-classifier.ts (modify — add archive intent + LOW-confidence requirement), packages/api/src/ai/tasks/archive-customer-task.ts (new), packages/api/src/proposals/contracts/archive-customer-contract.ts (new), packages/api/src/proposals/execution/archive-customer-handler.ts (new), packages/api/test/ai/tasks/archive-customer-task.test.ts (new), packages/web/src/pages/customers/CustomerDetail.tsx (modify — wire archive button + confirmation dialog), packages/web/src/pages/customers/__tests__/CustomerDetail.test.tsx (modify)`

**Acceptance criteria:**
- AC-1: UI archive button opens confirmation dialog → on confirm, PATCH `/api/customers/:id` with `isArchived: true, archivedAt: now()`
- AC-2: UI archived customer hidden from default lists; visible via "include archived" filter
- AC-3: Voice archive intent has HIGHER confidence threshold (0.85+) — destructive action, low-frequency
- AC-4: Voice creates proposal (NOT direct mutation); requires owner-only approval
- AC-5: Archived customer's open invoices, jobs, agreements remain queryable but no new mutations allowed
- AC-6: Cross-surface symmetry test

**Cross-surface parity:**
- UI: this story (button completion)
- Voice: this story (intent + skill)

**15 secondary paths:**
1. **Customer has open invoices** — block archive ("this customer has $X in open invoices; resolve those first") OR allow with warning (decision: block by default; tenant-configurable)
2. **Customer has active service agreement** — block archive
3. **Customer has scheduled appointments** — block archive
4. **Confirmation dialog cancel** — no API call
5. **Concurrent archive** — two users; second 409 (already archived)
6. **Voice archive intent at confidence 0.84** — clarification reprompt; do not auto-execute
7. **Voice archive proposal — non-owner approves** — 403 at execution
8. **Tenant isolation** — proposal scoped to caller's tenant
9. **Audit captures actor + archive reason** (collected in dialog)
10. **Restore (un-archive)** — UI provides; voice can request via proposal too
11. **Archived customer in customer-economics view** — excluded from totals (per current view definition)
12. **Archived customer in lookup_account_summary** — voice agent says "I see this customer is archived; let me transfer you"
13. **PII / observability** — archived event audit-logged; PII redacted in logs
14. **Recovery** — archive fails (FK constraint, e.g., active jobs) — clear error to user
15. **Voice/UI mismatch** — voice archive proposal pending approval; office worker un-archives via UI; voice agent re-asks "still want to archive?"

**Test coverage status:**
- [ ] AC-1..6
- [ ] 15 edges
- [ ] Cross-surface symmetry test

---

## P18-010 — Outbound mid-call voice action: `send_message` to customer

**Why this matters:** caller is on the phone, agent is helping them; agent needs to send them a link (e.g., invoice payment link, estimate approval link) immediately, while still on the call. Today: voice agent has no outbound surface during the call.

**Status:** queued

**Allowed files:** `packages/api/src/ai/orchestration/intent-classifier.ts (modify), packages/api/src/ai/skills/send-during-call.ts (new — skill, not proposal — direct action), packages/api/src/telephony/twilio-adapter.ts (modify — wire skill), packages/api/test/ai/skills/send-during-call.test.ts (new)`

**Acceptance criteria:**
- AC-1: Phrasings like "text me the invoice link", "send me the estimate", "email me a copy" → `send_during_call` skill triggered
- AC-2: Skill identifies the entity (invoice/estimate) most recently discussed in the call
- AC-3: Skill generates the public link (using existing payment-link / view-token infra) and dispatches via send-service
- AC-4: This is NOT a proposal — it's a direct action because the caller explicitly requested it (and is on the phone)
- AC-5: Voice agent confirms: "Sent, you should get it in a moment"
- AC-6: Customer's SMS/email consent is HONORED — if they say "text me" but `smsConsent=false`, agent says "I'll need to email you instead" (asks for confirmation)

**Cross-surface parity:**
- UI: P11-008 SendInvoice / SendEstimate buttons
- Voice: this story (mid-call only)
- Symmetry: behavior identical between surfaces; both produce `message_dispatches` row

**15 secondary paths:**
1. **Customer no email + no SMS consent** — agent says "I don't have a way to send that to you; what email should I use?" → triggers update_customer flow
2. **Caller on a phone that can't receive SMS** (landline) — graceful: "I'll email it instead"
3. **Customer revoked SMS consent earlier in call** — must use email
4. **No recently discussed entity** — clarification ("which invoice did you want?")
5. **Multiple recently discussed** — clarification ("the $400 or the $1200 invoice?")
6. **Send-service down** — agent says "having trouble sending that; we'll email it from the office in a bit" + queue for retry
7. **Spanish caller** — link sent with Spanish-language preview text
8. **Concurrent UI send** — duplicate sends possible; UNIQUE-constraint on (entity_id, channel, sent_at-window) might prevent
9. **Tenant isolation** — entity scope is caller's tenant only
10. **Cost / abuse** — rate-limit per-call to 3 sends max (prevent infinite-loop "send me the link again")
11. **Customer hangs up mid-send** — send completes server-side; status logged
12. **Audit captures actor='voice_agent' + recipient + channel + entity**
13. **Idempotency** — caller asks twice ("text me the link" then "did you send it?") — second request, no second send; agent says "yes, sent it 30 seconds ago"
14. **Recovery** — Twilio rejects (invalid phone) — agent reports "couldn't reach you at that number" + suggests email
15. **Voice/UI mismatch** — UI send same entity simultaneously — both succeed; deduped at `message_dispatches` level if within window

**Test coverage status:**
- [ ] AC-1..6
- [ ] 15 edges
- [ ] Cross-surface symmetry test

---

## Summary table

| Story | Priority | UI gap | Voice gap | Migration | Size |
|---|---|---|---|---|---|
| P18-001 create_customer | 🔴 BLOCKER | (existing CustomerPicker OK) | classifier broken | none | M |
| P18-002 update_customer | 🔴 | UI just shipped | no intent | none | M |
| P18-003 add_note end-to-end | 🟡 | NotesComposer queued | tests missing | none | S |
| P18-004 lookup tests pack | 🟡 | n/a | tests missing | none | M |
| P18-005 voice task tests | 🟡 | n/a | tests missing | none | M |
| P18-006 FSM voice tests | 🟢 | n/a | tests missing | none | S |
| P18-007 approve_estimate voice | 🟢 | UI button exists | no intent | none | M |
| P18-008 execute_agreement | 🟢 | UI button stubbed | no intent | none | M |
| P18-009 archive_customer | 🟢 | UI stubbed | no intent | none | S |
| P18-010 send_during_call | 🟢 | (P11-008 covers UI) | no skill | none | M |

**Total estimated effort:** 6 weeks of agent dev. No migrations.

**Wave plan:** P18-001 + P18-002 first (the two BLOCKER customer-CRUD gaps), then P18-003 after P11-008 merges, then P18-004 + P18-005 + P18-006 in parallel (test-only stories), then P18-007 + P18-008 + P18-009 + P18-010 in parallel (independent intents).

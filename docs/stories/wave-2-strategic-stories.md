# Wave 2 Strategic Stories — AI Back Office MVP

> **11 stories** | Sourced from PRD v2 §9 (NEW stories N-001..N-011)
>
> These stories are the concrete delivery of the four-pillar trust
> architecture and the day-in-the-life experience described in
> `docs/strategy/day-in-the-life.md` and specified in `docs/PRD.md` §9.
>
> Story IDs use existing phase prefixes (for `/dispatch-story` compatibility)
> and cross-reference the PRD's N-XXX codenames.

---

## Purpose

Deliver the eleven net-new stories required by PRD v2 that have no home in
the v1 execution catalog. These stories make Mike's good Tuesday and
Jenna's good Tuesday work end-to-end, and they implement the trust
mechanisms (confidence surfacing, supervisor agent review, end-of-day
digest with "what I wasn't sure about" section) that differentiate the
product from incumbents.

## Exit criteria

When all eleven stories are merged and tests pass:

- A proposal can be created, dispatched as SMS, approved with a one-tap
  reply, or edited via voice dictation.
- The system never auto-sends a price commitment or scope change without
  owner approval.
- Every booking and quote is reviewed by the supervisor agent before
  reaching the owner's queue.
- Dropped voice calls are recovered via SMS within 60 seconds.
- Elderly or medically-vulnerable callers with urgency signals route
  directly to the owner's phone, not the booking flow.
- The owner receives a daily SMS digest with a "what I wasn't sure about
  today" and a "what I learned today" section.
- Google reviews are monitored; non-positive reviews land in the approval
  queue with a drafted response and optional service credit.
- Owner edits to proposals teach the system forward (labor rates, prices,
  banned phrases, scope classification).
- Technicians can mark themselves out via one SMS; their day cascades
  into reschedule proposals.
- Every AI utterance conforms to the locked brand voice.

## ID mapping (PRD codename → dispatch ID)

| PRD § | Codename | Dispatch ID | File location |
|-------|----------|-------------|---------------|
| §9 N-001 | SMS-Approval-Transport | **P2-034** | this file |
| §9 N-002 | Confidence-Surfacing-Spec | **P2-035** | this file |
| §9 N-003 | Negotiation-Guardrail-Handler | **P2-036** | this file |
| §9 N-004 | Supervisor-Agent-Review-Pass | **P2-037** | this file |
| §9 N-009 | Correction-Loop-UX | **P2-038** | this file |
| §9 N-011 | Brand-Voice-Configurator | **P4-015** | this file |
| §9 N-005 | End-of-Day-Digest-Generator | **P5-020** | this file |
| §9 N-010 | Tech-Im-Out-One-Tap-Status | **P6-028** | this file |
| §9 N-006 | Google-Review-Monitoring | **P7-026** | this file |
| §9 N-007 | Dropped-Call-SMS-Recovery | **P8-015** | this file |
| §9 N-008 | Vulnerability-Aware-Triage | **P8-016** | this file |

## Gap summary

| ID | Title | Size | Layer | AI Build | Human Review | Wave | Dependencies |
|----|-------|------|-------|----------|--------------|------|--------------|
| P2-034 | SMS approval transport for every proposal type | S | Proposal Engine | High | Heavy | 1 | P2-001, P2-002, P0-014, P7-001 |
| P2-035 | Typed confidence-marker system on proposals | S | Proposal Engine | Medium | Heavy | 1 | P2-012, P0-015 |
| P2-036 | Negotiation / scope-change guardrail handler | S | Proposal Engine | Medium | Heavy | 1 | P2-013, P2-034 |
| P2-037 | Supervisor agent review pass on bookings + quotes | M | AI Orchestration | Medium | Heavy | 2 | P2-007, P2-027, P5-001 |
| P2-038 | Correction-loop UX — edits become learned defaults | M | Learning | Medium | Heavy | 2 | P0-018, P2-005, P5-020 |
| P4-015 | Brand-voice configurator + locked profile validator | S | Onboarding | High | Moderate | 2 | P4-001A, P2-027 |
| P5-020 | End-of-day digest generator with "what I wasn't sure about" | M | Reporting | Medium | Heavy | 2 | P1, P2, P5, P2-035 |
| P6-028 | Tech "I'm out" one-tap SMS status with cascading reschedule proposals | XS | Field Ops | High | Moderate | 2 | P1-008, P2-034, P7-001 |
| P7-026 | Google Business review monitoring + draft-response proposals | M | Reputation | Medium | Heavy | 2 | P0-014, P2-034 |
| P8-015 | Dropped-call SMS recovery within 60 seconds | S | Intake | Medium | Heavy | 2 | P8-001, P7-001 |
| P8-016 | Vulnerability-aware emergency triage (age, weather, medical) | S | Intake | Medium | Heavy | 2 | P8-001, P1-001 |

---

## Story specifications

### P2-034 — SMS approval transport for every proposal type

> **Size:** S | **Layer:** Proposal Engine | **AI Build:** High | **Human Review:** Heavy | **Wave:** 1
> **PRD codename:** N-001 (PRD v2 §9)
> **Day-in-the-life moments:** Mike 6:15am estimate approval, 7:30pm digest, every Mike good-day approval moment.

**Dependencies:** P2-001 (proposal entity), P2-002 (typed contracts), P0-014 (webhook base), P7-001 (Twilio config)

**Allowed files:**
`packages/api/src/proposals/sms/**`,
`packages/api/src/sms/**`,
`packages/api/src/webhooks/twilio-sms.ts`,
`packages/api/migrations/*proposal_sms*`,
`packages/shared/src/contracts/proposal-sms.ts`

**Build prompt:** Implement an SMS rendering and approval transport for
every proposal type defined in `packages/shared/src/contracts/`. For each
proposal, render a concise SMS body (target <320 characters; split into
segments only when necessary) containing the proposal summary, the most
relevant 1–3 fields (price, customer, time), any confidence-marker text
from P2-035, and three reply tokens: `APPROVE` (or `Y`), `EDIT`, `REJECT`
(or `N`). Persist each outbound SMS keyed to a `proposal_sms_event` row
with delivery and read-receipt state from Twilio. On inbound SMS from the
owner's registered number, parse the first token: `APPROVE`/`Y` transitions
the proposal to `approved` and triggers execution; `REJECT`/`N` transitions
to `rejected` with the body as the rejection reason; `EDIT` opens an edit
session and the system replies asking for the change ("What should I
change?"). Subsequent inbound SMS or MMS voice-memo within the edit session
window (10 min) is interpreted as a structured delta against the proposal,
re-rendered for re-approval. All SMS interactions emit audit events. The
transport is idempotent on `MessageSid`.

**Review prompt:** Verify that every proposal contract in
`packages/shared/src/contracts/` has a corresponding SMS renderer.
Verify the inbound parser is tolerant of capitalization, leading
whitespace, and common typos (e.g., `YES`, `OK`, `approve`). Verify
duplicate `MessageSid` delivery is a no-op. Verify the edit session
window cannot be extended by spamming (rate-limited). Verify cross-tenant
SMS cannot reach the wrong proposal. Verify audit events include the
proposal id, owner user id, inbound message body (redacted for PII in
logs), and resulting state transition.

**Automated checks:**
```bash
cd packages/api && npx tsc --project tsconfig.build.json --noEmit
cd packages/api && npm test -- --grep "P2-034"
```

**Required tests:** (shipped 2026-06-11 —
`test/proposals/sms/`, `test/sms/inbound-dispatch.test.ts`,
`test/integration/proposal-sms-events.test.ts`)
- [x] Happy path — every proposal type renders to SMS without exceeding
      Twilio segment limits when input is realistic
- [x] Approve flow — `APPROVE`, `Y`, `yes` all transition state correctly
- [x] Reject flow — `REJECT`, `N` with body capture reason
- [x] Edit flow — free-text SMS produces structured delta (LLM, fails
      closed to manual review); re-rendered for re-approval. MMS
      voice-memo input deferred (see non-goals note below)
- [x] Idempotency — duplicate `MessageSid` is no-op
- [x] Tenant isolation — inbound SMS from owner A cannot touch tenant B
      proposals
- [x] Edge: invalid token replies — system asks for clarification once
      then escalates as a clarification-needed event
- [x] Audit — every state transition emits an audit event with
      correlation id

**Non-goals:** Rich-media interactive cards; group SMS approval; SMS to
non-owner approvers (V2). Deferred from the 2026-06-11 slice: MMS
voice-memo edit input and Twilio delivery-status sync onto
`proposal_sms_events` (delivery state currently lives in the generic
status-callback receipts).

---

### P2-035 — Typed confidence-marker system on proposals

> **Size:** S | **Layer:** Proposal Engine | **AI Build:** Medium | **Human Review:** Heavy | **Wave:** 1
> **PRD codename:** N-002 (PRD v2 §9)
> **Day-in-the-life moments:** Mike 6:15am (3rd estimate with edited part), 9:45am (hallucinated part on bad day).

**Dependencies:** P2-012 (confidence storage), P0-015 (AI runs)

**Allowed files:**
`packages/api/src/proposals/confidence/**`,
`packages/api/src/ai/confidence/**`,
`packages/api/migrations/*confidence_marker*`,
`packages/shared/src/contracts/confidence-marker.ts`

**Build prompt:** Replace any planned numeric-confidence display with a
typed marker system. Define `ConfidenceMarker` as a discriminated union
with these variants: `unknown_part` (part model not in tenant inventory
or customer history), `price_deviation` (line item differs >10% from
tenant's rolling-30-day average for similar items), `urgency_uncertain`
(classifier confidence <80% on emergency calls), `unverified_b2b_claim`
(caller claims B2B account but phone doesn't match), `brand_voice_drift`
(generated copy fails the brand-voice validator from P4-015). Each marker
includes the source field path, the AI run id, and a human-readable
explanation. Markers attach to proposals (and to specific line items
where applicable) at draft time. The SMS rendering in P2-034 surfaces
markers as a concise "I'm not sure about: …" tail line when present;
proposals with markers can still be approved (markers are signals, not
blockers). All markers persist with proposal outcomes for retraining.
**Do not display any "X% confident" badges anywhere.**

**Review prompt:** Verify the marker types are exhaustive for the
sources described in PRD §4 (confidence-surfacing rules). Verify markers
do not block approval. Verify they persist with the proposal even after
approval (for outcome analysis). Verify the SMS surface treats no-marker
as silent (no "I'm confident" affirmation). Verify per-line-item markers
render adjacent to the line, not in a footer.

**Automated checks:**
```bash
cd packages/api && npx tsc --project tsconfig.build.json --noEmit
cd packages/api && npm test -- --grep "P2-035"
```

**Required tests:**
- [ ] Each marker type emits when its trigger fires
- [ ] No-marker proposals produce silent SMS (no "I'm sure" line)
- [ ] Marker survives approval, rejection, and edit
- [ ] Per-line-item markers render at the line, not the footer
- [ ] Markers logged with proposal outcome for retraining query

**Non-goals:** Global confidence percentage display; user-configurable
thresholds in V1; multi-language marker copy (V2).

---

### P2-036 — Negotiation / scope-change guardrail handler

> **Size:** S | **Layer:** Proposal Engine | **AI Build:** Medium | **Human Review:** Heavy | **Wave:** 1
> **PRD codename:** N-003 (PRD v2 §9)
> **Day-in-the-life moments:** Mike bad-day 3:00pm (customer game-plays for 20% off).

**Dependencies:** P2-013 (low-confidence policy), P2-034 (SMS transport)

**Allowed files:**
`packages/api/src/proposals/guardrails/**`,
`packages/api/src/conversations/negotiation/**`,
`packages/api/src/ai/intent/negotiation-classifier.ts`,
`packages/shared/src/contracts/negotiation-event.ts`

**Build prompt:** Add a guardrail layer that classifies inbound text and
voice utterances for these intents: `discount_request`,
`scope_expansion`, `refund_request`, `escalate_to_human`,
`deadline_threat` ("I'll go elsewhere"). On detection, the AI must
respond only with an acknowledgment in the locked brand voice (e.g.,
"Let me check with [owner first name] on that — I'll get back to you
within the hour") and emit a proposal of type `negotiation_response` to
the owner via P2-034. The proposal includes: the detected intent, the
verbatim customer message, the customer history (lifetime value,
recency), and a recommended response (e.g., "don't discount; offer $100
courtesy + Friday slot"). The AI cannot generate discount or scope-
change commitments through any other path; tests must prove the
restriction.

**Review prompt:** Verify the classifier triggers on common phrasings:
"can you do better on the price", "knock off", "match their quote",
"I want my money back", "talk to your manager". Verify the
acknowledgment is in brand voice. Verify the owner proposal arrives via
SMS within 30 seconds of detection. Verify that no other proposal type
can emit a discount or scope expansion without an approved
`negotiation_response`.

**Automated checks:**
```bash
cd packages/api && npx tsc --project tsconfig.build.json --noEmit
cd packages/api && npm test -- --grep "P2-036"
```

**Required tests:**
- [ ] Each intent type fires on representative phrasings
- [ ] Acknowledgment uses brand voice (golden examples)
- [ ] Owner proposal arrives via SMS within 30 seconds
- [ ] Discount cannot be applied to an estimate without an approved
      negotiation_response
- [ ] Recommended response includes customer LTV and recency context
- [ ] False positives — benign questions ("how much?") do not trigger

**Non-goals:** Per-tenant negotiation playbooks (V2); automatic price
floors (V2 — V1 just blocks discounts entirely).

---

### P2-037 — Supervisor agent review pass on bookings + quotes

> **Size:** M | **Layer:** AI Orchestration | **AI Build:** Medium | **Human Review:** Heavy | **Wave:** 2
> **PRD codename:** N-004 (PRD v2 §9)
> **Day-in-the-life moments:** Mike bad-day 11:00am (flat-voice elderly caller missed by primary).

**Dependencies:** P2-007 (orchestration), P2-027 (LLM gateway), P5-001 (invoice proposals)

**Allowed files:**
`packages/api/src/ai/supervisor/**`,
`packages/api/src/ai/runs/**`,
`packages/api/migrations/*supervisor_review*`,
`packages/shared/src/contracts/supervisor-flag.ts`

**Build prompt:** Implement a second-pass classifier that runs after
every booking, estimate, and invoice proposal is drafted by the primary
system, **before** the proposal reaches the owner's SMS queue (P2-034).
The supervisor uses a Tier 1 (cheap, fast) model via the gateway. For
each proposal, it produces a `SupervisorReview` with zero or more
`SupervisorFlag`s of these types: `missed_urgency` (caller signals —
vocabulary, weather context, customer age — inconsistent with the
booking's scheduled time), `pricing_anomaly` (total or line items
differ >20% from rolling averages for similar jobs), `brand_voice_drift`
(banned phrases or unusual register), `account_routing_error` (proposal
treats a known B2B account as residential or vice versa). Flags become
P2-035 markers on the proposal. If a flag is **critical** (severity =
`high`), the proposal is held and a direct owner alert is sent
out-of-band (separate from the normal SMS digest cadence). All reviews
log to AI runs (P0-015) for measurement. Latency budget: complete in
P95 <60 seconds from proposal creation.

**Review prompt:** Verify the supervisor uses a different model from the
primary orchestrator (configurable per task type). Verify critical-flag
holds reach the owner via direct alert, not the queued digest. Verify
the latency target is enforced (timeout escalates to "review pending"
state, not auto-approve). Verify the supervisor cannot mutate proposal
content — only flag. Verify supervisor outputs are themselves logged for
quality measurement of the supervisor itself.

**Automated checks:**
```bash
cd packages/api && npx tsc --project tsconfig.build.json --noEmit
cd packages/api && npm test -- --grep "P2-037"
```

**Required tests:**
- [ ] Each flag type fires on representative inputs (labeled fixtures)
- [ ] Critical flag triggers out-of-band owner alert
- [ ] Latency P95 <60s on a representative load
- [ ] Supervisor cannot mutate proposal content
- [ ] Supervisor runs persist with model identifier + token counts
- [ ] False-positive rate <5% on the labeled fixture set
- [ ] False-negative rate <2% on the labeled fixture set

**Non-goals:** Supervisor review for SMS-only conversations (V2); per-
tenant custom rules (V2); supervisor of the supervisor (do not build).

---

### P2-038 — Correction-loop UX

> **Size:** M | **Layer:** Learning | **AI Build:** Medium | **Human Review:** Heavy | **Wave:** 2
> **PRD codename:** N-009 (PRD v2 §9)
> **Day-in-the-life moments:** Mike bad-day 7:10am (stale labor rate corrected → all future quotes update), 9:30pm digest "things I learned today."

**Dependencies:** P0-018 (diff worker), P2-005 (approve/edit/reject), P5-020 (digest)

**Allowed files:**
`packages/api/src/learning/corrections/**`,
`packages/api/src/ai/prompts/**`,
`packages/api/migrations/*correction_lesson*`,
`packages/shared/src/contracts/correction-lesson.ts`

**Build prompt:** When the owner edits a proposal (via P2-034 voice
dictation or web), use the diff worker (P0-018) to extract structured
lessons of these types: `labor_rate_changed` (estimate line edit changes
the per-hour rate; update tenant default), `part_price_changed` (line
edit changes a SKU price; update tenant price for that SKU),
`banned_phrase` (rejection reason or edit removes a phrase; add to
tenant brand-voice negative-prompt), `scope_reclassified` (edit
re-categorizes the job; adjust vertical-pack template selection weight).
Lessons persist to `correction_lessons` with the source proposal id and
owner id. Lessons apply forward to subsequent AI drafts within the same
day. Surfaced in the end-of-day digest (P5-020) under "what I learned
today" with one line per lesson. Each lesson is reversible from the web
audit (a single undo action that removes the lesson and any cascaded
config changes).

**Review prompt:** Verify lesson extraction is conservative (does not
infer lessons from edits that lack a clear pattern). Verify the four
lesson types cover the four edit categories. Verify forward application
within the day. Verify the digest shows learned changes in the same
day's report. Verify undo is single-action and removes cascaded effects.
Verify lessons do not cross tenant boundaries.

**Automated checks:**
```bash
cd packages/api && npx tsc --project tsconfig.build.json --noEmit
cd packages/api && npm test -- --grep "P2-038"
```

**Required tests:**
- [ ] Each of the four lesson types extracts correctly from representative
      edits
- [ ] Lessons apply to subsequent same-day proposals
- [ ] Undo removes lesson and cascaded config
- [ ] Digest renders the lesson list
- [ ] Cross-tenant — lesson from tenant A does not affect tenant B
- [ ] Ambiguous edits do not produce false lessons

**Non-goals:** Cross-tenant learning (privacy); model fine-tuning from
corrections (V2 — V1 is prompt-level only); per-user (vs per-tenant)
lessons.

---

### P4-015 — Brand-voice configurator + locked profile validator

> **Size:** S | **Layer:** Onboarding | **AI Build:** High | **Human Review:** Moderate | **Wave:** 2
> **PRD codename:** N-011 (PRD v2 §9)
> **Day-in-the-life moments:** Every AI utterance in Mike's and Jenna's day; the bad-day "I'll check with [owner first name]" acknowledgment.

**Dependencies:** P4-001A (vertical pack registry), P2-027 (LLM gateway)

**Allowed files:**
`packages/api/src/tenants/brand/**`,
`packages/web/src/onboarding/brand/**`,
`packages/api/src/ai/brand-validator/**`,
`packages/api/migrations/*brand_voice*`,
`packages/shared/src/contracts/brand-voice.ts`

**Build prompt:** During tenant onboarding, capture brand-voice settings:
`register` (formal / friendly / casual), `opening_lines` (1–3 patterns
the AI uses to start conversations), `sign_off` (single string), `banned_
phrases` (free-text list), `shop_persona_name` (e.g., "M&R Mechanical's
office"), `owner_first_name` (used in escalation acknowledgments).
Persist as a versioned `brand_voice` JSONB on tenant with full history
in `brand_voice_versions`. Build a validator that runs on every AI-
generated outbound message (SMS, voice TTS script, invoice copy, review
response) before send: detects banned phrases, validates the opening
line is a configured pattern (for AI-initiated messages), and produces a
`brand_voice_drift` marker (per P2-035) if the message deviates. Changes
to brand voice are explicit web actions (not SMS); a 15-minute cool-down
applies before changes propagate. All changes audit-logged.

**Review prompt:** Verify the onboarding flow captures all six fields
and is completable in <5 minutes. Verify the validator runs on every
outbound channel (not just SMS). Verify cool-down prevents thrashing.
Verify history is queryable for retrospective analysis ("which voice
version was active when this message was sent?"). Verify drift detection
is precision-tuned to avoid alarm fatigue.

**Automated checks:**
```bash
cd packages/api && npx tsc --project tsconfig.build.json --noEmit
cd packages/api && npm test -- --grep "P4-015"
```

**Required tests:**
- [ ] Onboarding flow captures all six fields and persists
- [ ] Validator detects banned phrases in SMS, voice script, invoice
- [ ] Validator detects register drift (formal → casual without config
      change)
- [ ] Cool-down — change applied, but propagation delayed 15 min
- [ ] Audit — every change logged with prior + new value
- [ ] Drift marker attaches to proposal (P2-035 integration)

**Non-goals:** Multiple brand voices per tenant (V2); per-channel voice
variation (V2); auto-suggesting brand voice from existing communications
(V2).

---

### P5-020 — End-of-day digest generator

> **Size:** M | **Layer:** Reporting | **AI Build:** Medium | **Human Review:** Heavy | **Wave:** 2
> **PRD codename:** N-005 (PRD v2 §9)
> **Day-in-the-life moments:** Mike 7:30pm digest, Jenna 7:00pm digest, Mike bad-day 9:30pm digest with "what I wasn't sure about" + "what I learned today."

**Dependencies:** P1 (entities), P2 (proposals), P5 (invoices), P2-035 (markers), P2-038 (corrections), P2-034 (SMS transport)

**Allowed files:**
`packages/api/src/digest/**`,
`packages/api/src/workers/digest.*`,
`packages/api/migrations/*digest*`,
`packages/shared/src/contracts/digest.ts`

**Build prompt:** Generate a daily SMS summary delivered between 6pm
and 9pm in tenant local time. Trigger via a cron-style worker that runs
hourly across timezones. The digest is a single SMS (segmented if >320
chars) containing, in this order:

1. **Today** — jobs completed (count, $ invoiced, $ collected)
2. **Pipeline** — quotes sent (count, $ value)
3. **Follow-ups** — unpaid invoice follow-ups sent (count + outcomes)
4. **Tomorrow** — schedule confirmation summary (count + first/last
   appointment times)
5. **What I wasn't sure about today** — list of proposals where any
   P2-035 marker fired today, with what the owner did about each. Omit
   the section if zero items.
6. **What I learned today** — list of P2-038 correction lessons applied
   today. Omit if zero.
7. Sign-off appropriate to brand voice + a single optional reply
   prompt: "Reply LOOKS GOOD or tell me what to fix."

Persist each digest as a `digest_entries` row with the rendered text and
the source data references. Retry delivery up to 3 times within the
window. Track owner reply ("LOOKS GOOD" → ack; free text → record as
feedback signal).

**Review prompt:** Verify cron timing is timezone-correct (not UTC).
Verify the digest is deterministic from the day's data (regenerable on
demand). Verify section omissions are clean (no "no items today"
filler). Verify delivery retries do not duplicate. Verify the digest
does not include PII beyond what the owner has access to in normal
operation.

**Automated checks:**
```bash
cd packages/api && npx tsc --project tsconfig.build.json --noEmit
cd packages/api && npm test -- --grep "P5-020"
```

**Required tests:**
- [ ] Digest contents match underlying entity data for a synthetic day
- [ ] Timezone — tenant in Phoenix gets 6–9pm Phoenix-local delivery
- [ ] "What I wasn't sure about" omitted on a zero-marker day
- [ ] "What I learned today" omitted on a zero-lesson day
- [ ] Retry — delivery fails twice, succeeds on third attempt
- [ ] Idempotency — re-running the digest worker does not duplicate
- [ ] Owner reply — "LOOKS GOOD" recorded; free text recorded as feedback

**Non-goals:** Weekly digest (Wave 3); email digest (Wave 3); per-user
customization of digest contents (V2); push notifications (Wave 3+).

---

### P6-028 — Tech "I'm out" one-tap status

> **Size:** XS | **Layer:** Field Ops | **AI Build:** High | **Human Review:** Moderate | **Wave:** 2
> **PRD codename:** N-010 (PRD v2 §9)
> **Day-in-the-life moments:** Mike bad-day 5:00pm (Carlos no-shows because there's no way to mark out).

**Dependencies:** P1-008 (technician assignment), P2-034 (SMS transport), P7-001 (Twilio)

**Allowed files:**
`packages/api/src/sms/tech-status/**`,
`packages/api/src/scheduling/reschedule/**`,
`packages/api/migrations/*tech_status*`,
`packages/shared/src/contracts/tech-status-event.ts`

**Build prompt:** Allow a technician to mark themselves out for the
current day by replying `OUT`, `SICK`, or `UNAVAILABLE` to the shop's
SMS number from their registered mobile. On receipt: (a) update the
tech's status for today; (b) for each of the tech's remaining
appointments today, generate a `reschedule_appointment` proposal routed
to the owner via P2-034; (c) draft a customer-facing reschedule SMS in
brand voice (P4-015) attached to each proposal — the owner approves and
the customer is notified atomically. The owner can approve all in one
tap if multiple proposals are pending ("APPROVE ALL").

**Review prompt:** Verify tech identity is bound to the inbound number
(no spoofing via owner's own number). Verify same-day scope only.
Verify reschedule proposals are batched if 3+ for one-tap approval.
Verify customer SMS uses brand voice. Verify the appointment status
transitions atomically with proposal approval.

**Automated checks:**
```bash
cd packages/api && npx tsc --project tsconfig.build.json --noEmit
cd packages/api && npm test -- --grep "P6-028"
```

**Required tests:**
- [ ] Tech replies OUT → status updates and reschedule proposals fire
- [ ] Owner APPROVE ALL applies to all pending tech-status reschedules
- [ ] Customer SMS uses brand voice
- [ ] Wrong-number inbound is rejected (not a registered tech)
- [ ] Idempotent — second OUT reply same day is a no-op
- [ ] Status auto-clears at midnight tenant-local

**Non-goals:** Multi-day out status (V2); partial-day (e.g., "out after
2pm"); auto-rescheduling without owner approval.

---

### P7-026 — Google Business review monitoring + draft response

> **Size:** M | **Layer:** Reputation | **AI Build:** Medium | **Human Review:** Heavy | **Wave:** 2
> **PRD codename:** N-006 (PRD v2 §9)
> **Day-in-the-life moments:** Mike bad-day 5:00pm (1-star review from Mrs. Donovan after Carlos no-show; system drafts public response + private apology + service credit within the hour).

**Dependencies:** P0-014 (webhook base), P2-034 (SMS transport), P2-002 (proposal contracts)

**Allowed files:**
`packages/api/src/reputation/**`,
`packages/api/src/workers/google-reviews.*`,
`packages/api/migrations/*review*`,
`packages/shared/src/contracts/review-response-proposal.ts`

**Build prompt:** Poll Google Business Profile API for new reviews on a
15-minute interval per connected tenant. For each new review, classify
into `praise` / `specific_complaint` / `vague_complaint` /
`wrong_business`. For non-praise reviews, attempt to match the reviewer
to an existing customer (name, recent visit date). Draft a public
response in the locked brand voice (P4-015) that addresses the specific
complaint where possible. If the customer is matched, also draft a
private apology SMS or email and propose an optional service credit
amount ($25 / $50 / $100 tiers). Create a `review_response_proposal`
containing the public draft, private draft, and credit suggestion;
route to owner via P2-034. Owner can approve, edit, or reject each
component independently.

**Review prompt:** Verify polling backs off on Google API limits.
Verify customer matching is conservative (flag uncertain matches rather
than guess). Verify public response cannot leak private customer data
(e.g., addresses, phone numbers) even if the AI is tempted to include
them. Verify brand voice is enforced (P4-015). Verify service credit
amount is bounded ($100 max in V1 to limit blast radius).

**Automated checks:**
```bash
cd packages/api && npx tsc --project tsconfig.build.json --noEmit
cd packages/api && npm test -- --grep "P7-026"
```

**Required tests:**
- [ ] New review detected within 30 minutes of posting (mocked API)
- [ ] Classifier accuracy >85% on labeled fixture set
- [ ] Customer matching — high-confidence match attaches private draft;
      low-confidence flags as unverified
- [ ] Public response does not include PII (no address, phone, last name)
- [ ] Brand voice applied (golden examples)
- [ ] Credit suggestion capped at $100
- [ ] Owner can approve public, private, credit independently

**Non-goals:** Yelp, Facebook, Nextdoor monitoring (Wave 3); proactive
review-request sending (Wave 3); automatic credit application (always
owner-approved).

---

### P8-015 — Dropped-call SMS recovery

> **Size:** S | **Layer:** Intake | **AI Build:** Medium | **Human Review:** Heavy | **Wave:** 2
> **PRD codename:** N-007 (PRD v2 §9)
> **Day-in-the-life moments:** Mike bad-day 1:30pm (caller hangs up after 11 seconds; SMS goes out within 60s).

**Dependencies:** P8-001 (inbound calling agent), P7-001 (Twilio)

**Allowed files:**
`packages/api/src/voice/recovery/**`,
`packages/api/src/sms/recovery/**`,
`packages/api/migrations/*dropped_call*`,
`packages/shared/src/contracts/dropped-call-event.ts`

**Build prompt:** Detect when an inbound voice session ends without a
resolved outcome (caller hung up before booking or transfer, audio
quality failure, system error mid-call) and, within 60 seconds, send an
SMS to the caller in the shop's brand voice (P4-015). The SMS includes
a generic apology + a context cue if a partial transcript exists
("Sounds like you were calling about your AC — want to text or call back?
We're here."). The dropped-call event is threaded to the original intake
so a subsequent SMS reply continues the same conversation. Recovery is
suppressed if the call resulted in a successful booking or owner
transfer.

**Review prompt:** Verify drop detection within 5 seconds of session
end. Verify SMS within 60s P95. Verify the SMS does not go out for
successful or transferred calls. Verify partial transcript context is
sanitized (no PII leak in the SMS body). Verify recovery is rate-limited
per caller (no SMS spam if the caller keeps dropping).

**Automated checks:**
```bash
cd packages/api && npx tsc --project tsconfig.build.json --noEmit
cd packages/api && npm test -- --grep "P8-015"
```

**Required tests:**
- [ ] Hangup before booking → SMS sent within 60s
- [ ] Successful booking → no SMS
- [ ] Audio failure mid-call → SMS sent
- [ ] Partial transcript context included when available
- [ ] No transcript → generic SMS
- [ ] Threaded — subsequent reply belongs to same intake conversation
- [ ] Rate-limited — same caller within 5 min gets one SMS, not multiple

**Non-goals:** Outbound voice callback (V2); recovery for SMS-initiated
conversations (different problem); recovery for owner-cell patches
that fail (V2).

---

### P8-016 — Vulnerability-aware emergency triage

> **Size:** S | **Layer:** Intake | **AI Build:** Medium | **Human Review:** Heavy | **Wave:** 2
> **PRD codename:** N-008 (PRD v2 §9)
> **Day-in-the-life moments:** Mike 4:30pm (elderly woman with mom on oxygen, 104°F); Mike bad-day 11:00am (flat-voice elderly caller; supervisor agent catches what the primary missed).

**Dependencies:** P8-001 (inbound calling agent), P1-001 (customer entity with account_type + age fields)

**Allowed files:**
`packages/api/src/voice/triage/**`,
`packages/api/src/ai/vulnerability/**`,
`packages/api/src/integrations/weather/**`,
`packages/api/migrations/*vulnerability_signal*`,
`packages/shared/src/contracts/vulnerability-signal.ts`

**Build prompt:** Extend the inbound calling agent's escalation skill
to weigh four vulnerability signals in urgency classification:
- **Age**: caller mentions age >65, or matched customer record indicates
- **Weather**: tenant locale has temperature >100°F or <20°F in the last
  24h (fetch from weather provider, cached per locale per hour)
- **Medical**: caller utterance mentions oxygen, dialysis, breathing
  trouble, illness, infant, elderly relative
- **Property type**: known B2B account flagged as occupied (e.g.,
  property manager reporting on residents)

Signals combine into a vulnerability score. **Vulnerability + urgency**
(e.g., no AC + summer heat + age >65) → patch to owner's cell with a
5-second context preface ("Medical priority, no AC, elderly, your
customer since 2024. Putting them through.") rather than booking.
**Vulnerability alone** (no immediate urgency) → high-priority booking
with owner notification, not auto-booked into normal flow. If the owner
is unreachable for 60 seconds, fall back to high-priority booking and
SMS the owner what happened.

**Review prompt:** Verify signals are extracted from utterance content,
customer record, **and** weather API independently. Verify combination
logic does not bias against legitimate non-emergency calls (high
specificity). Verify the 5-second context preface is concise and
non-PII-leaky. Verify the fallback when owner is unreachable is sane.
Verify the system does not claim medical authority (the brand voice
must not say "you have a medical emergency" — just escalate the call).

**Automated checks:**
```bash
cd packages/api && npx tsc --project tsconfig.build.json --noEmit
cd packages/api && npm test -- --grep "P8-016"
```

**Required tests:**
- [ ] Age + urgency + weather → patches owner
- [ ] Medical mention + urgency → patches owner
- [ ] Age alone → high-priority booking, owner notified
- [ ] No vulnerability → normal flow
- [ ] Weather API failure → fall back to age + medical only
- [ ] Owner unreachable → high-priority booking + owner SMS
- [ ] Context preface excludes PII (no full address)
- [ ] Correct-escalation rate >95% on labeled fixture set

**Non-goals:** Real-time vital monitoring (not our domain); medical
priority routing to first responders (we do not claim authority);
self-reported disability status as a signal (privacy, regulatory).

# Wave 2 — Batch B — U2 Approval and action safety

**Branch:** `fix/ai-hardening-action-safety`  
**Execution plan:** `docs/plans/2026-10-18-003-chore-ai-hardening-execution-plan.md` (E3 protocol)  
**Technical plan:** `docs/plans/2026-10-18-002-fix-ai-enterprise-hardening-plan.md` unit U2 (PR #1695)  
**Audit baseline:** `origin/main` `20637e004`. Every file:line below is against that commit; re-verify before editing.

## Findings in this batch

| ID | Severity (verified) | Verdict | Title |
|---|---|---|---|
| OVAS-01 | high | confirmed | An AI estimate edit on an ACCEPTED estimate is approved by the machine and wipes the customer's signed acceptance with no human tap |
| OVAS-02 | high | partial | Auto-approval lets a technician self-execute writes their role withholds (invoices, estimates, bookings), on chat and on voice memos |
| PI-2 | medium | confirmed | Approving a create_standing_instruction proposal does not require settings:update, so non-owners can create 'OWNER STANDING INSTRUCTIONS' that the REST route restricts to owners |
| PI-3 | medium | confirmed | Correction-loop lessons rewrite the tenant catalog price, labor rate and brand-voice banned phrases for whoever approved, with no settings:update check, and the audit records the role as 'owner' |
| OVAS-03 | medium | confirmed | draft_estimate still copies the model's jobId; approval and execution never verify it (the sibling fix shipped only for draft_invoice) |
| OVAS-04 | medium | partial | The tenant auto-approve threshold override is ignored on the voice-memo surface and has no lower floor, so model-reported confidence becomes the whole gate |
| OBS-2 | medium | confirmed | An AI-drafted proposal cannot be traced to the model run that produced it, and ai_runs has no key back to the call or conversation |

## Build order and sequencing

Build order inside the batch:

1. **OVAS-01**: accepted target born `draft` (omit `sourceTrustTier` when accepted, the
   `create-appointment-task` `reviewGatedFallback` idiom); executor passes `allowAccepted` /
   `invalidateAcceptance` only with the `_acceptance` marker; SMS shows the marker's reason; exclude
   `_acceptance` proposals from digest batch approval and one-tap.
2. **OVAS-02**: ONE fail-closed helper in `proposals/` (e.g. `holdIfCallerCannotApprove`) mapping each
   auto-approvable type to its direct permission; called at both chat sites and in
   `voice-action-router` (memo creator's role from `voice_recordings.created_by` via the membership
   loader, fail closed). NOT on the D-015 autonomous lane. Delete `DIRECT_EXECUTION_PERMISSION`.
3. **PI-2**: `create_standing_instruction` into `CONFIG_WRITING_PROPOSAL_TYPES`; handler records the
   real `executedByRole`.
4. **PI-3**: stamp the approver for the line-item types; cascade lessons into catalog/settings only
   when the approver holds `settings:update`; pass the real approver id and role to
   `recordCorrectionLessons`.
5. **OVAS-03**: job id authored only from `asUuid(context.existingEntities?.jobId)`; prompt says
   "Never output a jobId"; `DraftEstimateExecutionHandler` checks the job belongs to the same
   customer; `jobReferenceCheck` ApprovalReferenceCheck for `draft_estimate`, `draft_invoice`,
   `create_appointment`, wired in `app.ts`.
6. **OVAS-04** items 1–2 only: thread `supervisorMode` on the memo path from `users.current_mode`;
   backstop in `resolveAutoApproveThreshold` when mode is undefined; estimate clarification and
   flagged branches blocked whatever the tenant threshold. No floor, no schema tightening.
7. **OBS-2** last: one correlation-metadata helper (`conversationId ?? sessionId ?? callSid`) on
   every drafting handler's `gateway.complete`; `aiRunId` on `CreateProposalInput` only when
   defined; classifier run stays as `sourceContext.classifierAiRunId`. No migration.
8. Deletions: `packages/api/src/ai/proposal-linkage.ts` and `createIntentRun` in
   `packages/api/src/voice/voice-audit.ts` are unimported on main (re-grep, then delete with tests).

## File ownership and hot spots

- `packages/api/src/app.ts`: wiring only, small hunks (every batch touches it).
- No migration in this batch.
- Do not touch the D-015 autonomous booking lane's auto-approve path (`docs/decisions.md` D-015).

## The unit as ruled in the technical plan (verbatim; this ruling wins)

### U2. Approval and action safety — batch B, `fix/ai-hardening-action-safety`

- **Goal:** no AI-drafted action executes past the human approval the role model requires, and every
  proposal traces to the model run that drafted it.
- **Requirements:** R1, R2, R4, R5
- **Dependencies:** none
- **Findings:** OVAS-01 (high), OVAS-02 (high, partial), OVAS-03, OVAS-04 (partial), PI-2, PI-3, OBS-2
  (all medium).
- **Files:**
  - `packages/api/src/ai/tasks/estimate-edit-task.ts`
  - `packages/api/src/ai/tasks/estimate-task.ts`
  - the other drafting task handlers
  - `packages/api/src/proposals/{proposal,auto-approve,actions,approval-reference-checks}.ts`
  - `packages/api/src/proposals/execution/{update-estimate-handler,handlers,standing-instruction-handler}.ts`
  - `packages/api/src/routes/assistant.ts`
  - `packages/api/src/workers/voice-action-router.ts`
  - the daily digest worker
  - `packages/api/src/learning/corrections/*`
  - `packages/api/src/ai/proposal-linkage.ts` (wire or delete)
  - `voice-audit.ts` `createIntentRun` (wire or delete)
  - wiring in `packages/api/src/app.ts`
  - Tests: next to each changed module, plus new `packages/api/test/integration/` files.
- **Approach:**
  - **OVAS-01**
    - An accepted target is born `draft`: omit `sourceTrustTier` when accepted, the same idiom as
      `create-appointment-task`'s `reviewGatedFallback`.
    - The executor passes `allowAccepted` / `invalidateAcceptance` only when the `_acceptance` marker
      is present.
    - The SMS shows the marker's reason.
    - Exclude `_acceptance` proposals from digest batch approval and one-tap.
  - **OVAS-02**
    - Write one fail-closed helper in `proposals/` (e.g. `holdIfCallerCannotApprove`) that maps each
      auto-approvable type to its direct permission:

      | Proposal type | Direct permission |
      |---|---|
      | `draft_estimate` | `estimates:create` |
      | `update_estimate` | `estimates:update` |
      | `draft_invoice` | `invoices:create` |
      | `update_invoice` | `invoices:update` |
      | `create_appointment`, `create_booking` | `appointments:create` |
      | `update_job` | `jobs:update` |

    - Call it at both chat sites and in `voice-action-router`. There, resolve the memo creator's role
      from `voice_recordings.created_by` via the membership loader, and fail closed when it can't be
      resolved.
    - Do NOT apply it to the D-015 autonomous lane (`docs/decisions.md` D-015).
    - Delete the old two-entry `DIRECT_EXECUTION_PERMISSION` allowlist and its incorrect comment.
  - **OVAS-03**
    - The job id is authored only from `asUuid(context.existingEntities?.jobId)`, and the prompt says
      "Never output a jobId".
    - `DraftEstimateExecutionHandler` loads the job and checks that it belongs to the same customer.
    - Add a `jobReferenceCheck` ApprovalReferenceCheck for `draft_estimate`, `draft_invoice` and
      `create_appointment`, wired in `app.ts`.
  - **OVAS-04** — only items 1–2:
    - Thread `supervisorMode` on the memo path from the creator's `users.current_mode`.
    - Backstop: when the mode is undefined, `resolveAutoApproveThreshold` uses the max of the legacy
      threshold and the defined overrides.
    - The estimate clarification and flagged branches are blocked whatever the tenant threshold is
      (stamp `low` or add a `missingFields` gate).
    - No threshold floor and no schema tightening. That is an owner decision.
  - **PI-2**
    - Add `create_standing_instruction` to `CONFIG_WRITING_PROPOSAL_TYPES`.
    - The handler records the real `executedByRole`.
  - **PI-3**
    - Stamp the approver for the line-item types.
    - Cascade a lesson into the catalog or settings only when the approver holds `settings:update`;
      otherwise record it without the cascade.
    - Pass the real approver id and role to `recordCorrectionLessons`.
  - **OBS-2**
    - No migration.
    - One helper that builds correlation metadata (`conversationId ?? sessionId ?? callSid`), used on
      every drafting handler's `gateway.complete`.
    - Set `aiRunId` on `CreateProposalInput` only when it is defined, since it is an FK.
    - Keep the classifier run as `sourceContext.classifierAiRunId`.
- **Test scenarios:**
  - **Unit**, handler-level with a mocked gateway, per finding:
    - an accepted target is born `draft`
    - the executor refuses an unmarked accepted target
    - a technician's `draft_invoice` lands in `ready_for_review` on chat and on a memo
    - a model-supplied `jobId` is ignored and the entities `jobId` is used
    - a memo with tenant override 1.0 is not auto-approved
    - a dispatcher approving `create_standing_instruction` gets `ForbiddenError` and an owner succeeds
    - a drafting proposal carries the drafting run's `aiRunId`
  - **Integration (OVAS-01):** `accepted_signature_data` survives an AI edit until a human approves.
  - **Integration (OVAS-03):** a dangling or foreign-tenant `jobId` produces no `estimates` row.
  - **Integration (PI-3):** a dispatcher approval leaves the catalog price and labor rate unchanged.
    An owner approval applies them with the correct `actor_role`.
- **Verification:** every scenario fails on `main` and passes on the branch, and approval UX is
  unchanged for owners.

## Per-finding work packages

Precedence for each finding: the plan ruling above, then the verifier's corrected fix, then the auditor's fix. Trigger, impact, evidence and reasoning are quoted in full from the audit so the implementer and the reviewer trace the same production path.

### OVAS-01 — An AI estimate edit on an ACCEPTED estimate is approved by the machine and wipes the customer's signed acceptance with no human tap

- **Severity:** high (auditor said critical). **Verdict:** confirmed. **Dimension:** action.
- **Locations (audit baseline):**
  - `packages/api/src/ai/tasks/estimate-edit-task.ts:152-156`
  - `packages/api/src/ai/tasks/estimate-edit-task.ts:251-279`
  - `packages/api/src/ai/tasks/estimate-edit-task.ts:341`
  - `packages/api/src/proposals/proposal.ts:630-681`
  - `packages/api/src/proposals/auto-approve.ts:246-265`
  - `packages/api/src/proposals/execution/update-estimate-handler.ts:108-126`
  - `packages/api/src/estimates/estimate.ts:556-600`
  - `packages/api/src/workers/estimate-reminder-worker.ts:108-121`
  - `packages/api/src/routes/assistant.ts:4386-4398`
  - `packages/api/src/workers/voice-action-router.ts:1887`
  - `packages/api/src/workers/voice-action-router.ts:1952-1955`
  - `packages/api/src/workers/daily-digest-worker.ts:706-710`

**Trigger (the real production path):**

An owner, dispatcher or technician types in chat, or records an in-app memo: "take the disposal fee off the Garcia estimate" (or adds a line that matches the catalog). Any user is in supervisor/both mode. The router resolves the reference to Garcia's estimate (existingEntities.estimateId), which the customer has already accepted/signed on the portal. The drafting model returns confidence_score >= the mode threshold. A remove action has no price, so the uncatalogued cap never fires. The router-verified id gives missingFields []. Hop chain: routes/assistant.ts:4255 handler.handle, or voice-action-router.ts:1887. Then EstimateEditTaskHandler.handle runs (estimate-edit-task.ts:251 detects accepted), then createProposal → decideInitialStatus returns 'approved' (proposal.ts:679-681). holdIfUnsupervised and holdForExecutability keep it approved, because no reference check looks at acceptance. The proposal is persisted (assistant.ts:4436 / router), the execution sweep picks it up after the 5 s undo window (execution-worker.ts:129), and UpdateEstimateExecutionHandler runs. I reproduced this with a mocked gateway and repo: an accepted target with supervisorMode undefined, 'supervisor' or 'tech' was born 'approved' every time.

**Impact:**

The customer's acceptance is voided and their e-signature data is deleted with no human ever approving it. Only the signer's name, time and selection are copied to the audit row; the signature is not. The estimate returns to 'sent' and the reminder budget is reset, so the next estimate-reminder sweep automatically re-sends the estimate link to the customer. lastContactAt falls back to the original sentAt, so that happens on the very next sweep, not 3 days later. The estimate total also changes. The only safeguard RV-042 designed is a 'review-time' marker, and no reviewer ever sees it on this path. The same marker-bearing proposal also qualifies for the digest 'APPROVE ALL' reply and the SMS one-tap, because it is capture-class and not 'low'.

**Evidence:**

estimate-edit-task.ts:152-156: `/** RV-042 — review-time marker for edits that void a customer's acceptance. */ export const ACCEPTANCE_VOID_MARKER = { path: '_acceptance', reason: "approving voids the customer's prior acceptance" }`. The accepted branch only adds the marker and keeps `overallConfidence: grounding.anyUncatalogued ? 'low' : getConfidenceLevel(confidenceScore)` (:274-276), then sets `sourceTrustTier: 'autonomous'` (:341). auto-approve.ts:246-249 blocks only `['low','very_low']`; markers are never consulted. update-estimate-handler.ts:110-125: `applyEstimateEdits(estimate, editActions, { allowAccepted: true })` … `invalidateAcceptance: true`. estimate.ts:589-599: `status: 'sent', acceptedAt: null, acceptedByName: null, acceptedByIp: null, acceptedUserAgent: null, acceptedSignatureData: null, acceptedSelection: null, lastRevisedAt: now, reminderCount: 0`. estimate-reminder-worker.ts:120: `const lastContactAt = remindedCurrent ? estimate.lastReminderAt : estimate.sentAt;`. Reproduction (<scratch>): `tech approved {"overallConfidence":"high","markers":[{"path":"_acceptance","reason":"approving voids the customer's prior acceptance"}]} []`. The existing tests (test/ai/tasks/estimate-edit-task.test.ts:501-563) assert that the marker exists, never the status.

**Verifier's reasoning (what is real, what was narrowed):**

I read the code and re-ran the auditor's probe (probe2.ts). The mechanism holds at every hop.

- estimate-edit-task.ts:251-283: an accepted target only adds ACCEPTANCE_VOID_MARKER. overallConfidence stays getConfidenceLevel(score), so it is 'high' for a remove action, which has no price and never hits the uncatalogued cap. The handler then sets sourceTrustTier:'autonomous' unconditionally (:341).
- When the router or chat pre-draft resolver supplied existingEntities.estimateId, resolveEstimateIdGate returns missingFields [] plus verifiedIds. update_estimate is in ESTIMATE_DOC_INTENTS, and chat uses the same resolveVoiceEntityReferences, so this happens on both surfaces.
- decideInitialStatus (proposal.ts:630-681): update_estimate is capture-class (proposal.ts:376). confidenceMetaBlocksAutoApprove only reads overallConfidence, never markers. Result: 'approved'.
- createProposal's voiceMutation guard does not apply. Only inapp-adapter sets voiceMutation; voice-action-router does not.
- Nothing downstream re-gates it:
  - Chat: holdIfUnsupervised (supervisor present), downgradeIfCallerLacksDirectPermission (maps only create_appointment/create_booking), holdForExecutability (no check covers update_estimate). The route then persists it.
  - Voice memo: holdIfUntrustedSource is a no-op for in-app memos.
  - The execution sweep has no role or marker check.
- UpdateEstimateExecutionHandler passes allowAccepted:true and invalidateAcceptance:true. updateEstimate (estimate.ts:556-600) nulls acceptedSignatureData and the other acceptance fields, and sets status 'sent' and reminderCount 0.
- The signature is not recoverable. snapshotOf() omits acceptance fields, and the invalidation audit row records only the name, time and selection.
- The reminder worker uses sentAt as lastContactAt after a revise (estimate-reminder-worker.ts:116-120), so it re-sends on the next sweep.
- The authenticated edit path refuses accepted estimates outright (assertEstimateEditable: "Clone it to a new estimate"), so the AI path does something the UI forbids, with no human tap.
- Secondary legs are also real. The SMS render only prints the marker reason when overallConfidence is 'medium' (render.ts:316), so a 'high' acceptance-voiding card shows no warning. Digest isBatchApprovable ignores markers.

Why high, not critical: only an authenticated internal user can trigger it, by explicitly asking to edit that estimate. It also needs a supervised tenant, a model self-score at or above threshold, and no paid deposit (the deposit lock still refuses). No money moves and nothing is reachable externally; voicemail is held. It is still destructive, irreversible loss of a customer's signed record plus automatic customer re-notification, so high is right.

**Fix to implement (verifier's corrected fix):**

The auditor's primary fix is correct: in EstimateEditTaskHandler, use `...(accepted ? {} : { sourceTrustTier: 'autonomous' })` so an acceptance-voiding edit is always born 'draft'. A belt-and-braces alternative in one place is to have decideInitialStatus treat a `_acceptance` marker as blocking. Defence in depth in UpdateEstimateExecutionHandler: pass allowAccepted / invalidateAcceptance only when payload._meta.markers contains `_acceptance`, so an estimate accepted after drafting fails closed. Show the marker reason in renderProposalSms regardless of the overall level, at least for `_acceptance`. Exclude `_acceptance`-marked proposals from digest isBatchApprovable / batchApprovableProposalIds. Keep the auditor's proposed tests: handler status 'draft' for an accepted target, executor refusal on an unmarked accepted target, and a Docker-gated integration test that accepted_signature_data survives an unmarked execution.

**Auditor's original fix (superseded where the corrected fix differs):**

In EstimateEditTaskHandler, omit the trust tier when the target is accepted: `...(accepted ? {} : { sourceTrustTier: 'autonomous' })`. This is the same idiom as create-appointment-task's reviewGatedFallback (`{ ...input, sourceTrustTier: undefined }`), so decideInitialStatus returns 'draft'. Exclude proposals carrying the `_acceptance` marker from daily-digest isBatchApprovable, and pass suppressApproveLink so the SMS one-tap is not offered for them. Defence in depth in UpdateEstimateExecutionHandler: pass `allowAccepted` / `invalidateAcceptance` only when `payload._meta.markers` contains `_acceptance`. An estimate the customer accepted after the draft was made then fails closed, because no human was shown the warning.

**Test specification (from the audit):**

Handler-level unit test (mocked gateway and estimateRepo) in test/ai/tasks/estimate-edit-task.test.ts: accepted target, supervisorPresent true, supervisorMode 'tech', confidence 0.99, remove_line_item → status 'draft'. Assert a non-accepted target still auto-approves. Unit test that batchApprovableProposalIds excludes a marker-bearing update_estimate. Executor unit test: accepted estimate plus an unmarked payload → success:false and estimateRepo.update never called. Docker-gated integration test (packages/api/test/integration/): executing an unmarked update_estimate against a real accepted estimates row leaves accepted_signature_data and status untouched.

**Acceptance criteria:**

- [ ] A test exists that fails on `origin/main` (or with this finding's fix hunk reverted) for the reason the trigger describes, and passes on the branch.
- [ ] The fix is reached from the trigger's real callers (trace recorded in the PR body), not only from the test.
- [ ] No caller of a changed function regressed; every existing test stays green or its pin is changed with the reason in the commit message.
- [ ] Dead code made dead by this fix is deleted in the same commit.
- [ ] Commit `fix(<area>): <defect in plain words>` names OVAS-01 in the body and ends with the session trailers.

### OVAS-02 — Auto-approval lets a technician self-execute writes their role withholds (invoices, estimates, bookings), on chat and on voice memos

- **Severity:** high (auditor said high). **Verdict:** partial. **Dimension:** action.
- **Locations (audit baseline):**
  - `packages/api/src/auth/rbac.ts:183-243`
  - `packages/api/src/routes/assistant.ts:2970-3013`
  - `packages/api/src/routes/assistant.ts:4386-4389`
  - `packages/api/src/workers/voice-action-router.ts:1808-1887`
  - `packages/api/src/workers/voice-action-router.ts:1952-1955`
  - `packages/api/src/workers/transcription-router-handoff.ts:86-88`
  - `packages/api/src/routes/voice.ts:503-507`
  - `packages/api/src/ai/tasks/estimate-task.ts:449`
  - `packages/api/src/ai/tasks/invoice-task.ts:645`
  - `packages/api/src/ai/tasks/invoice-edit-task.ts:411`
  - `packages/api/src/ai/tasks/estimate-edit-task.ts:341`
  - `packages/api/src/ai/tasks/create-appointment-task.ts:788`
  - `packages/api/src/ai/tasks/create-appointment-task.ts:959`
  - `packages/api/src/proposals/execution/create-booking-handler.ts:134-140`
  - `packages/api/test/routes/assistant-technician-field-intents.test.ts:186-191`

**Trigger (the real production path):**

(a) Chat. A technician (DB role from the membership row; holds ai:run and proposals:create but lacks proposals:approve, estimates:*, invoices:* and appointments:create) types "invoice the Miller job, capacitor replacement" or "remove the trip fee from INV-0042" while the owner is in supervisor mode. The handler sets 'autonomous', the lines match the catalog, and the model reports at least 0.95 (tech mode), so the proposal is born 'approved'. downgradeIfCallerLacksDirectPermission (assistant.ts:4389) maps only create_appointment and create_booking, so it stays approved. It is persisted, and the execution sweep creates or edits the invoice or estimate. (b) In-app voice memo. A technician records "book Mrs Miller Tuesday at 2" on the job page; POST /api/voice/recordings needs only files:upload. Transcription runs, then transcription-router-handoff enqueues voice_action_router with userId = recording creator. CreateAppointmentAITaskHandler places the hold and emits an autonomous create_booking. The router threads no supervisorMode, so the legacy 0.9 threshold applies. holdIfUnsupervised keeps it 'approved' when a supervisor is present, and nothing on this path checks the creator's role. CreateBookingExecutionHandler then confirms the booking and sends the customer confirmation SMS and email.

**Impact:**

This is privilege escalation through the approval queue. A role that cannot approve proposals gets approvals anyway, and invoice drafts and edits, estimate drafts and edits (including the acceptance-voiding edit in OVAS-01), and booked appointments with customer confirmations all run on that role's request alone. That contradicts the owner decision recorded in rbac.ts ("A technician speaks an estimate into existence; a permission holder approves it"). The executor does no permission check of its own, so nothing downstream catches it.

**Evidence:**

rbac.ts:195-201: `This is deliberately the ONLY grant needed… A technician speaks an estimate into existence; a permission holder approves it.` and `'ai:run'`. The technician list (183-243) has no proposals:approve, estimates:*, invoices:* or appointments:create. assistant.ts:2979: `the execution layer performs NO permission check of its own (verified: no hasPermission anywhere under proposals/execution/)`. assistant.ts:2989-2992: `const DIRECT_EXECUTION_PERMISSION = { create_appointment: 'appointments:create', create_booking: 'appointments:create' };`. The autonomous types it misses are estimate-task.ts:449, invoice-task.ts:645, invoice-edit-task.ts:411 and estimate-edit-task.ts:341 (`sourceTrustTier: 'autonomous'`). voice-action-router.ts:1952-1955 applies only `holdIfUntrustedSource(holdIfUnsupervised(annotated, supervisorPresent), …)` with no role gate; the creator's role is resolved only for lookups (:1428-1440). create-booking-handler.ts:135-140: `confirmationNotifier.enqueue({ … channels: ['sms', 'email'] })`. The existing test's premise is wrong (assistant-technician-field-intents.test.ts:187): `create_appointment is the one wired intent that carries sourceTrustTier:'autonomous'`. Pure-logic check (<scratch>): draft_estimate, draft_invoice, update_invoice, update_estimate, update_job, create_appointment and create_booking all return 'approved' at 0.95 with supervisorPresent and mode 'tech'.

**Verifier's reasoning (what is real, what was narrowed):**

The core bypass is real.

- Technicians hold ai:run and proposals:create but not proposals:approve, estimates:*, invoices:* or appointments:create (rbac.ts:183-243).
- Five shared handlers set sourceTrustTier:'autonomous': estimate-task:449, invoice-task:645, invoice-edit-task:411, estimate-edit-task:341, job-edit-task:228. Create-appointment sets it at :788 and :959. All are capture-class, so decideInitialStatus can return 'approved' (probe1 reproduced this for every type).
- In chat, downgradeIfCallerLacksDirectPermission's DIRECT_EXECUTION_PERMISSION map (assistant.ts:2989-2992) covers only create_appointment and create_booking. Its own doc comment says "Most drafting handlers pass no sourceTrustTier", which is factually false. So a technician's draft_estimate, draft_invoice, update_invoice or update_estimate can be born and persisted 'approved'.
- On the in-app memo path, voice-action-router applies no role check to proposals at all. Memo-creator identity is resolved only for lookup intents (:1428-1440), and holdIfUnsupervised / holdIfUntrustedSource keep 'approved'. A technician's memo booking can therefore auto-approve. CreateBookingExecutionHandler then confirms the hold and enqueues SMS and email confirmations (create-booking-handler.ts:134-140). This is exactly what the chat route deliberately blocks for technicians.
- The executor and execution worker do no permission check.

Why partial: the impact is narrower than stated for most types.
- draft_invoice and draft_estimate execution creates DRAFT documents (invoice status 'draft').
- update_invoice can only edit draft invoices (invoice-editor.ts:200).
- update_estimate on a sent estimate is refused at execute time.
- Issuing or sending still needs a separate money- or comms-class proposal that a permission holder must approve.
- So for the invoice and estimate types, the bypass yields internal draft records, not customer-facing or money effects.

The material harms are two:
- Technician memo bookings that confirm appointments and notify the customer.
- Technicians triggering the acceptance-voiding edit, which is OVAS-01 and not unique to technicians.

It stays high because it is a clear RBAC bypass of an explicitly documented owner decision. It yields customer-facing communications and calendar commits, and the chat route already treats this exact case as one that must be blocked.

**Fix to implement (verifier's corrected fix):**

Replace the two-entry allowlist with one fail-closed helper in proposals/ (e.g. holdIfCallerCannotApprove(proposal, role)). It downgrades a born-'approved' proposal to 'ready_for_review' unless the requesting actor's DB role holds the type's direct permission:
- draft_estimate→estimates:create
- update_estimate→estimates:update
- draft_invoice→invoices:create
- update_invoice→invoices:update
- create_appointment / create_booking→appointments:create
- update_job→jobs:update

Also require proposals:approve if that is the product intent. An unknown type or unknown role fails closed.

Where to call it:
- Both chat sites (assistant.ts ~4116 and ~4389).
- voice-action-router next to holdIfUnsupervised. Resolve the role from voice_recordings.created_by through the existing membership loader, and fail closed when it cannot be resolved.

Do NOT apply it to the D-015 autonomous-lane path (create-voice-turn-processor, or lane-eligible bookings carrying a system actor). That lane has its own gate set, and a blanket 'system creator downgrades' rule would silently disable it.

Also correct the stale doc comment at assistant.ts:2972-2980 and the false test premise in assistant-technician-field-intents.test.ts:187. Add a table-driven test that enumerates every handler setting 'autonomous' (count-pinned), plus a voice-action-router handler-level test where a technician-created memo booking is not 'approved' and confirmationNotifier is never called.

**Auditor's original fix (superseded where the corrected fix differs):**

Replace the two-entry allowlist with one fail-closed shared helper, for example `holdIfCallerCannotApprove(proposal, role)` in proposals/. It downgrades any born-'approved' proposal to 'ready_for_review' unless the requesting actor's DB role holds proposals:approve and the type's direct permission: draft_estimate→estimates:create, update_estimate→estimates:update, draft_invoice→invoices:create, update_invoice→invoices:update, create_appointment/create_booking→appointments:create, update_job→jobs:update. Unknown type, unknown role or a 'system' creator also downgrades. Call it at both chat sites (assistant.ts:4116 and :4389) and in voice-action-router next to holdIfUnsupervised. Resolve the memo creator's role from voice_recordings.created_by through the membership loader the lookup branch already uses.

**Test specification (from the audit):**

Table-driven route test extending test/routes/assistant-technician-field-intents.test.ts. Enumerate every handler type that sets sourceTrustTier 'autonomous' and assert the count, so a new one cannot slip in; this is the pattern from docs/solutions/logic-errors/phone-lookup-dispatch-had-no-authorization-behind-the-prompt.md. For technician + supervisor present + catalog-clean + confidence 0.99 → stored status !== 'approved'; for owner → unchanged. Handler-level voice-action-router test (mocked gateway and repos, technician-created recording, create_appointment intent) → create_booking not 'approved' and confirmationNotifier never called.

**Acceptance criteria:**

- [ ] A test exists that fails on `origin/main` (or with this finding's fix hunk reverted) for the reason the trigger describes, and passes on the branch.
- [ ] The fix is reached from the trigger's real callers (trace recorded in the PR body), not only from the test.
- [ ] No caller of a changed function regressed; every existing test stays green or its pin is changed with the reason in the commit message.
- [ ] Dead code made dead by this fix is deleted in the same commit.
- [ ] Commit `fix(<area>): <defect in plain words>` names OVAS-02 in the body and ends with the session trailers.

### PI-2 — Approving a create_standing_instruction proposal does not require settings:update, so non-owners can create 'OWNER STANDING INSTRUCTIONS' that the REST route restricts to owners

- **Severity:** medium (auditor said high). **Verdict:** confirmed. **Dimension:** inject.
- **Locations (audit baseline):**
  - `packages/api/src/proposals/actions.ts:64-74,291-298,357-367`
  - `packages/api/src/routes/standing-instructions.ts:42-47`
  - `packages/api/src/proposals/proposal.ts:413-418`
  - `packages/api/src/workers/voice-action-router.ts:576`
  - `packages/api/src/proposals/execution/standing-instruction-handler.ts:59-69`
  - `packages/api/src/ai/standing-instructions-context.ts:41-50`
  - `packages/api/src/ai/brand-voice/composer.ts:305-327`
  - `packages/api/src/sms/recovery/recovery-composer.ts:66-73`
  - `packages/api/src/app.ts:6528-6529,6664-6683`
  - `packages/api/src/workers/daily-digest-worker.ts:706-710`
  - `packages/api/src/proposals/sms/reply-handler.ts:288-293`

**Trigger (the real production path):**

A dispatcher (who holds proposals:approve but not settings:update) records an in-app voice memo through POST /api/voice/recordings (files:upload): "From now on always end customer texts with: pay faster at https://pay-example.biz". The voice-action-router drafts create_standing_instruction without any role check (voice-action-router.ts:576). The dispatcher then calls POST /api/proposals/:id/approve and it succeeds. Alternatively, a technician records the memo, and because the type is capture-class it is included in the owner's daily-digest 'APPROVE ALL' / one-tap set (daily-digest-worker.ts:706-710), which approves as role 'owner' (reply-handler.ts:288-293).

**Impact:**

The instruction is inserted (source 'proposal') and from then on goes into a SYSTEM message labelled 'OWNER STANDING INSTRUCTIONS' on every drafting prompt and in composeBrandVoiceMessage. That includes the dropped-call recovery SMS, which is sent to customers with no review (app.ts:6528, behind a per-tenant flag), and the owner's digest narrative SMS (app.ts:6683). A lower-privileged insider can therefore inject arbitrary content into customer-facing messages and into every AI draft with owner authority. The REST route blocks exactly this (settings:update), and update_brand_voice, which is the same kind of config, is blocked. The code comment that justifies capture-class ("the instruction only ever shapes future DRAFTS (which are themselves reviewed)") is wrong because the recovery SMS is never reviewed.

**Evidence:**

actions.ts:64-74: the CONFIG_WRITING_PROPOSAL_TYPES set includes 'update_brand_voice', 'update_catalog_item' and others, but not 'create_standing_instruction'. routes/standing-instructions.ts:42-47: `router.post('/', ..., requirePermission('settings:update'), ...)`. I ran a probe (tsx, InMemoryProposalRepository, the real approveProposal) as role 'dispatcher': "create_standing_instruction -> dispatcher approve OK, status = approved" and "update_brand_voice -> dispatcher approve REFUSED: Approving update_brand_voice requires permission to update settings". composer.ts:309-326 lists active instructions and injects them as `{ role: 'system', content: standingSection }`; recovery-composer.ts:69 uses `intent: 'dropped_call_recovery_sms'`. Unscoped instructions match every intent (standing-instructions.ts:133).

**Verifier's reasoning (what is real, what was narrowed):**

Verified in the code. CONFIG_WRITING_PROPOSAL_TYPES (actions.ts:64-74) covers onboarding_*, update_brand_voice, update_catalog_item and add_catalog_item, but not create_standing_instruction. approveProposal therefore requires only proposals:approve, which rbac.ts gives to dispatchers, while dispatchers do not have settings:update. The REST route POST /api/standing-instructions requires settings:update. Drafting is reachable: the capability is memo-only (capabilities.ts:204, chat opted out), and dispatchers and technicians both hold files:upload for in-app recordings. voice-action-router registers CreateStandingInstructionTaskHandler with no role check. The proposal lands as 'draft' and a dispatcher can approve it directly through POST /api/proposals/:id/approve (routes/proposals.ts:344-357 passes req.auth.role). CreateStandingInstructionExecutionHandler inserts it with source 'proposal' and actorRole 'system'. selectApplicableInstructions applies unscoped rules to every intent, and composeBrandVoiceMessage injects them as a separate system message labelled OWNER STANDING INSTRUCTIONS. That includes the dropped-call recovery SMS (app.ts:6528, composerDeps carries standingInstructionRepo), which is sent without review. I am lowering the severity from high to medium. The actor is an authenticated in-tenant employee who can already approve comms-class customer messages one at a time. The instruction is listed in Settings (settings:view) and is audited. The real gain is a persistent, owner-labelled influence on all drafts, plus the unreviewed recovery SMS. Two of the auditor's secondary claims are weak. The SMS APPROVE ALL path only considers 'ready_for_review' rows, while standing instructions land in 'draft'. And the digest batch and one-tap approvals come from the owner/approver phone, so that is a UX risk rather than this privilege escalation. The hardcoded 'owner' role on SMS approvals is a separate role-laundering issue that affects every config-writing type.

**Fix to implement (verifier's corrected fix):**

Add 'create_standing_instruction' to CONFIG_WRITING_PROPOSAL_TYPES in proposals/actions.ts. That alone closes the bypass and stamps executedBy/executedByRole at approval. In CreateStandingInstructionExecutionHandler, pass context.executedByRole (not 'system') to createStandingInstruction so the audit names the real approver. Add a unit test: a dispatcher approving create_standing_instruction gets ForbiddenError, an owner succeeds, and executedByRole is stamped. Excluding the type from the digest batch, one-tap and APPROVE ALL paths is optional hardening, not a requirement for this finding. If the SMS approver can be a non-owner backup supervisor, track the hardcoded 'owner' role in reply-handler.ts as a separate finding.

**Auditor's original fix (superseded where the corrected fix differs):**

Add 'create_standing_instruction' to CONFIG_WRITING_PROPOSAL_TYPES in proposals/actions.ts. The existing guard then requires settings:update, and executedBy/executedByRole get stamped so the audit names the real approver. Also exclude config-writing types from isBatchApprovable / buildApprovalLinks in daily-digest-worker.ts, and from the SMS Y/APPROVE ALL path, which hardcodes 'owner'. For defence in depth, have CreateStandingInstructionTaskHandler fence context.message through untrustedTaskTextForPrompt when context.untrustedMessage is set.

**Test specification (from the audit):**

Unit: test/proposals/actions-config-writing.test.ts (or the existing approve tests) — approveProposal(..., 'dispatcher') on create_standing_instruction throws ForbiddenError, 'owner' succeeds, and executedByRole is stamped. Unit: test/workers/daily-digest-worker.test.ts — batchApprovableProposalIds excludes a create_standing_instruction approval. Unit: proposals/sms reply-handler test — APPROVE ALL skips it.

**Acceptance criteria:**

- [ ] A test exists that fails on `origin/main` (or with this finding's fix hunk reverted) for the reason the trigger describes, and passes on the branch.
- [ ] The fix is reached from the trigger's real callers (trace recorded in the PR body), not only from the test.
- [ ] No caller of a changed function regressed; every existing test stays green or its pin is changed with the reason in the commit message.
- [ ] Dead code made dead by this fix is deleted in the same commit.
- [ ] Commit `fix(<area>): <defect in plain words>` names PI-2 in the body and ends with the session trailers.

### PI-3 — Correction-loop lessons rewrite the tenant catalog price, labor rate and brand-voice banned phrases for whoever approved, with no settings:update check, and the audit records the role as 'owner'

- **Severity:** medium (auditor said medium). **Verdict:** confirmed. **Dimension:** inject.
- **Locations (audit baseline):**
  - `packages/api/src/routes/proposals.ts:498-502`
  - `packages/api/src/app.ts:1513-1525,2265-2276`
  - `packages/api/src/learning/corrections/record-on-execution.ts:112-188`
  - `packages/api/src/learning/corrections/correction-extractor.ts:141-191`
  - `packages/api/src/learning/corrections/apply-undo.ts:57,72-74`
  - `packages/api/src/workers/execution-worker.ts:154`
  - `packages/api/src/proposals/actions.ts:357-367,724-726`
  - `packages/api/src/routes/catalog-items.ts:96-100`

**Trigger (the real production path):**

A dispatcher (proposals:edit + proposals:approve) calls PUT /api/proposals/:id on an AI draft_estimate and changes the unitPrice of a catalog-bound material line (or of a labor line), then calls POST /api/proposals/:id/approve. Execution fires onExecuted, which runs recordCorrectionLessonsOnExecution (app.ts:2265). The extractor emits part_price_changed or labor_rate_changed from that single edit, and recordCorrectionLessons applies it immediately.

**Impact:**

A non-owner rewrites the tenant price book (catalogRepo.update unitPriceCents, app.ts:1523-1525), and the catalog is what every later AI-drafted price is grounded to (CLAUDE.md catalog rule). The catalog route itself requires settings:update (routes/catalog-items.ts:100), and so does undoing a lesson (actions.ts:724), but applying one does not. The audit trail is also wrong. draft_estimate is not config-writing, so the approver is never stamped (actions.ts:363-367), executedBy falls back to the drafter (execution-worker.ts:154), and the correction_lesson.applied event is written with actorRole 'owner' by default (apply-undo.ts:57). The comment at actions.ts:357-360 warns about exactly this.

**Evidence:**

apply-undo.ts:57: `const actorRole = deps.actorRole ?? 'owner';` and :72-74: `const created = await repository.create(lesson); // Cascade the config change forward within the day. await applyLessonConfig(input.tenantId, created.payload, ports);`. record-on-execution.ts:183-188 passes `ownerId: execution.executedBy` and no actorRole. execution-worker.ts:154: `executedBy: proposal.executedBy ?? proposal.createdBy`. correction-extractor.ts:166-190 emits part_price_changed for any catalog-bound material line whose price differs from the catalog. Owner decision 9.8(b) removed the UI price edit, but PUT /api/proposals/:id (requirePermission('proposals:edit')) still accepts the edit and the lesson still cascades.

**Verifier's reasoning (what is real, what was narrowed):**

Verified in the code. PUT /api/proposals/:id requires only proposals:edit, and editProposal takes an arbitrary `edits` record validated against the payload schema. Nothing blocks unit-price changes on catalog-bound lines, and the first edit keeps originalPayload. approveProposal stamps executedBy/executedByRole only for adopt_entity_alias and CONFIG_WRITING types, so a draft_estimate or draft_invoice executes with executedBy = createdBy, the drafter (execution-worker.ts:154). On success, app.ts:2265 calls recordCorrectionLessonsOnExecution. For a catalog-bound material line whose price differs from the catalog, the extractor emits part_price_changed; for any labor-line price that differs from the tenant rate it emits labor_rate_changed. recordCorrectionLessons calls applyLessonConfig right away, and correctionConfigPorts writes catalogRepo.update(unitPriceCents) and settingsRepo.update(laborRateCentsPerHour). There is no permission check anywhere on this path. The audit actorRole defaults to 'owner' (apply-undo.ts:57), and ownerId is the drafter. The asymmetry is real: undoing a lesson requires settings:update (actions.ts:724) and the catalog routes require settings:update, but applying a lesson does not. This is an authorization or integrity issue rather than prompt injection, but it is real and medium severity is right. The actor is an in-tenant dispatcher, the change is audited (with the wrong role) and can be undone by an owner, but it silently rewrites the price book that grounds every later AI price.

**Fix to implement (verifier's corrected fix):**

Stamp the approver at approval for line-item types (draft_estimate, update_estimate, draft_invoice, update_invoice), setting executedBy=actorId and executedByRole=actorRole as CONFIG_WRITING types already do. In recordCorrectionLessonsOnExecution, read proposal.executedByRole. When it is missing, or hasPermission(role as Role, 'settings:update') is false, do not call applyLessonConfig. Either skip recording, or record the lesson without cascading and let the existing detectCorrectionRepetition path raise a reviewed update_catalog_item proposal, which is already settings:update-gated. Always pass the real approver id and role into recordCorrectionLessons (ownerId, actorRole) so correction_lesson.applied is accurate. Pin this with the Docker-gated integration test the auditor describes (dispatcher: catalog and labor rate unchanged; owner: applied, with the correct actor_role).

**Auditor's original fix (superseded where the corrected fix differs):**

In recordCorrectionLessonsOnExecution, cascade a lesson only when the approver holds settings:update. Stamp executedBy/executedByRole at approval for line-item types (draft_estimate, draft_invoice, update_estimate, update_invoice) the same way CONFIG_WRITING types are, then check hasPermission(executedByRole, 'settings:update') before recordCorrectionLessons. When the check fails, emit an update_catalog_item proposal instead; that type is already CONFIG_WRITING-gated. Pass the real actorRole into recordCorrectionLessons so the audit row is accurate.

**Test specification (from the audit):**

Docker-gated integration (DB-touching): extend packages/api/test/integration/correction-loop-reachability-9-8-9-9.test.ts. Case 1: a dispatcher edits and approves a catalog-bound material line price, so the catalog_items.unit_price_cents and labor_rate_cents_per_hour values are unchanged and no lesson is 'applied'. Case 2: an owner does the same, so the lesson is applied and the correction_lesson.applied audit row carries actor_role='owner' and the owner's id. Unit: record-on-execution with fake ports asserts that no port is called when executedByRole lacks settings:update.

**Acceptance criteria:**

- [ ] A test exists that fails on `origin/main` (or with this finding's fix hunk reverted) for the reason the trigger describes, and passes on the branch.
- [ ] The fix is reached from the trigger's real callers (trace recorded in the PR body), not only from the test.
- [ ] No caller of a changed function regressed; every existing test stays green or its pin is changed with the reason in the commit message.
- [ ] Dead code made dead by this fix is deleted in the same commit.
- [ ] Commit `fix(<area>): <defect in plain words>` names PI-3 in the body and ends with the session trailers.

### OVAS-03 — draft_estimate still copies the model's jobId; approval and execution never verify it (the sibling fix shipped only for draft_invoice)

- **Severity:** medium (auditor said medium). **Verdict:** confirmed. **Dimension:** action.
- **Locations (audit baseline):**
  - `packages/api/src/ai/tasks/estimate-task.ts:42-58`
  - `packages/api/src/ai/tasks/estimate-task.ts:122-136`
  - `packages/api/src/ai/tasks/invoice-task.ts:160-176`
  - `packages/api/src/ai/tasks/invoice-task.ts:366-377`
  - `packages/api/src/proposals/execution/handlers.ts:947-1052`
  - `packages/api/src/proposals/approval-reference-checks.ts:143-155`
  - `packages/api/src/db/schema.ts:526`
  - `packages/api/src/workers/voice-action-router.ts:1808-1887`
  - `packages/api/src/routes/assistant.ts:1220-1237`

**Trigger (the real production path):**

A voice memo (voice-action-router.ts:1887 → shared EstimateTaskHandler) such as "quote Khan a capacitor replacement". The prompt template invites a jobId, and the drafting model emits one. Live QA logged the model inventing ids, including the RFC 4122 example uuid, which passes asUuid. The memo path has no dropUnverifiedIds scrub. I reproduced it: a model jobId of 123e4567-e89b-12d3-a456-426614174000, a catalog-matched line and confidence 0.95 gave status 'approved', payload.jobId set to that uuid, and missingFields [].

**Impact:**

1. A fabricated id auto-approves and then fails at execution on the FK (approve-to-fail, the D-029 class), so the estimate silently never exists. 2. A real job id the model echoes from context but that belongs to a different customer than the resolver's customerId attaches the estimate to that customer's job. Estimates carry no customer; the job decides who receives it on send. 3. estimates.job_id references jobs(id) without tenant_id. A foreign-tenant job uuid typed into chat survives dropUnverifiedIds because it appears in the operator's text, and Postgres accepts the row. 4. The route-verified job-page jobId in existingEntities is ignored unless the model echoes it, so a memo recorded on a job page can open a duplicate job.

**Evidence:**

estimate-task.ts:46: `"jobId": "<uuid, optional>",`. estimate-task.ts:133-136: `const jobId = asUuid(parsed.jobId); if (jobId) { payload.jobId = jobId; }`. The sibling invoice-task.ts:166-169 says: `a fabricated jobId is WORSE than a fabricated customerId: CreateInvoiceExecutionHandler writes it straight onto the invoice as the job container and skips the auto-open-a-job path entirely` and authors the id from `existingEntities` only. handlers.ts:953-954 reads `let jobId = typeof payload.jobId === 'string' … ? payload.jobId : undefined`; only customerId is existence-checked (:997-1007); jobRepo is used only when `!jobId` (:1012), and createEstimate gets `jobId` (:1050-1052). approval-reference-checks.ts:150: `if (typeof jobId === 'string' && jobId.length > 0) return [];`. No jobId reference check exists. schema.ts:526: `job_id UUID NOT NULL REFERENCES jobs(id),`. Reproduction: <scratch> → `approved jobId= 123e4567-e89b-12d3-a456-426614174000 … missing= []`.

**Verifier's reasoning (what is real, what was narrowed):**

Verified and reproduced (probe3: status approved, jobId = RFC example uuid, missingFields []).

- estimate-task.ts:46 still prompts for `"jobId": "<uuid, optional>"`. buildPartialPayload copies asUuid(parsed.jobId) (:133-136), and handle() never re-authors or verifies it. The RFC 4122 example uuid passes UUID_PATTERN (version nibble 1, variant a).
- invoice-task explicitly stopped reading the model's jobId for exactly this reason. The estimate sibling was not fixed.
- On the memo path, voice-action-router runs no dropUnverifiedIds scrub. Chat does scrub ids absent from the operator's text or entities.
- At approval, no job reference check exists among the checks wired in app.ts (1090-1117). serviceLocationReferenceCheck and executionAnchorReferenceCheck treat any non-empty jobId as satisfying the anchor.
- DraftEstimateExecutionHandler existence-checks only customerId. When jobId is present it never loads the job and passes it straight to createEstimate (handlers.ts:953-1052).
- estimates.job_id REFERENCES jobs(id) has no composite tenant key (schema.ts:526).

Consequences:
- A fabricated uuid auto-approves and then fails on the FK (approve-to-fail).
- A memo recorded on a job page whose model output omits jobId ignores the route-verified existingEntities.jobId, and the executor auto-opens a duplicate job.
- An echoed job id for a different customer than the resolved customerId is never cross-checked.

The cross-tenant leg is theoretical: it requires a foreign tenant's job uuid in the operator's own words, and nobody speaks uuids. Medium is the right severity, since the realistic outcomes are failed or mis-filed draft estimates, not data exposure.

**Fix to implement (verifier's corrected fix):**

The auditor's fix is correct.

- In EstimateTaskHandler, stop reading parsed.jobId, author payload.jobId from asUuid(context.existingEntities?.jobId), and change the prompt line to "Never output a jobId".
- In DraftEstimateExecutionHandler, when jobId is present, require jobRepo.findById(tenantId, jobId) to return a job, and require job.customerId === customerId whenever customerId is set. Otherwise return success:false.
- Add a jobReferenceCheck ApprovalReferenceCheck (draft_estimate, draft_invoice, create_appointment) wired in app.ts, so holdForExecutability and approveProposal hold a dangling or mismatched jobId.
- Tests: unit test that a model jobId is ignored and the entities jobId is used; unit tests for the check; a Docker-gated integration test that a nonexistent or foreign-tenant jobId produces no estimates row.

**Auditor's original fix (superseded where the corrected fix differs):**

Mirror invoice-task: stop reading parsed.jobId, author `payload.jobId` from `asUuid(context.existingEntities?.jobId)`, and replace the jobId line in ESTIMATE_SYSTEM_PROMPT with "Never output a jobId". In DraftEstimateExecutionHandler, when jobId is present, require `jobRepo.findById(context.tenantId, jobId)` to return a job, and require `job.customerId === customerId` whenever customerId is set; otherwise return success:false. Add a jobReferenceCheck ApprovalReferenceCheck for draft_estimate, draft_invoice and create_appointment, wired in app.ts, so holdForExecutability and approveProposal hold or refuse a dangling or mismatched jobId.

**Test specification (from the audit):**

Unit test in test/ai/tasks/estimate-task.test.ts: a model jobId is ignored and existingEntities.jobId is used. Unit test for jobReferenceCheck (missing, mismatched customer, and a valid id). Docker-gated integration test (packages/api/test/integration/): DraftEstimateExecutionHandler with a non-existent jobId and with a jobId owned by a second tenant → success:false and no estimates row. This pins the non-composite FK against real Postgres, per the mocked-pool learning.

**Acceptance criteria:**

- [ ] A test exists that fails on `origin/main` (or with this finding's fix hunk reverted) for the reason the trigger describes, and passes on the branch.
- [ ] The fix is reached from the trigger's real callers (trace recorded in the PR body), not only from the test.
- [ ] No caller of a changed function regressed; every existing test stays green or its pin is changed with the reason in the commit message.
- [ ] Dead code made dead by this fix is deleted in the same commit.
- [ ] Commit `fix(<area>): <defect in plain words>` names OVAS-03 in the body and ends with the session trailers.

### OVAS-04 — The tenant auto-approve threshold override is ignored on the voice-memo surface and has no lower floor, so model-reported confidence becomes the whole gate

- **Severity:** medium (auditor said medium). **Verdict:** partial. **Dimension:** action.
- **Locations (audit baseline):**
  - `packages/api/src/proposals/auto-approve.ts:154-202`
  - `packages/api/src/workers/voice-action-router.ts:1741-1775`
  - `packages/api/src/workers/voice-action-router.ts:1808-1885`
  - `packages/api/src/shared/contracts.ts:558-567`
  - `packages/api/src/ai/tasks/estimate-task.ts:36-40`
  - `packages/api/src/ai/tasks/estimate-task.ts:342-350`
  - `packages/api/src/ai/tasks/estimate-task.ts:380-382`
  - `packages/api/src/proposals/autonomous-lane.ts:82`
  - `packages/api/src/proposals/autonomous-lane.ts:275-277`
  - `packages/api/src/ai/guardrails/confidence.ts:51-54`

**Trigger (the real production path):**

(a) An enterprise owner sets Settings → AI approval rules to {supervisor:1, tech:1, both:1}, the strictest values allowed. A memo then drafts a catalog-clean draft_invoice that the model scores 0.92. voice-action-router resolves and threads tenantThresholdOverride but never supervisorMode, so resolveAutoApproveThreshold returns LEGACY 0.9 before reading the override, and the proposal is 'approved'. Checked: memo path → approved; the same input with a mode → draft. (b) An owner lowers the override to 0.5. An estimate that still has open clarification questions or was flagged at the loop cap is capped to 0.5, but its _meta is stamped 'medium', so it auto-approves. Checked: → approved. With override 0, any autonomous capture proposal without a 'low' stamp (update_job stamps no _meta at all) auto-approves on whatever the model self-reports.

**Impact:**

The only per-tenant control over AI autonomy does not hold. It is silently skipped on one production surface, and on the others it can be set below the numeric caps the handlers' safety comments rely on. Even the maximum value (1.0) is not an off switch, because the model can self-report 1.0. An enterprise that configures "require review" still gets machine-approved invoices, estimates and bookings from memos. D-015 put a code-enforced floor only on the booking lane and rejected "global threshold lowering", but the global override has no floor.

**Evidence:**

auto-approve.ts:164-194: `if (input.supervisorMode === undefined) { … return LEGACY_AUTO_APPROVE_THRESHOLD; }`, which returns before `const override = input.tenantOverride?.[input.supervisorMode];` at :196. voice-action-router.ts:1741-1775 resolves `tenantThresholdOverride` and threads it at :1884 (`...(tenantThresholdOverride ? { tenantThresholdOverride } : {})`), and the file has zero references to supervisorMode. contracts.ts:561-566: `supervisor: z.number().min(0).max(1).optional()`. estimate-task.ts:36-40: `Sits well below every auto-approve threshold so such a draft always lands in 'draft'`, but the meta at :380-382 is `getConfidenceLevel(confidenceScore)`, which is 'medium' at 0.5 (confidence.ts:51-54). autonomous-lane.ts:275-277: `Math.max(AUTONOMOUS_BOOKING_THRESHOLD_FLOOR, input.settings.threshold ?? …)`. Probes: <scratch> → `memo path (no mode), override=1.0: approved` versus `chat path (mode=supervisor), override=1.0: draft`; probe1.ts → `clarify-capped w/ override 0.5: approved`.

**Verifier's reasoning (what is real, what was narrowed):**

Part (a) is confirmed.

- resolveAutoApproveThreshold returns LEGACY_AUTO_APPROVE_THRESHOLD (0.9) as soon as supervisorMode is undefined (auto-approve.ts:164-194). That happens before the tenantOverride lookup at :196.
- voice-action-router resolves and threads tenantThresholdOverride (:1741-1775, :1884) but has zero references to supervisorMode.
- So on the in-app memo surface the tenant override is silently ignored, and so are the per-mode defaults (tech 0.95).
- probe4 reproduced it: memo path with override 1.0 → approved; chat path with mode → draft. A tenant that picks the UI's 'strict' preset {0.95, 0.97, 0.99} still gets 0.9 on memos.

Part (b) is real in mechanism but largely by design.
- The UI deliberately exposes a permissive preset (0.85/0.88/0.92) and Advanced inputs from 0.50 to 0.99 (AIApprovalRulesSheet.tsx:57, :306-308). Only an owner with settings:update can set it.
- A 0 override is reachable only by an owner calling the API directly.
- '1.0 is not an off switch' is not a defect: no code or UI claims it is, and the UI max is 0.99.
- The one genuine invariant break in (b) is narrower than stated. estimate-task's CLARIFICATION_REVIEW_CONFIDENCE_CAP (0.5) comment promises such drafts "always land in 'draft'", but they are stamped 'medium', so an owner-set 0.5 threshold auto-approves a clarification-pending or flagged draft (probe1 confirmed).
- The effect is a DRAFT estimate record, not customer-facing.

Medium overall, driven by (a).

**Fix to implement (verifier's corrected fix):**

1. On the memo path, thread supervisorMode from the memo creator's users.current_mode (voice_recordings.created_by). As a backstop in resolveAutoApproveThreshold, when the mode is undefined but tenantOverride has values, use max(LEGACY_AUTO_APPROVE_THRESHOLD, ...defined override values) instead of dropping the override.

2. Make the estimate clarification gate threshold-independent. Stamp `_meta.overallConfidence: 'low'`, or add a missingFields gate, on the clarification-pending and flagged-for-review branches, so the 0.5 cap no longer depends on the tenant threshold staying above it.

3. Do NOT tighten shared/contracts.ts to min(0.9), and do not clamp overrides into [0.9, 1] without a product decision. That would silently break the shipped 'permissive' preset and the 0.50 Advanced input. If a floor is wanted, change the web UI and schema together, and set the floor just above the handler caps (UNCATALOGUED_CONFIDENCE_CAP and the clarification cap), not at 0.9.

Tests: auto-approve unit test where no mode plus override {tech:1} honours 1; voice-action-router handler test where an all-1.0 resolver with model 0.95 is not 'approved'; estimate-task test where a missing_quantity clarification with override 0.5 is not 'approved'.

**Auditor's original fix (superseded where the corrected fix differs):**

In resolveAutoApproveThreshold, clamp any override into [LEGACY_AUTO_APPROVE_THRESHOLD, 1], the same Math.max idiom as AUTONOMOUS_BOOKING_THRESHOLD_FLOOR. When supervisorMode is undefined but an override exists, use the strictest of the defined override values and the legacy default instead of dropping the override. Thread supervisorMode in voice-action-router from the memo creator's users.current_mode. Tighten the shared/contracts.ts schema to min(0.9). In estimate-task, stamp `_meta.overallConfidence: 'low'` on the clarification-pending and flagged-for-review branches, so they are hard-blocked whatever the threshold. A sticky 'low' is safe here because a clarification is answered by a re-draft.

**Test specification (from the audit):**

Unit tests in test/proposals/auto-approve.test.ts: no mode with override {tech:1} → threshold 1 is honoured; override {supervisor:0.5} → clamped to 0.9. Handler-level voice-action-router test (mocked gateway and repos): thresholdResolver returns all-1.0, model 0.95 → not 'approved'. estimate-task unit test: a missing_quantity clarification with override 0.5 → not 'approved'.

**Acceptance criteria:**

- [ ] A test exists that fails on `origin/main` (or with this finding's fix hunk reverted) for the reason the trigger describes, and passes on the branch.
- [ ] The fix is reached from the trigger's real callers (trace recorded in the PR body), not only from the test.
- [ ] No caller of a changed function regressed; every existing test stays green or its pin is changed with the reason in the commit message.
- [ ] Dead code made dead by this fix is deleted in the same commit.
- [ ] Commit `fix(<area>): <defect in plain words>` names OVAS-04 in the body and ends with the session trailers.

### OBS-2 — An AI-drafted proposal cannot be traced to the model run that produced it, and ai_runs has no key back to the call or conversation

- **Severity:** medium (auditor said high). **Verdict:** confirmed. **Dimension:** observe.
- **Locations (audit baseline):**
  - `packages/api/src/ai/gateway/gateway.ts:532-537`
  - `packages/api/src/ai/gateway/gateway.ts:545-557`
  - `packages/api/src/db/schema.ts:174-192`
  - `packages/api/src/ai/orchestration/intent-classifier.ts:3251-3255`
  - `packages/api/src/ai/tasks/estimate-task.ts:209-221`
  - `packages/api/src/ai/tasks/estimate-task.ts:439-462`
  - `packages/api/src/routes/assistant.ts:3550`
  - `packages/api/src/routes/assistant.ts:4255`
  - `packages/api/src/routes/assistant.ts:4436`
  - `packages/api/src/workers/voice-action-router.ts:1246`
  - `packages/api/src/workers/voice-action-router.ts:1887`
  - `packages/api/src/workers/voice-action-router.ts:2179`
  - `packages/api/src/ai/tasks/invoice-task.ts:337`
  - `packages/api/src/ai/tasks/create-appointment-task.ts:589`
  - `packages/api/src/ai/tasks/send-customer-message-task.ts:140`
  - `packages/api/src/ai/tasks/mms-estimate-task.ts:160`
  - `packages/api/src/voice/voice-audit.ts:233`

**Trigger (the real production path):**

An owner types 'Draft an estimate for Jane: replace capacitor' in chat. classifyIntent runs (assistant.ts:3550) and its returned aiRunId is never read; routes/assistant.ts has 0 occurrences of aiRunId. EstimateTaskHandler.handle (assistant.ts:4255) calls `gateway.complete({ taskType: 'draft_estimate', tenantId, messages, responseFormat: 'json' })` with no metadata (estimate-task.ts:209-221). It then builds CreateProposalInput without aiRunId (estimate-task.ts:439-462), and the route persists that proposal (assistant.ts:4436). The recorded-memo path behaves the same way: voice-action-router.ts:1246 classifies, :1887 dispatches the handler, :2179 runs createMany, and the file has 0 aiRunId references. The other drafting handlers (invoice, create-appointment, send-customer-message, mms-estimate, job/estimate/invoice edit) also pass no metadata and set no aiRunId.

**Impact:**

Each gateway call writes `correlation_id = metadata.correlationId ?? uuidv4()` (gateway.ts:533-534), and almost no call site supplies one, so the value is a fresh random UUID. The gateway reads metadata.sessionId (gateway.ts:537), and the classifier sends sessionId and callSid (intent-classifier.ts:3251-3255), but the gateway gives those only to the optional Langfuse exporter, which is off by default. ai_runs has no session, call, conversation or proposal column (schema.ts:174-192; only cost_micro_cents was added later). So: (a) proposals.ai_run_id is NULL for every chat-drafted and memo-drafted proposal. (b) The draft_estimate run, whose model output became the line items and prices, links to nothing. (c) Given a callSid or conversation id, nobody can list the AI runs that happened on it. The question 'why did the AI quote $X on this conversation?' can only be answered by guessing on timestamps per tenant and task type, which a SOC 2 auditability review rejects. The per-turn link that was designed, VoiceIntentRun.aiRunId via createIntentRun (voice-audit.ts:233), is never called.

**Evidence:**

I ran a probe with the real LLMGateway, EstimateTaskHandler and a capturing AiRunRepository (<scratch>). Output: `ai_runs rows: 1 taskType: [ 'draft_estimate' ] correlationId: [ '0b1d9357-…' ]` and `proposal.aiRunId = undefined | sourceContext = {"conversationId":"conv-123",...}`. The conversation id lands only on the proposal, and the run row's correlation id is random, so no join key exists. `grep -c aiRunId` returns 0 for routes/assistant.ts, workers/voice-action-router.ts, ai/tasks/estimate-task.ts and ai/tasks/invoice-task.ts. The only proposal paths that set aiRunId are the live-call turn processor and the in-app adapter, and those use the classifier's run, not the drafting run.

**Verifier's reasoning (what is real, what was narrowed):**

Verified. `grep -c aiRunId` returns 0 for routes/assistant.ts, workers/voice-action-router.ts, and ai/tasks/{estimate,invoice,create-appointment,send-customer-message,mms-estimate}-task.ts. estimate-task.ts:209-221 calls gateway.complete with no metadata, and the CreateProposalInput built at :439-462 has no aiRunId. assistant.ts:4436 persists that proposal as is. The gateway sets correlation_id to `metadata.correlationId ?? uuidv4()`, and no drafting call site passes one. sessionId and callSid only reach the trace exporter, which is off unless LANGFUSE_* keys are set. The ai_runs columns are the 008 set plus cost_micro_cents, with no session or proposal column. createIntentRun (voice-audit.ts:233) has an interface and an in-memory implementation but no caller. The finding is narrower than written in two ways. (1) Live-call proposals (voice-turn processor, twilio-adapter, customer-calling transitions) do set proposals.ai_run_id, but to the CLASSIFIER run, not the drafting run. (2) ai_runs.input_snapshot keeps the full message content (redactMessagesForSnapshot only redacts images), so a run can be found after the fact by tenant, task_type, timestamp and content. That is forensic, not keyed. Medium, not high: it is a traceability gap with no data loss, the proposal holds its own payload, sourceContext.conversationId and the human-approval audit trail, and the gap does not affect correctness.

**Fix to implement (verifier's corrected fix):**

The fix is too big as written: no migration is needed. ai_runs.correlation_id is already a TEXT column, and the code already uses correlationId as the session id (proposal-approval-task.ts:407). (1) Add one helper in the task-handler layer that returns `metadata: { correlationId: context.conversationId ?? context.sessionId ?? context.callSid, sessionId: ... }`, and pass it on every drafting handler's gateway.complete. Add an index on ai_runs(tenant_id, correlation_id) if lookups need one. (2) Set `aiRunId: llmResponse.aiRunId` on each drafting handler's CreateProposalInput, only when it is defined; the FK requires a real row. Keep the classifier run as sourceContext.classifierAiRunId where it is available. (3) Either delete createIntentRun from voice-audit.ts or wire it in. Tests: a per-handler unit test with a mocked gateway returning aiRunId; one Docker-gated integration test that the proposals.ai_run_id FK resolves to a row whose correlation_id equals the conversationId.

**Auditor's original fix (superseded where the corrected fix differs):**

(1) Add a migration with `ALTER TABLE ai_runs ADD COLUMN IF NOT EXISTS session_id TEXT` plus an index on (tenant_id, session_id). Have the gateway persist `metadata.sessionId` (and callSid if present) through CreateAiRunInput and PgAiRunRepository. (2) In task-handlers.ts, add one helper that builds `{ sessionId: context.conversationId, correlationId }` metadata, and use it in every drafting handler's gateway.complete. (3) In each drafting handler, set `aiRunId: llmResponse.aiRunId` on CreateProposalInput, because the drafting run is the one that authored the payload. Keep the classifier run as `sourceContext.classifierAiRunId`, threaded from assistant.ts and voice-action-router.ts. (4) Either wire createIntentRun or delete it, as CLAUDE.md's dead-code rule requires.

**Test specification (from the audit):**

Unit tests per drafting handler with a mocked gateway that returns `aiRunId: 'run-1'`, asserting `proposal.aiRunId === 'run-1'`. Add a Docker-gated integration test: drive the chat route (or call EstimateTaskHandler, then proposalRepo.create, against PgAiRunRepository and PgProposalRepository) and assert that the proposals.ai_run_id FK resolves to an ai_runs row whose session_id equals the conversationId. Also add a column pin for the new session_id, following the pattern in test/integration/ai-runs-cost-micro-cents.test.ts.

**Acceptance criteria:**

- [ ] A test exists that fails on `origin/main` (or with this finding's fix hunk reverted) for the reason the trigger describes, and passes on the branch.
- [ ] The fix is reached from the trigger's real callers (trace recorded in the PR body), not only from the test.
- [ ] No caller of a changed function regressed; every existing test stays green or its pin is changed with the reason in the commit message.
- [ ] Dead code made dead by this fix is deleted in the same commit.
- [ ] Commit `fix(<area>): <defect in plain words>` names OBS-2 in the body and ends with the session trailers.

## Gate for this batch (every command, exact counts in the PR body)

```
cd packages/api && npx tsc --project tsconfig.build.json --noEmit
cd packages/api && npm run lint
cd packages/api && npx vitest run                      # full unit suite
cd packages/api && EXTERNAL_TEST_DB_URL=<batch DB> RLS_RUNTIME_ROLE=true \
  npx vitest run --config vitest.integration.config.mts test/integration/<touched and covering files>
npm run check:migration-keys --workspace=packages/api   # when a migration was added
cd packages/api && npx vitest run test/db/migration-immutability.test.ts test/db/migration-key-order.test.ts
```
Plus `packages/shared` / `packages/web` tsc and vitest when touched. Known flake:
`test/settings/voice-approval-pin-route.test.ts:127` (~0.1%); re-run once if it is the only failure.

## Independent review checklist (reviewer runs `code-review`, then this)

- Standards axis: integer cents; UTC; `tenant_id` + RLS; audit event on every mutation; every AI call
  through the gateway; Zod proposals never auto-executed; catalog-grounded prices; entity resolver;
  dead code removed; tests in the same commit; plain owner/caller copy (never AI, agent, dashboard,
  verify, provisioning, proposal, Stripe, Twilio; never a promise the code path can't deliver);
  migrations idempotent, additive, next key, snapshot row.
- Spec axis: each finding ID above, traced from trigger to fix on the production path.
- Adversarial: a test that passes with the fix reverted is BLOCKING; a wrapper, cache-hit, failover
  or background-spawn path that bypasses the fix is BLOCKING; a new security hole is BLOCKING.

## Draft PR body skeleton

```
## Findings closed
- OVAS-01: <one line: mechanism of the fix>
- OVAS-02: <one line: mechanism of the fix>
- PI-2: <one line: mechanism of the fix>
- PI-3: <one line: mechanism of the fix>
- OVAS-03: <one line: mechanism of the fix>
- OVAS-04: <one line: mechanism of the fix>
- OBS-2: <one line: mechanism of the fix>

## Behaviour owners and callers will notice
- <...>

## Plan corrections found during claim verification
- <file:line — what the plan said — what the code says — what was built instead>

## Tests
- <unit / handler / integration files added or changed; each new test fails on main>

## Gate (verbatim summary lines)
- tsc build: <output>
- lint: <output>
- unit: Test Files N passed, Tests N passed
- integration: <files> — Test Files N passed, Tests N passed (RLS_RUNTIME_ROLE=true)

## Owner actions
- <...>

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01LUnuhssW9WEwiZgrAnuvRj
```

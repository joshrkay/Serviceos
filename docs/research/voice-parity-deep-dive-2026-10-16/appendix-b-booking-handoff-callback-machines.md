# B — "Close the loop": exact state machines (branch plan/voice-parity-bland-avoca)

All paths are under `packages/api/src/` unless noted. Line numbers are from the working tree on 2026-10-16.

---

## Part 1 — Booking on the call (D-015 autonomous lane)

### 1.1 Walk-through: "I need someone Thursday afternoon for a leaking water heater"

| Step | Where | What happens |
|---|---|---|
| Caller identity | `telephony/twilio-adapter.ts:1290-1298` `identifyCaller({tenantId, fromPhone, pool})` (`ai/skills/identify-caller.ts:18`, last-10-digit NANP match on `customers`). Match → `session.customerId` (`:1366`) + FSM `caller_known` (`:1393`). No match → `findOrCreateLeadByPhone` (`:1409-1418`) sets `session.leadId` only — **no customerId**. Caller E.164 kept in-process only: `callerIdBySession` (`:883`, `:1625`). |
| Intent + slots | Gateway classifier emits `intent_classified{create_appointment}` with entities (`dateTimePhrase`/`dateTimeDescription` verbatim phrase, `jobTitle` for new work). `runTurnResolution` (`ai/voice-turn/create-voice-turn-processor.ts:1951-1990`) resolves entities in the **tenant zone** via `resolveSessionTimezone`. Time parsing is deterministic: `ai/scheduling/resolve-datetime.ts` (chrono-node + luxon in tenant tz; bare "Thursday" with no time → `voice_clarification` "what time?"). "Thursday afternoon" resolves to a time only if chrono accepts "afternoon" — otherwise clarification. |
| Hold + lane (live path) | `create-voice-turn-processor.ts:2742-2863`. Gate at `:2756-2763`: `payloadProposalType==='create_appointment' && channel==='telephony' && !ownerSession && appointmentRepo && settingsRepo`. Then `:2787`: **`if (customerId && jobId && dateTimeDescription)`** → `resolveAndPlaceAppointmentHold` (`ai/scheduling/place-hold.ts:257`, idempotencyKey `inbound-book:${session.id}:${jobId}`, `:2803`). |
| Lane evaluation | `:2824-2840` `buildLaneInputFromSettings` (`ai/voice-turn/inbound-booking-completion.ts:58-87`) → `evaluateAutonomousBookingLane` (`proposals/autonomous-lane.ts:149-200`). Eligible → `payloadProposalType='create_booking'`, `payload={appointmentId,_meta}`, `autonomousLaneForCreate=laneEval` (`:2846-2851`). |
| Proposal | `buildProposal(...)` `:2865-2978`; lane-eligible adds `autonomousLane` + `sourceTrustTier:'autonomous'` (`:2972-2976`); stamp `autonomousLaneEvaluation` into `sourceContext` (`:2937`). `createProposal` → `decideInitialStatus` (`proposals/proposal.ts:1216-1240`, `:510-640`). |
| Execution | `workers/execution-worker.ts` polled from `app.ts:2730-2736` (`runExecutionSweep`, `findReadyForExecution(UNDO_WINDOW_MS)` `pg-proposal.ts:569`); executor refuses inside window (`proposals/execution/executor.ts:101-112`, `UNDO_WINDOW_MS=5000` `proposals/lifecycle.ts:53`). `CreateBookingExecutionHandler` (`proposals/execution/create-booking-handler.ts:47-148`): clears `holdPendingApproval`, refuses canceled/expired/past-start holds, audits `appointment.booked`, `confirmationNotifier.enqueue({channels:['sms','email']})` (TransactionalComms → consent-gated delivery). |
| Owner UNDO SMS | **Only** in `workers/voice-action-router.ts:2695-2737` (owner-memo path): `createOneTapUndoToken` (`proposals/one-tap-undo.ts:66`), body `Rivet booked: ${summary}. Tap to UNDO: ${url}`; URL from `app.ts:2992`. **The live-call FSM path sends no UNDO SMS** (grep: "Rivet booked"/`buildUndoUrl` appear only in voice-action-router.ts and app.ts). |

**Blocking gap on the live path:** `jobId` comes from `payload.jobId` (`:2766`). For NEW work, `create_appointment` deliberately has no `jobId` — the job is auto-opened at execution from `jobTitle` (`proposals/contracts.ts:245-259`). So the water-heater caller never reaches `:2787`; no hold, no lane, and the FSM speaks the draft-only line (`draftOnlySpeech`, `:2861-2863`) whatever the toggle says. The lane today only fires for an identified customer whose request resolved to an **existing** job. (The D-018 close path at `:4338-4345` auto-picks a single active job via `jobRepo.findByCustomer`; the booking path does not.)

### 1.2 `create_appointment` vs `create_booking`
- `create_appointment` (contract `contracts.ts:245`): no appointment exists yet; `jobId||customerId` refine; executor (`CreateAppointmentExecutionHandler`) creates job+appointment at approval; execution-anchor gap check `voice-payload.ts:305-311` and technician check `approval-reference-checks.ts:166`.
- `create_booking` (contract `:363-365`): `{appointmentId: guid}` of an already-HELD row (`hold_pending_approval=true`, `hold_expiry_at=now+24h` `place-hold.ts:39,134`); executor only flips the hold. Both are capture class (`AUTONOMOUS_LANE_PROPOSAL_TYPES` `autonomous-lane.ts:34-37`).

### 1.3 Lane gates (`evaluateAutonomousBookingLane`, `autonomous-lane.ts:152-199`), in order, with data source
1. `platformDisabled` ← `process.env.AUTONOMOUS_BOOKING_DISABLED==='true'` (`processor:2825`).
2. `settings.enabled` ← `tenant_settings.autonomous_booking_enabled` (`settings/pg-settings.ts:235`).
3. type ∈ {create_appointment, create_booking} and class `capture`.
4. `inboundReceptionistSource` ← hard-coded `true` by `buildLaneInputFromSettings:74`.
5. `flags.vulnerability|emergency|negotiation` ← only `negotiationFlagged` is threaded (`processor:2837`).
6. `confidenceMetaBlocksAutoApprove(payload)` ← `_meta.overallConfidence` low/very_low (`auto-approve.ts:256`).
7. `missingFields` — **not threaded** on the live path (undefined ⇒ passes).
8. `pendingReferenceCount` ← hard-coded `0` (`:2836`).
9. `customerId` ← caller-ID match / payload.
10. `holdPlaced` ← hard-coded `true`; 11. `holdExpiryAt > now`.
12. `slotWithinBusinessHours` ← `checkBusinessHours(parseOnboardingBusinessHours(settings.businessHours, tz), start).isOpen` (`:2811-2814`; no hours ⇒ open).
13. `confidenceScore >= max(0.90 FLOOR, tenant threshold ?? 0.95)` ← `autonomous_booking_threshold NUMERIC(3,2) CHECK 0.90–0.99` (`db/schema.ts:5850-5851`); API validation `settings.ts:1046-1052`.

### 1.4 `decideInitialStatus` and the coupling bug
`proposals/proposal.ts:578-640`: missingFields→draft; no trust tier→draft; only `autonomous+capture` can approve; `_meta` block→draft; `threshold=resolveAutoApproveThreshold({supervisorMode, supervisorPresent, tenantOverride})` (`auto-approve.ts:154-202`): `supervisorPresent===false`→`null`; mode undefined→`LEGACY_AUTO_APPROVE_THRESHOLD=0.9` (`:102`, plus a once-per-key warn log `:174-190`); else override/`DEFAULT_AUTO_APPROVE_THRESHOLDS` {supervisor .90, both .92, tech .95} (`:79-83`). `threshold===null` branch (`proposal.ts:615-634`) is the ONLY place `autonomousLane.threshold` is consulted; else generic `shouldAutoApprove(confidence, threshold)` (`:636`).

**What actually runs for the live FSM:** `buildProposal` at `processor:2865-2978` passes `tenantThresholdOverride` (`:2959`) but never `supervisorMode`/`supervisorPresent` (`:2961-2971` comment). So `resolveAutoApproveThreshold` returns 0.9 (never null), the `autonomousLane` input is dead, and the booking approves via the **generic 0.9 check**. Harmless only because eligibility already proved `confidence ≥ max(0.90, tenant)` and `LEGACY(0.9) === FLOOR(0.9)`; if FLOOR dropped below 0.9 (or LEGACY rose), an eligible booking would silently land `draft`. Also note: a supervised tenant in `tech` mode (0.95) is bypassed — the booking approves at 0.9 because mode is not threaded.

**Pinned test:** `test/proposals/autonomous-lane.test.ts:42-47` asserts `AUTONOMOUS_BOOKING_THRESHOLD_FLOOR >= LEGACY_AUTO_APPROVE_THRESHOLD`; `:182` BLAST-RADIUS pin (lane input absent ⇒ byte-identical matrix); `:202,216,228,252,265,278` lane × status cases.

**Fix (function-level):** (a) `VoiceTurnProcessorDeps` gains `isSupervisorPresent?: (tenantId) => Promise<boolean>` and `supervisorModeAtStart` is read from `voice_sessions.supervisor_mode_at_start`; (b) `buildProposal` call at `:2865` passes `supervisorMode`, `supervisorPresent`; (c) then the `threshold===null` lane branch is live for unsupervised tenants, and supervised tenants use the mode threshold. Mirror `workers/voice-action-router.ts` (which already threads both). Update the test comment and keep the invariant until the thread lands.

### 1.5 Spoken outcomes (EN), `inbound-booking-completion.ts`
- (a) lane on + eligible (`:18-20`): "You're booked for {time}. I'll text you a confirmation — reply if you need to change it."
- (b)/(c) lane off OR ineligible, hold placed (`:26-28`): "I've reserved {time} for you. Our team will confirm shortly and you'll get a text." (identical copy for off vs ineligible — `bookingSpeechForLane:45-56`.)
- No hold but time resolved (`:41-43`): "I've drafted an appointment for {time}. Someone from our team will confirm it before it's booked."
- No hold, no time (`:31-33`): "I've noted that appointment request. Someone from our team will confirm the time with you shortly."
- Corpus 09 expects, for a slot taken seconds earlier: "That Tuesday 2pm slot was just booked by another customer — the next opening is Tuesday at 4pm. I've drafted that for an operator to confirm." (`ai/voice-quality/corpus/scripts/09-concurrency/slot-just-taken-by-other-call.json`) — **not implemented**.

### 1.6 Capture class
`proposals/proposal.ts:293,305+` (API authority) mirrored in `packages/shared/src/contracts/proposal-action-class.ts:20-136` with a parity test. Capture: create/update customer, create/update job, create_appointment, create_booking, callback, draft/update estimate, draft/update invoice, create_invoice_schedule, batch_invoice, reassign/reschedule, add/remove crew, add_note, onboarding_*, log_expense, convert_lead, confirm_appointment, mark_lead_lost, add_service_location, log_time_entry, voice_clarification, create_standing_instruction, update_catalog_item, create_change_order, create_service_agreement, add_material, add_catalog_item. Comms: notify_delay, request_feedback, send_invoice, send_estimate, send_estimate_nudge, review_response_proposal, send_payment_reminder, send_customer_message. Money: issue_invoice, record_payment, apply_late_fee, record_refund, apply_credit. Irreversible: cancel_appointment, emergency_dispatch. Manual: adopt_entity_alias, update_brand_voice.

### 1.7 Setting storage / UI
Migration `231_tenant_settings_autonomous_booking` (`db/schema.ts:5839-5851`): `autonomous_booking_enabled BOOLEAN NOT NULL DEFAULT FALSE`, threshold default 0.95. Read `pg-settings.ts:235-238`, write map `:489-490`, type `settings.ts:603,610`. `auth/clerk.ts:597 bootstrapTenant` → `ensureTenantSettings` (`:614,:637`) seeds a row; the lane fields are DB defaults (off). UI: `packages/web/src/components/settings/AIApprovalRulesSheet.tsx:89-112` state, `:151-173` save, `:325-370` toggle + threshold input (0.90–0.99).

### 1.8 Detecting a "verified test booking"
- `voice_sessions` (`schema.ts:1796-1812` + `call_sid`, `outcome`, `transcript`): **no caller number column**; `customer_id`, `context` JSONB.
- Caller phone persisted only in `call_usage_events.caller_phone` (`schema.ts:7058-7069`, keyed `call_id`=session id) and `consent_events.phone_normalized` (`:4240`), `dropped_call_recoveries.caller_e164` (`:2894`).
- `appointments` (`:417-431` + `hold_pending_approval`, `hold_expiry_at` `:2535-2536`, `idempotency_key` `:3510`, `appointment_type`): **no `voice_session_id` / `proposal_id`**. Linkage today: `appointments.idempotency_key = 'inbound-book:{sessionId}:{jobId}'` and `proposals.payload.appointmentId` + `proposals.source_context.sessionId` / `autonomousLaneEvaluation.eligible` (`findAutonomousLaneApprovedForDay` `proposal.ts:1450`).
- Billing identity: `classifyCall` (`billing/call-usage-events.ts:22-36`) marks owner/business phone calls non-billable `own_number` — a test call from the owner's phone is identifiable there.

### 1.9 Concurrency (bucket 09)
`placeAppointmentHold` (`place-hold.ts:115-160`) does **no slot-conflict check** — `checkHoldFeasibility` only computes drive-time warnings for neighbouring technicians. `test/voice-quality/corpus/09-concurrency.test.ts:122-129` documents it: "Today: no concurrent-write protection — proposal goes to the wrong slot." Hold reaper (`workers/hold-reaper-worker.ts`) cancels expired holds; read paths treat expired holds as free.

---

## Part 2 — Human hand-off ladder

### 2.1 State machine
1. Trigger: FSM reason ∈ `operator_request | low_confidence_intent | keyword_frustration | llm_sentiment | emergency_dispatch | identity_unverified` (`ai/agents/customer-calling/escalation-summary-builder.ts:14-27`) → `escalateToHuman` (`ai/skills/escalate-to-human.ts:408`).
2. Target selection (telephony):
   - `transfer_number` set → single-target dial, **no rotation** (`:447-535`).
   - else rotation: `onCallRepo.listRotation`, cursor `callControl.getCursor` (`:552-556`), walk `dispatcherPhoneResolver` (`telephony/dispatcher-phone-resolver.ts:23-34`: `users.mobile_number`, skip non-active/numberless) `:563-585`; `setCursorAfter` `:655`.
   - none → `createBusinessPhoneFallback` (`dispatcher-phone-resolver.ts:41-51`, `tenant_settings.business_phone`) initial attempt only (`:595-644`); else `no_dispatcher_available` audit, `escalated:false` (`:650-660`).
   - **No business-hours or schedule awareness** in target selection (only `/voice` after-hours check at `routes/telephony.ts:530` picks AI vs voicemail).
3. TwiML: `twilio-call-control.ts:213-250` `<Dial timeout="20" action="/api/telephony/dial-result?sid=…">` with `<Number url=whisper>`; emergency-class legs add `screen=1` + press-1 screen (`:174-198`).
4. Whisper/screen: `telephony/whisper-route.ts` — `<Say>` from `WhisperCache` (`escalation-summary-builder` `whisper` ≤25 words, `:104-105`); screened legs `<Gather numDigits=1 timeout=10>` "Incoming call from your answering service. Press 1 to accept this call." (`:46-58,139`); `Digits==='1'` → `onAccepted` (`:163`) → `transfer-screening.ts:54-83` sets `session.transferAnsweredAt` + audit `escalation.transfer_answered`. This is the only DTMF handler in telephony (`dtmf_received` is otherwise a consent-events/PIN concept, not a call-flow event).
5. `/dial-result` (`routes/telephony.ts:822-1060`): `completed|answered` (and, for screened legs, `transferAnsweredAt` set) → synthetic `proposal_queued`, `finalizeTerminatedSession(…,'transferred')` (`:901-935`). Else: `transfer_number` → `<Gather>` callback message → `/callback-message` (`:1067`) creates `call_me_back` task (`voice/call-me-back/call-me-back.ts`); rotation → re-invoke `escalateToHuman` with cursor (`:968-1012`); exhausted → `queueCallbackProposal('rotation_exhausted')` + voicemail TwiML (`:1024-1060`).
6. Emergency ladder `telephony/emergency-page-retry.ts`: PgQueue delayed jobs, 3 pages at 2-min intervals (`:54-55`), idempotency `emergency_page:{tenant}:{session}:{attempt}` (`:88-93`), resolved by live session or `voice_sessions.ended_reason='transferred'`/`TRANSFER_ANSWERED_EVENT` (`:179-230`), final attempt → URGENT `call_me_back` (`reason 'emergency_unanswered'`). `call-me-back-worker.ts` sweeps pending tasks → SMS to `transfer_number`.
7. Context to human: whisper (spoken), SMS brief (`EscalationSummary.sms` one segment, `:107`), in-app panel via SSE `escalations/events-route.ts` (`escalation_started` filtered by dispatcherUserId+tenant). `escalations/outcome-route.ts:22-35` **is a no-op** (validates body, returns 200, persists nothing).
8. Realtime vs Gather (PR #1676): Gather returns the `<Dial>` as the next webhook response; Media Streams has no next webhook, so `mediastream-adapter.ts:4038-4062 handOffToHuman` takes the parked TwiML, waits for playout, REST-updates the live call inline, then ends the stream (`handoff` states `:769-796`; `/dial-result` owns the terminal stamp `:1104-1108`).

### 2.2 Recording
- Capture: `<Start><Record recordingStatusCallback>` (`twilio-adapter.ts:744-747`). Webhook `telephony/recording-webhook.ts:236+`: tenant from `store.findByCallSid` (never from payload), fetch Twilio URL with account creds, presign S3 PUT `<bucket>/<tenant>/<call_sid>.mp3` (`:91,333-349`), `recordInboundCall` idempotent on `(tenant_id, call_sid, recording_url)`.
- Pause: `recording-control.ts` `Twilio.CURRENT` Status=paused, 3s ack wait.
- Rows: `voice_recordings` (`schema.ts:150-166` + `call_sid`, `source`, `legal_hold`, `purged_at`, `idempotency_key`). Retention: `workers/recording-retention-worker.ts` purges audio/transcript/summaries/embeddings past `recording_retention_days`, tombstones `purged_at`.
- SSRF fix (#1673): `files/download-url-policy.ts` allowlists only the configured storage origin for worker-side audio fetches; `routes/voice.ts:597-653` mints server-side download URLs (never enqueues client `audioUrl`).
- **Tenant-scoped playback already exists:** `GET /api/voice/recordings/:id/audio` (`routes/voice.ts:716-760`): requireAuth+requireTenant+`files:view`, 410 on purged, presigned `generateDownloadUrl`. A caller-facing/inbox playback needs only: lookup by `call_sid`/session id (add index or route), and a short-TTL URL.

---

## Part 3 — Dropped-call recovery and consent

### 3.1 Dropped-call
- Detection: `voice/recovery/detect-dropped.ts:43-48` — outcome ∈ {dropped, failed}, channel voice, usable E.164 (≥7 digits). Suppressed for completed/escalated/callback_required/no_intent.
- Arming: telephony `twilio-adapter.ts:3479-3500` (`callerIdBySession`), in-app `inapp-adapter.ts:2316-2350`; `DroppedCallScheduler.schedule` delay `RECOVERY_DELAY_MS=60_000` (`sms/recovery/scheduler.ts:31,214`), idempotent `UNIQUE(tenant_id, voice_session_id)` ON CONFLICT (`:407-413`).
- Worker `workers/dropped-call-worker.ts`: kill switch = tenant feature flag `dropped_call_recovery` (`:35`, dark by default), stale reap 30 min (`:46`), batch 100.
- Handler `sms/recovery/dropped-call-handler.ts`: resolved-since check, `preSendSuppress` (app.ts:6485-6493: DNC → `opted_out`; `TCPA_CONSENT_ENFORCEMENT!=='off'` and `smsConsent!==true` → `no_consent`), rate limit 1/5min (`:37-39`), compose via brand-voice `createRecoveryComposer` (LLM only with real key) + `composeStateAwareCue(row.context)`, ≤320 chars, send through `messageDelivery.sendSms({recipientClass:'customer', consent})`.

### 3.2 Consent ledger
- `consent_events` (`schema.ts:4240-4257`): kind ∈ recording|sms|marketing; state ∈ granted|revoked|implicit; source ∈ voice|sms|portal|manual; `voice_session_id`; append-only (`compliance/consent-events.ts`).
- Ask site: D-018 close pre-gates pass (`processor:4238-4270`) → `session.pendingConsentCapture` → spoken `sms_consent_ask` (`ai/agents/customer-calling/tts-copy.ts:402`): "Great — I can text the full quote and a link to lock in your booking. Is it okay to send that to the number you're calling from?" Next turn `handlePendingConsentCapture` (`:4509-4575`) strict `confirmIntent`; grant → `recordSmsConsentFromVoice` (`voice/outbound-consent.ts:398-445`: ledger `{sms, granted, voice}` + `customers.sms_consent=true`; never touches voice `consent_status`). **Consent is only asked on the quote-close path, never on the booking path.**
- Decision core `compliance/resolve-outbound-consent.ts:140-173`: DNC → cross-channel standing revocation (sms/marketing revoked anywhere blocks both) → channel's own affirmative (voice: `customers.consent_status==='granted'`, no row ⇒ refuse; sms: `sms_consent===true`). `checkOutboundConsent` (`outbound-consent.ts:85+`) is the voice gate. DNC: `tenant_dnc_list` via `compliance/dnc.ts`.
- `TCPA_CONSENT_ENFORCEMENT` (`shared/config.ts:92`, prod/staging unset ⇒ `block` `:312-320`): `off` = DNC only; `warn` = run gate, audit `call.consent_warned`, still place; `block` = throw `consent_blocked` (`outbound-call-service.ts:140-215`). Same value gates SMS (`app.ts:1555-1566`, `6489`).

### 3.3 Outbound call today
`telephony/outbound-call-service.ts:127-330 initiateOutboundCall`: owner click-to-call — POST `Calls.json` To=`agentPhone` (owner), From=tenant business number, `Url=/api/calls/bridge?…` which `<Dial>`s the customer; no `StatusCallback`, no AMD (`MachineDetection`), status only via message metadata `ringing`. For an AI outbound leg you can reuse: creds/caller-ID/DNC+consent gate (`:132-215`), conversation logging, `buildConnectStreamTwiml` (`twilio-adapter.ts:1574-1600`) and the media-stream server. Missing: a `/api/telephony/outbound-answer` TwiML endpoint returning `<Connect><Stream>` bound to a new `voice_sessions` row with `channel='voice_outbound'` and an outbound surface (`proposals/surface.ts` has only S1/S2/S3), `StatusCallback`+`MachineDetection=Enable` handling (`AnsweredBy` → hang up on machine or leave VM), voice consent (`consent_status==='granted'`) which the SMS-only voice capture never writes, and billing (`classifyCall` returns `not_inbound_call` for anything but `voice_inbound`).

---

## Concrete changes

### Part 1
1. `create-voice-turn-processor.ts:2787` — relax `customerId && jobId && dateTimeDescription`: when `jobId` is absent and `jobTitle` present, open a **provisional** job through a new `ai/scheduling/open-job-for-booking.ts` (reusing `CreateAppointmentExecutionHandler`'s auto-open), **but only after the slot-conflict check of change 4 has passed** — the check takes a customer location and time, not a job, so a taken slot never creates a job at all. Job creation and the hold run in one transaction under the tenant-wide scheduling lock `pg_advisory_xact_lock(hashtext(tenant_id || ':scheduling'))` (plan U6 item 1); a pre-hold failure rolls the job back. Thread `missingFields` and `flags.emergency/vulnerability` into `buildLaneInputFromSettings`. (An earlier draft of this change said "create the job first"; U6 supersedes that ordering.)
2. `inbound-booking-completion.ts:58` `buildLaneInputFromSettings` — add `missingFields`, `emergencyFlagged`, `vulnerabilityFlagged` params.
3. `create-voice-turn-processor.ts:2865 buildProposal` — pass `supervisorMode`, `supervisorPresent` (new dep `isSupervisorPresent`); then drop the coupling comment and update `test/proposals/autonomous-lane.test.ts:42`.
4. New `place-hold.ts` conflict check: inside the transaction of change 1, **after taking the tenant-wide scheduling lock `pg_advisory_xact_lock(hashtext(tenant_id || ':scheduling'))`** and before any insert, call `isSlotFree` from `scheduling/booking-availability.ts` for the window (tenant-wide: any active appointment or live hold blocks; **not** `DefaultSlotConflictChecker.check`, which passes an unassigned slot when the overlapping rows belong to other customers); the key is the tenant because the race is two different customers at different locations competing for the same capacity, so a location-keyed lock would not serialise them, and a plain read-before-write without the lock lets two concurrent overlapping requests both see an empty slot and both insert holds (the existing `no_double_booking` exclusion covers technician assignments, not unassigned holds). Return `{ok:false, failed:'slot_taken', nextOpening}`; FSM speaks the corpus-09 line. Concurrency pin: `test/integration/place-hold.concurrent-slot.test.ts` (plan U6).
5. Owner UNDO SMS on the live path: extract `sendLaneUndoSms(tenantId, proposal)` from `voice-action-router.ts:2695-2737` into `proposals/lane-undo-sms.ts`; call it after `deps.proposalRepo.create(held.proposal)` (`processor:2984`) when `autonomousLaneEvaluationFor(stored)?.eligible`.
6. Distinct spoken copy for lane-off vs ineligible (`bookingSpeechForLane`) if product wants it; otherwise leave.

### Part 2
7. `escalations/outcome-route.ts` — persist to `voice_sessions.outcome`/audit via `VoiceSessionRepository.findByEscalationId` (add `escalation_id` column) instead of no-op.
8. `escalate-to-human.ts:552` — optional hours-aware rotation: filter entries by `on_call_rotation.schedule` (new column) before walking.
9. Playback: add `GET /api/voice/recordings/by-call/:callSid/audio` reusing `routes/voice.ts:716` handler body.

### Part 3
10. Consent ask on booking path: reuse `pendingConsentCapture` after the lane-eligible utterance when `customers.sms_consent!==true`, so the "I'll text you a confirmation" promise is legal under `block`.
11. Voice-consent capture: new `recordVoiceConsentFromVoice` writing `consent_events { kind: 'voice', state: 'granted', source: 'voice', voice_session_id, purpose: 'dropped_call_callback' }` (CHECK gains `'voice'`; new `purpose` column). **`resolveOutboundConsent` is unchanged** — its generic voice branch keeps reading only `customers.consent_status`, so a narrowly worded dropped-call grant never becomes standing consent for owner click-to-call or any other outbound leg. The callback service instead validates the exact `consent_event_id` bound to its `voice_callback_jobs` row (same tenant, same `voice_session_id`, purpose `dropped_call_callback`, inside the window, no later revocation) before dialling. See the plan's U8 "scoped, not standing" paragraph; an earlier draft of this item proposed reading the ledger from the generic resolver, which that paragraph supersedes.
12. AI outbound leg: `telephony/outbound-ai-call-service.ts` (clone of `initiateOutboundCall` with `Url=/api/telephony/outbound-answer`, `StatusCallback`, `MachineDetection=Enable`), new `voice_sessions.channel='voice_outbound'` session seeded with `customerId`, `classifyCall` rule for outbound.

### DB columns / migrations
- `appointments`: `voice_session_id UUID NULL`, `proposal_id UUID NULL` (index on tenant+voice_session_id).
- `voice_sessions`: `caller_phone_e164 TEXT NULL`, `escalation_id TEXT NULL`, `surface TEXT`.
- `consent_events.kind` CHECK add `'voice'`; `tenant_settings.autonomous_booking_*` already exist.
- `on_call_rotation`: optional `hours JSONB`.
- `call_usage_events`: `direction TEXT DEFAULT 'inbound'`.

### Floor-criteria risks (`ai/voice-quality/rubric/rubric.v1.json`) and pinning tests
- #2 noAutoMutation — change 1/4 write a job/appointment before approval (holds already do); pin: integration test that `appointments.hold_pending_approval=true` and a `proposals` row exist (`test/integration/`), plus `autonomous-lane.test.ts` matrix unchanged.
- #6 noDuplicateCustomer — change 1 must never create a customer for a caller-ID match; pin with `identifyCaller` + lead path test.
- #7 complianceGatesRespected — changes 5/10/12: SMS to owner/customer must pass DNC + consent; pin `test/sms/gated-message-delivery` style test with `TCPA_CONSENT_ENFORCEMENT=block` and `sms_consent=false` ⇒ suppressed; after-hours `slotWithinBusinessHours=false` ⇒ lane ineligible (`autonomous-lane.test.ts:122`).
- #1/#5 PII/tenant leak — change 9 playback must stay tenant-scoped (`requireTenant` + repo tenantId); pin route test with cross-tenant id ⇒ 404.
- #8 hangupHandled — change 12 outbound: `finalizeTerminatedSession` must stamp outcome; pin with `detect-dropped` test that outbound `failed` arms recovery only if intended.
- #11 rightEscalationBehavior — change 8 must not strand a call when every entry is off-hours; pin `escalate-to-human.test` "rotation filtered to empty ⇒ business-phone fallback".
- Disposition #12 — change 4 changes spoken copy; update golden `09-concurrency` expectation and flip `slot-just-taken-by-other-call` from documented-failure to pass (`09-concurrency.test.ts:126`).

/**
 * #962 (PR-A) — the coverage table: one declared cell per
 * (intent family × live surface).
 *
 * WHAT THIS IS. Today the per-turn pipeline is implemented per transport
 * (`telephony/twilio-adapter.ts#_handleGatherLocked` for Gather,
 * `create-voice-turn-processor.ts#speechTurn` for media-streams finals, the
 * in-app adapter's `_handleInputLocked`, and the recorded-memo router's
 * `processSegment`) and the four copies have drifted: a family can be served
 * on one surface and silently degrade on another (the classifier still
 * "understands" the caller — the surface just has no branch, so the turn
 * falls through to the drafting FSM and usually ends in a
 * `voice_clarification` card nobody asked for). This table declares, for
 * every family on every live surface, what the code DOES TODAY — including
 * the known parity holes — so the drift is visible, testable, and closable
 * on purpose instead of silently.
 *
 * WHAT THIS IS NOT. Not a routing table: nothing in production reads it.
 * The consumers are the structural test (every cell must be declared —
 * silence is impossible), the behavioral anchors (the declared cell must
 * match the observed behavior at each surface's seam), and the humans
 * closing #963/#966. When a surface gains or loses a branch, the matching
 * cell MUST change in the same PR — the anchors fail otherwise.
 *
 * CELL SEMANTICS.
 *  - `reachable` — the family is served on this surface; `module` names the
 *    branch that serves it.
 *  - `refuse` — the family is NOT served on this surface. `copy` is the
 *    honest record of what the user actually gets. A refuse cell WITHOUT
 *    `hole` is a refusal someone chose (D-025's in-app approval refusal); a
 *    refuse cell WITH `hole: true` is a parity gap — the surface silently
 *    degrades the family and no decision blessed that. Holes are DECLARED
 *    here, not fixed here.
 *  - `n/a` — the family structurally cannot occur on this surface (a batch
 *    memo has no silence to reprompt; an in-app session has no PSTN leg to
 *    `<Dial>`). `reason` says why. Distinct from `refuse` so a genuine
 *    impossibility is never dressed up as a decision, and vice versa.
 *  - `hole: true` may also ride a `reachable` cell when the family is served
 *    but visibly narrower than on its fullest surface (in-app lookups answer
 *    exactly one skill).
 *
 * Line references below were verified against origin/main @ ad9e027fb
 * (2026-09-03) and are navigational hints, not contracts — the behavioral
 * anchors in `test/ai/voice-turn/coverage-table.behavior.test.ts` are the
 * contract.
 */

/** The four live surfaces a spoken/typed turn can arrive on. */
export const LIVE_SURFACES = ['gather', 'media_streams', 'inapp', 'memo'] as const;
export type CoverageSurface = (typeof LIVE_SURFACES)[number];

/**
 * The intent families the campaign tracks — the behaviors that have already
 * drifted (or provably could) between per-transport turn loops. A family is
 * broader than one classifier intent: `lookup` is the whole `lookup_*`
 * prefix; `silence_low_stt_ladder` isn't an intent at all but a turn-level
 * failure behavior.
 */
export const INTENT_FAMILIES = [
  'lookup',
  'en_route',
  'language_switch',
  'voice_approval',
  'voice_edit',
  'create_customer',
  'emergency_immediate_dial',
  'ws18_consent_capture',
  'ws18_post_quote_refinement',
  'frustration_keyword_escalation',
  'silence_low_stt_ladder',
] as const;
export type IntentFamilyId = (typeof INTENT_FAMILIES)[number];

export interface ReachableCell {
  readonly status: 'reachable';
  /** The module/branch that serves the family on this surface. */
  readonly module: string;
  readonly notes?: string;
  /** Served, but visibly narrower than the family's fullest surface. */
  readonly hole?: true;
}

export interface RefuseCell {
  readonly status: 'refuse';
  /**
   * The honest record of what the user actually gets. For a deliberate
   * refusal this is the exact spoken/visible copy (or the log line, on a
   * surface with no user-visible channel). For a hole it describes the
   * observed degradation.
   */
  readonly copy: string;
  /** The module where the refusal (or the fall-through) happens. */
  readonly module: string;
  readonly notes?: string;
  /** A parity gap nobody chose — declared, not fixed. See #963/#966. */
  readonly hole?: true;
}

export interface NotApplicableCell {
  readonly status: 'n/a';
  /** Why the family structurally cannot occur on this surface. */
  readonly reason: string;
}

export type CoverageCell = ReachableCell | RefuseCell | NotApplicableCell;

export type CoverageRow = Readonly<Record<CoverageSurface, CoverageCell>>;

/**
 * The table. Every (family, surface) pair MUST have a cell — the structural
 * test (`coverage-table.structural.test.ts`) fails on any undeclared pair,
 * so a new family or surface cannot land half-declared.
 */
export const COVERAGE_TABLE: Readonly<Record<IntentFamilyId, CoverageRow>> = {
  lookup: {
    gather: {
      status: 'reachable',
      module:
        'telephony/twilio-adapter.ts#_handleGatherLocked → ai/voice-turn/phone-lookup-surface.ts#answerPhoneLookup (shared dispatch: workers/voice-lookup-answer.ts)',
      notes:
        'P11-001/#866: answered out-of-FSM; the state stays in intent_capture and the caller hears the answer plus "Anything else I can help you with?".',
    },
    media_streams: {
      status: 'refuse',
      hole: true,
      module: 'ai/voice-turn/create-voice-turn-processor.ts#speechTurn (no lookup branch)',
      copy:
        'No answer is spoken. A classified lookup_* falls into the drafting FSM (entity_resolution → intent_confirm readback) and typically ends as a voice_clarification card — the live hole D-026 flagged.',
      notes:
        'The Gather branch and the memo branch both route to the shared dispatch; speechTurn never gained the branch.',
    },
    inapp: {
      status: 'reachable',
      hole: true,
      module:
        'ai/agents/customer-calling/inapp-adapter.ts#_handleInputLocked (ownerSession-gated deps.ownerLookupResolver)',
      notes:
        'Narrow twice over: only owner sessions are eligible, and the production resolver (app.ts) answers ONLY lookup_day_overview — every other lookup_* (and any non-owner session) falls to the FSM and degrades to a clarification card.',
    },
    memo: {
      status: 'reachable',
      module:
        'workers/voice-action-router.ts#processSegment (U3 single-action path → per-skill lookup adapter)',
      notes:
        'Requires applyDedup + recordingId + lookupAnswers + voiceRepo; chain segments and deployments without the U3 deps log "no answer surface on this path" and skip.',
    },
  },
  en_route: {
    gather: {
      status: 'reachable',
      module:
        'telephony/twilio-adapter.ts#_handleGatherLocked → ai/voice-turn/phone-en-route-surface.ts#answerPhoneEnRoute',
      notes:
        '#847 F-3: a DIRECT audited status act (same act as the app button), never a proposal; deliberately absent from INTENT_TO_PROPOSAL_TYPE.',
    },
    media_streams: {
      status: 'reachable',
      module:
        'ai/voice-turn/create-voice-turn-processor.ts#speechTurn → phone-en-route-surface.ts#answerPhoneEnRoute',
      notes: 'TAU_INT-gated (a low-confidence en_route takes the normal repair path).',
    },
    inapp: {
      status: 'refuse',
      hole: true,
      module: 'ai/agents/customer-calling/inapp-adapter.ts (no en_route branch)',
      copy:
        'No en-route act fires. The intent falls through the FSM to intentToProposalType\'s default and degrades to a voice_clarification card — the exact degradation proposals/voice-intent-map.ts predicts for a surface without a branch.',
      notes:
        'The chat surface (routes/assistant.ts) has the branch; the in-app VOICE surface does not.',
    },
    memo: {
      status: 'reachable',
      module:
        'workers/voice-action-router.ts#processSegment (en_route branch → handleEnRouteVoiceIntent → dispatch/en-route-voice.ts)',
    },
  },
  language_switch: {
    gather: {
      status: 'reachable',
      module: 'telephony/twilio-adapter.ts#handleLanguageSwitchGather',
      notes:
        '#846: an ADAPTER act, out-of-FSM (the pure FSM cannot mutate session.language); the next <Gather> listens in the new language.',
    },
    media_streams: {
      status: 'reachable',
      module:
        'telephony/media-streams/mediastream-adapter.ts (deterministic pre-scan maybeHandleExplicitLanguageSwitch — consumes the turn — plus the classifier fallback that reads the turn\'s audit_log intentType)',
      notes:
        'Served by the ADAPTER, not by speechTurn: the processor only surfaces the classified intent on the audit_log side effect; the adapter performs the switch (UB-C1).',
    },
    inapp: {
      status: 'reachable',
      module: 'ai/agents/customer-calling/inapp-adapter.ts#switchSessionLanguage',
      notes:
        'Same opt-in gate, flap cap and copy as the telephony transports; the permissive [en, es] default for an unresolved stack is this surface\'s own documented rule, not drift.',
    },
    memo: {
      status: 'refuse',
      copy:
        'A voice_clarification card explaining the miss (emitClarification) — a recorded memo has no live call whose language can be switched (Task 13, 2026-08-07 plan).',
      module: 'workers/voice-action-router.ts#processSegment (dedicated no-memo-action branch)',
    },
  },
  voice_approval: {
    gather: {
      status: 'reachable',
      module:
        'telephony/twilio-adapter.ts#_handleGatherLocked → processor.handlePendingVoiceApproval / handleVoiceApprovalIntent',
      notes:
        'RV-071: out-of-FSM dialogue, hard-gated on the RV-070 ownerSession flag; an in-flight readback consumes the turn before classification (silence keeps it pending).',
    },
    media_streams: {
      status: 'reachable',
      module:
        'ai/voice-turn/create-voice-turn-processor.ts#speechTurn → handlePendingVoiceApproval / handleVoiceApprovalIntent',
      notes:
        'Silence-timer parity via TwilioGatherAdapter#handlePendingDialogueSilence (Codex P2, PR #702).',
    },
    inapp: {
      status: 'refuse',
      copy: "Tap the card to approve — I don't take approvals by voice here yet.",
      module: 'ai/agents/customer-calling/inapp-adapter.ts#refuseVoiceApproval',
      notes:
        'Deliberate (D-025 scope: a transport-identified owner LINE). Audited as agent.calling.voice_approval_denied with reason inapp_surface; same sentence as the chat route (VOICE_APPROVAL_REFUSAL) so the two in-app seams cannot drift.',
    },
    memo: {
      status: 'refuse',
      copy:
        "Log line only: 'voice-action-router: owner approval/edit intent refused on this channel' ({kind: skipped}) — the batch surface has no user-visible channel for the refusal.",
      module: 'workers/voice-action-router.ts#processSegment (RV-071 belt-and-braces guard)',
      notes:
        'Deliberate: a stored transcript must never approve/execute a mutation; the intents are also absent from INTENT_TO_PROPOSAL_TYPE.',
    },
  },
  voice_edit: {
    gather: {
      status: 'reachable',
      module: 'telephony/twilio-adapter.ts#_handleGatherLocked → processor.handleVoiceEditIntent',
      notes:
        'RV-225: same out-of-FSM routing + ownerSession hard gate as approval; applies via the existing editProposal path and the proposal stays pending.',
    },
    media_streams: {
      status: 'reachable',
      module: 'ai/voice-turn/create-voice-turn-processor.ts#speechTurn → handleVoiceEditIntent',
    },
    inapp: {
      status: 'refuse',
      copy: "Tap the card to approve — I don't take approvals by voice here yet.",
      module: 'ai/agents/customer-calling/inapp-adapter.ts#refuseVoiceApproval',
      notes: 'Same deliberate refusal (and same audited denial) as voice_approval.',
    },
    memo: {
      status: 'refuse',
      copy:
        "Log line only: 'voice-action-router: owner approval/edit intent refused on this channel' ({kind: skipped}).",
      module: 'workers/voice-action-router.ts#processSegment (RV-071 belt-and-braces guard)',
    },
  },
  create_customer: {
    gather: {
      status: 'reachable',
      module:
        'telephony/twilio-adapter.ts#handleCreateCustomerVoiceIntent (P18-001 dedicated task handler)',
      notes:
        'Contract-validated payload (name + caller-ID phone + optional email), minted in ONE turn — bypasses the entity_resolution → intent_confirm round-trip. An already-matched caller hears "I\'ve got you in our system already."',
    },
    media_streams: {
      status: 'reachable',
      hole: true,
      module:
        'ai/voice-turn/create-voice-turn-processor.ts#speechTurn (generic FSM path → INTENT_TO_PROPOSAL_TYPE → handleCreateProposal)',
      notes:
        'Reachable but NOT via the P18-001 handler: the intent takes the multi-turn confirm round-trip and mints the generic drafting envelope, not the contract shape the Gather branch builds — declared drift.',
    },
    inapp: {
      status: 'reachable',
      module:
        'ai/agents/customer-calling/inapp-adapter.ts#_handleInputLocked (FSM path; VOX-02 creation-intent handling)',
      notes:
        'A creation intent whose entities resolve not_found proceeds with partial refs (never escalates a caller booking new work); the queue path reads the flat create_customer task contract.',
    },
    memo: {
      status: 'reachable',
      module:
        'workers/voice-action-router.ts#processSegment → INTENT_TO_PROPOSAL_TYPE → CreateCustomerVoiceTaskHandler',
    },
  },
  emergency_immediate_dial: {
    gather: {
      status: 'refuse',
      hole: true,
      module: 'telephony/twilio-adapter.ts#_handleGatherLocked (no emergencyImmediateDial branch)',
      copy:
        'The caller still escalates — a classified emergency takes the FSM\'s fast-path (notify_oncall page ladder) — but the P12-004 unsupervised immediate <Dial> of the on-call rotation never happens on this transport, and no emergency_immediate_dial audit event is emitted.',
    },
    media_streams: {
      status: 'reachable',
      module:
        'ai/voice-turn/create-voice-turn-processor.ts#speechTurn → emergencyImmediateDial (ai/voice-turn)',
      notes:
        'Gated on EMERGENCY_INTENTS + deps.onCallRepo; the unsupervised check (isSupervisorPresent) lives inside the wrapper; a dial failure falls through to the normal FSM emergency path.',
    },
    inapp: {
      status: 'n/a',
      reason:
        'No PSTN leg to bridge — an in-app session has no live call a <Dial> could transfer. A classified emergency follows the FSM path (notify_tenant_emergency).',
    },
    memo: {
      status: 'n/a',
      reason:
        'A batch transcript has no live caller to bridge. P12-004\'s other half — unsupervised ROUTING of review-held proposals — is what applies on this surface (workers/voice-action-router.ts).',
    },
  },
  ws18_consent_capture: {
    gather: {
      status: 'refuse',
      hole: true,
      module:
        'telephony/twilio-adapter.ts#_handleGatherLocked (runs handlePendingVoiceApproval but NOT handlePendingConsentCapture)',
      copy:
        'A pending SMS-consent capture is never consumed on a Gather turn: the caller\'s yes/no is classified as a fresh intent and session.pendingConsentCapture stays set. (Gather also never ASKS — the WS18b ask originates in the post-quote close flow this transport lacks.) Only the media-streams silence timer reaches Gather\'s handlePendingDialogueSilence.',
    },
    media_streams: {
      status: 'reachable',
      module:
        'ai/voice-turn/create-voice-turn-processor.ts#speechTurn → handlePendingConsentCapture (ask: handlePostQuoteClose, WS18b)',
      notes:
        'Consumes the turn before the FSM-state branch; silence parity via handlePendingDialogueSilence. Grant writes the consent ledger via recordSmsConsentFromVoice; decline/unwired persistence hands the send to the owner.',
    },
    inapp: {
      status: 'n/a',
      reason:
        'WS18 is the on-call SMS-consent mini-dialogue of the live-phone quote close; the in-app pipeline never arms session.pendingConsentCapture (zero references in inapp-adapter.ts).',
    },
    memo: {
      status: 'n/a',
      reason: 'A batch transcript has no live mini-dialogue to capture consent in.',
    },
  },
  ws18_post_quote_refinement: {
    gather: {
      status: 'refuse',
      hole: true,
      module:
        'telephony/twilio-adapter.ts#_handleGatherLocked (no classifyPostQuoteUtterance / pendingQuote branch)',
      copy:
        '"Yes, book it" / "make it two" in closing goes to the classifier as a second intent and the pending quote is silently dropped — the exact discard bug WS18 closed on media-streams. Gather CAN arm a pendingQuote (the shared handleCreateProposal dispatches proposal_queued with groundedLines); it just cannot serve it on the next turn.',
    },
    media_streams: {
      status: 'reachable',
      module:
        'ai/voice-turn/create-voice-turn-processor.ts#speechTurn (deterministic classifyPostQuoteUtterance pre-check, BEFORE the classifier)',
      notes:
        'affirmative → handlePostQuoteClose (strict confirm → pre-gates → consent ask); refine → applyQuoteRefinement, bounded by MAX_REFINEMENTS_PER_CALL; passthrough falls to the classifier.',
    },
    inapp: {
      status: 'n/a',
      reason:
        'The in-app surface never arms a pendingQuote — its estimate drafting runs the adapter\'s own queue path, not the telephony live-quote close flow (zero pendingQuote references in inapp-adapter.ts).',
    },
    memo: {
      status: 'n/a',
      reason: 'A batch transcript has no live quote to refine or close.',
    },
  },
  frustration_keyword_escalation: {
    gather: {
      status: 'reachable',
      module: 'telephony/twilio-adapter.ts#_handleGatherLocked (B3.2 keyword check)',
      notes:
        'Toggle-gated on escalationTriggers.trigger_keyword_frustration BEFORE dispatching (PR-0b, #972) — matching media-streams; runs after the transcript append and before any LLM call.',
    },
    media_streams: {
      status: 'reachable',
      module:
        'telephony/twilio-adapter.ts#processCallerUtterance (the wrapper app.ts wires as the mediastream adapter\'s speechTurn dep)',
      notes: 'Same toggle gate; the LLM sentiment trigger (B3.3) is a separate, adapter-side hook.',
    },
    inapp: {
      status: 'refuse',
      hole: true,
      module: 'ai/agents/customer-calling/inapp-adapter.ts (no detectFrustration call)',
      copy:
        'Angry wording is never keyword-escalated; it classifies as a normal intent (often complaint). Possibly intentional — the in-app user IS the operator, not a customer to hand to a human — but no recorded decision blesses the omission, so it is declared as observed.',
    },
    memo: {
      status: 'n/a',
      reason:
        'A memo is the tech\'s own recorded note — there is no live caller to escalate away from. Customer anger arrives as the complaint intent, which has its own memo handler.',
    },
  },
  silence_low_stt_ladder: {
    gather: {
      status: 'reachable',
      module:
        'telephony/twilio-adapter.ts#runLowSttConfidenceGatherLadder (+ maybeHandleLowSttConfidenceGather, A3)',
      notes:
        'Empty SpeechResult (actionOnEmptyResult) and low acoustic Confidence share ONE streak (T2-F03), capped at MAX_CONSECUTIVE_LOW_CONFIDENCE_TURNS → escalation copy + graceful end_session.',
    },
    media_streams: {
      status: 'reachable',
      module:
        'telephony/media-streams/mediastream-adapter.ts (A3 final-confidence gate + recoverFromLowSttConfidence + T2-F05 silence-reprompt timer)',
      notes:
        'The silence timer gives pending approval/consent dialogues first crack via TwilioGatherAdapter#handlePendingDialogueSilence; speechTurn\'s own empty-utterance branch dispatches confidence_low.',
    },
    inapp: {
      status: 'n/a',
      reason:
        'Turns arrive as complete typed/transcribed text — there is no acoustic confidence score and no silence timer on this surface.',
    },
    memo: {
      status: 'n/a',
      reason: 'A batch transcript cannot be silent at turn granularity; STT quality is handled upstream of the router.',
    },
  },
};

/**
 * ── Drafting-surface parity declarations (the spanning test's constants) ──
 *
 * `test/proposals/drafting-surface-parity.test.ts` audits that every drafting
 * handler in the shared registry (`ai/orchestration/handler-registry.ts`) is
 * reachable OR refused-on-purpose from every drafting surface. These two
 * sets are the DECLARED exceptions that audit checks against — a new
 * exception must be added here (a visible, reviewable act), never absorbed
 * silently.
 */

/**
 * Intents chat dispatches from a DEDICATED branch rather than
 * `CHAT_INTENT_TO_REGISTRY_KEY` (see `routes/assistant.ts` — pinned by the
 * I3 suite in `test/routes/assistant-dropped-intents.test.ts`).
 */
export const CHAT_DEDICATED_BRANCH_INTENTS: ReadonlySet<string> = new Set(['create_customer']);

/**
 * Proposal types the memo router serves via its OWN handler extensions
 * (`workers/voice-action-router.ts#buildHandlers`) that have no handler in
 * the shared registry at all — structurally unwireable on chat, and their
 * feeding intents sit in `CHAT_DISPATCH_EXCLUDED_INTENTS` on purpose.
 */
export const MEMO_ONLY_PROPOSAL_TYPES: ReadonlySet<string> = new Set([
  'review_response_proposal',
  'create_standing_instruction',
  'update_brand_voice',
]);

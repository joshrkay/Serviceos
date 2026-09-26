/**
 * #840 — the capability declaration: ONE entry per speakable intent, and the
 * single source the per-surface intent maps are derived from.
 *
 * WHY THIS EXISTS. Adding one intent used to touch 13 production files across
 * two packages, held together by list-agreement tests — and it still shipped
 * incomplete twice. The destination (#833) is that adding a capability makes
 * it available on every surface WITHOUT anyone remembering to. That holds here
 * by construction:
 *
 *   - `CAPABILITIES` is typed `Record<ClassifiableIntent, …>`, so adding an
 *     intent to `SUPPORTED_INTENTS` does not compile until it is declared.
 *   - `INTENT_TO_PROPOSAL_TYPE` (phone — both transports — recorded memo, and
 *     in-app voice) is `deriveIntentToProposalType(CAPABILITIES)`.
 *   - the chat route's `CHAT_INTENT_TO_REGISTRY_KEY` and
 *     `CHAT_DISPATCH_EXCLUDED_INTENTS` are `deriveChatDispatch(...)`.
 *
 * So a new `kind: 'proposal'` declaration is dispatched on every surface, and
 * the ONLY way to keep it off one is an explicit `unavailableOn` entry with a
 * reason — parity is the default, divergence is a visible, reviewable act.
 *
 * THE UNIT is the intent, not the proposal type. Surfaces dispatch on what the
 * classifier heard; a proposal type is how one KIND of capability is carried
 * out, and four intents alias an existing type (`schedule_inspection` →
 * `create_appointment`, …). Declaring per proposal type would leave lookups,
 * the direct act, and the dialogue intents with no home.
 *
 * WHAT A CAPABILITY DECLARES — and what it deliberately does not:
 *   - `kind` — proposal | lookup | direct_act | approval | dialogue.
 *   - `proposalType` (proposal kind only) — the drafting + execution handlers
 *     are keyed by proposal type in their own registries (typed
 *     `Map<ProposalType, …>`), so naming the type IS the handler binding.
 *   - `example` — the spoken example the catalog renders.
 *   - `unavailableOn` — the per-surface opt-out, with the reason.
 *   NOT declared, because each already has exactly one owner and copying it
 *   here would create the parallel list this module exists to remove:
 *   the action class (`actionClassForProposalType` — derived from the type),
 *   the payload contract (keyed by proposal type in `proposals/contracts`),
 *   the spoken summary (`voiceProposalSummary`), and the proof (#841 derives
 *   it from `provesExecution(...)` tags in real-database tests — evidence,
 *   never an assertion; D-031).
 *
 * WHAT STAYS HAND-MAINTAINED, on purpose: the S1 caller allowlist
 * (`proposals/surface.ts` — the security boundary for unauthenticated
 * transcripts), the per-profile accept sets (`classifier-profile.ts`), the
 * coverage table (`ai/voice-turn/coverage-table.ts` — it tracks turn-level
 * BEHAVIOURS per transport, including holes nobody chose), and
 * `SUPPORTED_INTENTS` itself (its order feeds the classifier prompt and so
 * every cassette hash). A capability declaration can never widen what an
 * unauthenticated caller reaches.
 *
 * The catalog (`docs/reference/voice-action-catalog.md`) is GENERATED from
 * this file (#842): `npm run catalog:generate`; a drift test fails CI if the
 * committed catalog differs from a regenerate.
 */
import type { IntentType } from '../ai/orchestration/intent-classifier';
import type { ProposalType } from '../proposals/proposal';

/**
 * The three voice surfaces (CONTEXT.md "Surface"). `phone` covers every phone
 * transport — a capability targets the phone, never Gather or Media Streams;
 * transport-level divergence is the coverage table's job. `chat` is the
 * in-app assistant route (`routes/assistant.ts`, typed or mic).
 */
export const CAPABILITY_SURFACES = ['phone', 'memo', 'chat'] as const;
export type CapabilitySurface = (typeof CAPABILITY_SURFACES)[number];

export type ClassifiableIntent = Exclude<IntentType, 'unknown'>;

/** Per-surface opt-out: surface → why it is not served there. */
export type SurfaceOptOut = Partial<Record<CapabilitySurface, string>>;

interface CapabilityBase {
  readonly unavailableOn?: SurfaceOptOut;
}

/** Drafts a typed proposal a human approves (D-004). */
export interface ProposalCapability extends CapabilityBase {
  readonly kind: 'proposal';
  readonly proposalType: ProposalType;
  readonly example: string;
}

/** Read-only; answered through the one shared lookup dispatch, never a proposal. */
export interface LookupCapability extends CapabilityBase {
  readonly kind: 'lookup';
}

/** The speaker acting directly, audited, never a proposal (Part F decision F-3). */
export interface DirectActCapability extends CapabilityBase {
  readonly kind: 'direct_act';
  readonly example: string;
}

/** Approve / reject / edit a pending proposal by voice (RV-071, RV-225). */
export interface ApprovalCapability extends CapabilityBase {
  readonly kind: 'approval';
}

/** Understood conversational turns with no proposal of their own. */
export interface DialogueCapability extends CapabilityBase {
  readonly kind: 'dialogue';
}

export type CapabilityDeclaration =
  | ProposalCapability
  | LookupCapability
  | DirectActCapability
  | ApprovalCapability
  | DialogueCapability;

export type CapabilityKind = CapabilityDeclaration['kind'];

function proposal(
  proposalType: ProposalType,
  example: string,
  unavailableOn?: SurfaceOptOut,
): ProposalCapability {
  return unavailableOn
    ? { kind: 'proposal', proposalType, example, unavailableOn }
    : { kind: 'proposal', proposalType, example };
}

const LOOKUP: LookupCapability = { kind: 'lookup' };

/**
 * The memo router's own handler extensions serve these; the shared drafting
 * registry chat resolves from has no handler for them, so wiring them on chat
 * would be a crash, not a feature (`coverage-table.ts#MEMO_ONLY_PROPOSAL_TYPES`).
 */
const NO_SHARED_DRAFTING_HANDLER =
  'no drafting handler in the shared registry (ai/orchestration/handler-registry.ts) — only the memo router registers one, so chat has nothing to dispatch to';

const APPROVAL_OPT_OUTS: SurfaceOptOut = {
  memo: 'a stored transcript must never approve or edit a mutation (RV-071 belt-and-braces guard in workers/voice-action-router.ts)',
  chat: "D-025 scopes voice approval to a transport-identified owner LINE; in-app answers \"Tap the card to approve — I don't take approvals by voice here yet.\"",
};

export const CAPABILITIES: Readonly<Record<ClassifiableIntent, CapabilityDeclaration>> = {
  // ── Proposal capabilities (section A of the catalog) ─────────────────────
  create_invoice: proposal('draft_invoice', 'Invoice the Johnson job, $450 capacitor + labor'),
  draft_estimate: proposal('draft_estimate', 'Quote the Khan install, 3-ton condenser'),
  create_appointment: proposal('create_appointment', 'Book Carlos at the Garcia place Tue 2pm'),
  update_invoice: proposal('update_invoice', 'Add a $90 contactor to the Smith invoice'),
  update_estimate: proposal('update_estimate', 'Change the Khan quote to a 3-ton'),
  issue_invoice: proposal('issue_invoice', 'Issue the Garcia invoice'),
  batch_invoice: proposal('batch_invoice', 'Invoice all my completed jobs'),
  create_customer: proposal('create_customer', 'New customer Maria Alvarez, 480-555-0102'),
  create_job: proposal('create_job', 'Open a job for Alvarez, no AC'),
  update_job: proposal('update_job', 'Mark the Henderson job in progress'),
  reschedule_appointment: proposal('reschedule_appointment', 'Move the Garcia job to Thursday 10'),
  cancel_appointment: proposal('cancel_appointment', "Cancel Tuesday's Garcia appointment"),
  reassign_appointment: proposal('reassign_appointment', 'Put Carlos on the Garcia job instead of me'),
  add_crew_member: proposal('add_crew_member', 'Add Carlos to the Garcia appointment'),
  remove_crew_member: proposal('remove_crew_member', "Take Carlos off Tuesday's job"),
  add_note: proposal('add_note', 'Note on the Patel job: wants morning visits'),
  send_invoice: proposal('send_invoice', 'Send the Johnson invoice'),
  send_estimate: proposal('send_estimate', 'Send the Khan estimate'),
  send_estimate_nudge: proposal('send_estimate_nudge', 'Nudge the Khan estimate again'),
  send_payment_reminder: proposal('send_payment_reminder', 'Chase the unpaid Smith invoice'),
  apply_late_fee: proposal('apply_late_fee', 'Add a $25 late fee to the Smith invoice'),
  record_payment: proposal('record_payment', 'Mark the Smith invoice paid, $200 cash'),
  emergency_dispatch: proposal('emergency_dispatch', 'Emergency, no heat at the Hayes place — page me', {
    chat:
      'the 2026-08-07 tradesperson plan keeps emergency dispatch surface-specific by design; chat answers with the generic unmapped-capability refusal (routes/assistant.ts buildUnmappedCapabilityReply)',
  }),
  update_customer: proposal('update_customer', "Update Alvarez's phone number"),
  log_expense: proposal('log_expense', 'Log a $60 parts expense on the Patel job'),
  convert_lead: proposal('convert_lead', 'Convert the Greenfield lead to a customer'),
  confirm_appointment: proposal('confirm_appointment', 'Confirm the Garcia appointment'),
  mark_lead_lost: proposal('mark_lead_lost', 'Mark the Wagner lead lost — went with a competitor'),
  add_service_location: proposal('add_service_location', 'Add a service location for Greenfield, 12 Lakeshore'),
  log_time_entry: proposal('log_time_entry', 'Clock 2 hours on the Patel job'),
  notify_delay: proposal('notify_delay', "Text the Garcia customer I'm 20 min late"),
  request_feedback: proposal('request_feedback', 'Ask the Smith customer for a review'),
  // Alias intents: drafting + execution are keyed by PROPOSAL type, so each
  // inherits its target's legs unchanged (log_mileage's drafting branches on
  // the intent-specific `mileageMiles` entity).
  schedule_inspection: proposal('create_appointment','Schedule the rough-in inspection for Thursday'),
  log_permit: proposal('add_note', 'Log permit 2024-1187 on the Patel job'),
  log_warranty_claim: proposal('create_job', "Log a warranty callback for the Hendersons' water heater"),
  update_catalog_item: proposal('update_catalog_item', 'Raise the diagnostic fee to 89 dollars'),
  record_refund: proposal('record_refund', 'Refund the Smiths 100 dollars on their invoice'),
  apply_credit: proposal('apply_credit', 'Knock 50 dollars off the Henderson invoice'),
  send_customer_message: proposal(
    'send_customer_message',
    'Text the Hendersons the part arrived, we can come Thursday',
  ),
  create_change_order: proposal('create_change_order', 'The Garcias want a second zone — change order for 1800'),
  create_service_agreement: proposal(
    'create_service_agreement',
    'Sign the Garcias up for the annual maintenance plan, 290 a year',
  ),
  add_material: proposal('add_material', 'Add three boxes of half-inch PEX to the shopping list'),
  log_mileage: proposal('log_expense', 'Log 32 miles to the Patel job'),
  add_catalog_item: proposal('add_catalog_item', 'Add a catalog item: smart thermostat install, 385'),
  create_invoice_schedule: proposal(
    'create_invoice_schedule',
    'Set up 50% deposit, 50% on completion for the Hendersons',
  ),
  respond_to_review: proposal('review_response_proposal', 'Respond to that 1-star review', {
    chat: NO_SHARED_DRAFTING_HANDLER,
  }),
  create_standing_instruction: proposal(
    'create_standing_instruction',
    'From now on always add a $79 diagnostic fee to AC calls',
    { chat: NO_SHARED_DRAFTING_HANDLER },
  ),
  // B1.18 — `manual` class: never auto-approves at any trust tier. The lock
  // stays tap-only: the payload has no field that can express
  // `brand_voice_locked` (contracts/brand-voice.ts).
  update_brand_voice: proposal(
    'update_brand_voice',
    "Set my brand voice: friendly, plain-spoken, no slang, always sign off 'Thanks — Bob's HVAC'",
    { chat: NO_SHARED_DRAFTING_HANDLER },
  ),

  // ── Direct act (section F) ───────────────────────────────────────────────
  en_route: { kind: 'direct_act', example: 'On my way to the Garcia job' },

  // ── Lookups (section E) — one shared dispatch behind every surface ──────
  lookup_materials: LOOKUP,
  lookup_crew_schedule: LOOKUP,
  lookup_timesheets: LOOKUP,
  lookup_my_day: LOOKUP,
  lookup_appointments: LOOKUP,
  lookup_invoices: LOOKUP,
  lookup_balance: LOOKUP,
  lookup_jobs: LOOKUP,
  lookup_agreements: LOOKUP,
  lookup_account_summary: LOOKUP,
  lookup_customer: LOOKUP,
  lookup_estimates: LOOKUP,
  lookup_availability: LOOKUP,
  lookup_leads: LOOKUP,
  lookup_revenue: LOOKUP,
  lookup_catalog: LOOKUP,
  lookup_day_overview: LOOKUP,
  lookup_digest: LOOKUP,
  lookup_pending_items: LOOKUP,
  lookup_job_profit: LOOKUP,

  // ── Dialogue — understood turns with no proposal of their own ───────────
  // complaint / negotiation draft the shared `callback` type through their
  // own synthetic handlers (`_complaint` / `_negotiation`), not the map.
  complaint: { kind: 'dialogue' },
  negotiation: { kind: 'dialogue' },
  language_switch: {
    kind: 'dialogue',
    unavailableOn: { memo: 'a recorded memo has no live call whose language can be switched (Task 13, 2026-08-07 plan)' },
  },
  operator_request: {
    kind: 'dialogue',
    unavailableOn: { memo: 'a recorded memo has no live operator to transfer to (Task 13, 2026-08-07 plan)' },
  },
  confirm: {
    kind: 'dialogue',
    unavailableOn: { memo: 'a recorded memo has no live pending question to confirm (Task 13, 2026-08-07 plan)' },
  },

  // ── Approval (section D) — live owner line only ─────────────────────────
  approve_proposal: { kind: 'approval', unavailableOn: APPROVAL_OPT_OUTS },
  reject_proposal: { kind: 'approval', unavailableOn: APPROVAL_OPT_OUTS },
  edit_proposal: { kind: 'approval', unavailableOn: APPROVAL_OPT_OUTS },
};

/** True when the capability is served on `surface` (parity is the default). */
export function isAvailableOn(cap: CapabilityDeclaration, surface: CapabilitySurface): boolean {
  return !cap.unavailableOn || cap.unavailableOn[surface] === undefined;
}

type CapabilityTable = Readonly<Record<string, CapabilityDeclaration>>;

/**
 * The phone / memo / in-app intent → proposal-type map. Every proposal
 * capability is in it; the phone and memo surfaces declare no proposal
 * opt-outs today, and the in-app voice adapter shares this map.
 */
export function deriveIntentToProposalType(
  capabilities: CapabilityTable,
): Partial<Record<ClassifiableIntent, ProposalType>> {
  const map: Partial<Record<string, ProposalType>> = {};
  for (const [intent, cap] of Object.entries(capabilities)) {
    if (cap.kind === 'proposal') map[intent] = cap.proposalType;
  }
  return map as Partial<Record<ClassifiableIntent, ProposalType>>;
}

/**
 * The chat route's dispatch map and its declared exclusions.
 *
 * `dispatch` — every proposal capability available on chat, EXCEPT the
 * dedicated-branch intents (served on chat from their own branch, so they are
 * neither in the map nor excluded). `excluded` — every proposal capability
 * that opts out of chat.
 */
export function deriveChatDispatch(
  capabilities: CapabilityTable,
  dedicatedBranchIntents: ReadonlySet<string>,
): { dispatch: Readonly<Record<string, ProposalType>>; excluded: ReadonlySet<string> } {
  const dispatch: Record<string, ProposalType> = {};
  const excluded = new Set<string>();
  for (const [intent, cap] of Object.entries(capabilities)) {
    if (cap.kind !== 'proposal') continue;
    if (!isAvailableOn(cap, 'chat')) {
      excluded.add(intent);
      continue;
    }
    if (dedicatedBranchIntents.has(intent)) continue;
    dispatch[intent] = cap.proposalType;
  }
  return { dispatch, excluded };
}

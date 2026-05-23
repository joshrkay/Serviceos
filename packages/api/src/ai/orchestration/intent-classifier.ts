import { LLMGateway } from '../gateway/gateway';

/**
 * Voice-to-action intent classifier.
 *
 * Takes a voice transcript, returns a structured classification that
 * the voice-action-router uses to dispatch to the right AI task.
 *
 * Phase 1 handled: create_invoice, draft_estimate, create_appointment.
 * Phase 2 adds:    update_invoice (add/remove line item).
 * Phase 3 adds:    issue_invoice (send a drafted invoice to the customer).
 * Phase 4 intents (query_*) still return 'unknown'.
 */

export type IntentType =
  | 'create_invoice'
  | 'draft_estimate'
  | 'create_appointment'
  | 'update_invoice'
  | 'update_estimate'
  | 'issue_invoice'
  | 'create_customer'
  | 'create_job'
  | 'reschedule_appointment'
  | 'cancel_appointment'
  | 'reassign_appointment'
  | 'add_note'
  | 'send_invoice'
  | 'record_payment'
  | 'emergency_dispatch'
  // P11-001: voice lookup-skill family. Read-only intents — the
  // adapter routes these straight to the `lookup_*` skill instead
  // of the proposal-draft path.
  | 'lookup_appointments'
  | 'lookup_invoices'
  | 'lookup_balance'
  | 'lookup_jobs'
  | 'lookup_agreements'
  | 'lookup_account_summary'
  | 'lookup_customer'
  | 'lookup_estimates'
  // P11-002: caller asks to switch the call language ("english please" /
  // "hablo español"). The adapter consumes this as a signal to flip the
  // session language — it is NOT a proposal-driving intent.
  | 'language_switch'
  // Seamless Handoff: caller explicitly asks to speak with a human.
  // The FSM fast-paths directly to escalating without entity_resolution
  // or intent_confirm.
  | 'operator_request'
  // Caller confirms/agrees to a pending action the agent proposed
  // ("yes", "that's right", "go ahead"). Conversational, non-proposal.
  | 'confirm'
  | 'unknown';

const SUPPORTED_INTENTS: readonly IntentType[] = [
  'create_invoice',
  'draft_estimate',
  'create_appointment',
  'update_invoice',
  'update_estimate',
  'issue_invoice',
  'create_customer',
  'create_job',
  'reschedule_appointment',
  'cancel_appointment',
  'reassign_appointment',
  'add_note',
  'send_invoice',
  'record_payment',
  'emergency_dispatch',
  'lookup_appointments',
  'lookup_invoices',
  'lookup_balance',
  'lookup_jobs',
  'lookup_agreements',
  'lookup_account_summary',
  'lookup_customer',
  'lookup_estimates',
  'language_switch',
  'operator_request',
  'confirm',
  'unknown',
] as const;

/**
 * P11-001: convenience predicate the FSM adapter uses to route
 * `lookup_*` intents to the read-only skill family instead of the
 * proposal-draft pipeline.
 */
export function isLookupIntent(intent: IntentType | undefined | null): boolean {
  return typeof intent === 'string' && intent.startsWith('lookup_');
}

export interface ExtractedEntities {
  customerName?: string;
  jobReference?: string;
  amount?: number; // integer cents
  dateTimeDescription?: string; // raw natural language — downstream task parses
  lineItemDescriptions?: string[];
  // create_customer fields. `displayName` is the new customer's name; it is
  // intentionally distinct from `customerName` (which refers to an EXISTING
  // customer on invoice/estimate/appointment intents). `email` / `phone`
  // are optional — missing fields flow to clarification, not to 'unknown'.
  displayName?: string;
  email?: string;
  phone?: string;
  // Scheduling-edit intents (reschedule / cancel / reassign). Either
  // an appointment reference ("tomorrow's 3pm", "the Miller job",
  // "APT-0012") or a newDateTimeDescription for reschedule. Target
  // technician for reassign is a name — the review UI resolves names
  // to IDs since the classifier never touches the DB.
  appointmentReference?: string;
  newDateTimeDescription?: string;
  targetTechnicianName?: string;
  cancellationReason?: string;
  cancellationType?: 'customer_request' | 'technician_unavailable' | 'scheduling_conflict' | 'other';
  // add_note intent. `noteTargetKind` disambiguates whether the note
  // attaches to a job, customer, invoice, estimate, or appointment.
  noteBody?: string;
  noteTargetKind?: 'job' | 'customer' | 'invoice' | 'estimate' | 'appointment';
  // send_invoice intent: channel hints ("email", "sms"). Defaults
  // are resolved by the execution handler when unspecified.
  sendChannel?: 'email' | 'sms';
  // record_payment intent. paymentMethod = cash / check / card / other.
  // paymentReference = check number or memo the operator stated.
  paymentMethod?: 'cash' | 'check' | 'card' | 'other';
  paymentReference?: string;
  // create_job intent: title of the new job.
  jobTitle?: string;
}

/**
 * When `intentType === 'unknown'` the router emits a
 * voice_clarification proposal instead of silently dropping.
 * `unknownReason` tells the router (and the UI) WHY routing failed
 * so the clarification message can be phrased usefully.
 *
 *   - 'empty_transcript'  — nothing to classify
 *   - 'parse_failed'      — classifier output wasn't valid JSON
 *   - 'unknown_intent'    — classifier picked 'unknown' at any confidence
 *   - 'low_confidence'    — classifier picked a real intent, but < 0.6
 *
 * `lowConfidenceIntent` is populated only on 'low_confidence': it is
 * the intent the classifier leaned toward so the clarification card
 * can offer it as a "did you mean?" suggestion.
 */
export type UnknownReason =
  | 'empty_transcript'
  | 'parse_failed'
  | 'unknown_intent'
  | 'low_confidence';

export interface IntentClassification {
  intentType: IntentType;
  confidence: number; // 0-1
  reasoning?: string;
  extractedEntities?: ExtractedEntities;
  unknownReason?: UnknownReason;
  lowConfidenceIntent?: IntentType;
  /**
   * Enum-typed fields the LLM returned with a value outside the
   * allowed set (e.g., `cancellationType: "weather"` when only
   * customer_request / technician_unavailable / scheduling_conflict /
   * other are valid). Preserved here so the router can emit a
   * structured warn log instead of silently dropping the field —
   * helps diagnose LLM prompting drift without blocking the
   * pipeline. Empty / undefined when every enum is valid.
   */
  invalidEnumFields?: Array<{ field: string; value: unknown }>;
  /**
   * Token usage from the underlying LLM call, surfaced so callers
   * (e.g., the calling-agent adapter) can feed the SessionCostTracker
   * and enforce per-session caps. Omitted when the classifier
   * short-circuits without an LLM call.
   */
  tokenUsage?: { input: number; output: number };
}

export interface ClassifyContext {
  tenantId: string;
  /**
   * Optional vertical-aware prompt section produced by
   * `formatVerticalForCallerPrompt(pack)` in
   * `packages/api/src/verticals/context-assembly.ts`. When supplied,
   * it is appended to the system prompt as a tenant-scoped Context
   * Block — the LLM gets the tenant's actual equipment terminology
   * and service categories so callers saying "my heater is broken"
   * map to the right canonical entity instead of a hallucinated one.
   * Closes §3B from `docs/remaining-features.md`. Optional so callers
   * that don't have a pack loaded (e.g. operator UI flows where
   * tenants may not have onboarded a vertical yet) can omit it.
   *
   * §3D extension: the resolver now also includes the pack's
   * `intakeQuestions` block in this same string when present.
   */
  verticalPromptSection?: string;
  /**
   * Optional caller-plan / membership context produced by
   * `formatCallerPlanForPrompt(ctx)` in
   * `packages/api/src/ai/orchestration/caller-plan-context.ts`.
   * Closes §3C — when a customer with an active maintenance plan
   * calls in, the agent acknowledges the plan in its replies and
   * routes with priority. Optional: when caller is unknown or has
   * no active plan the section is omitted.
   */
  planPromptSection?: string;
  /**
   * True when the inbound caller has already been resolved to an
   * existing customer (e.g. by caller-ID). Suppresses the deterministic
   * "sign up" → create_customer override: an established customer who
   * says "can I sign up?" should be recognized, not enrolled again as a
   * duplicate. Identity-unaware callers keep the create_customer
   * short-circuit (P18-001).
   */
  callerIsExistingCustomer?: boolean;
}

/**
 * Below this threshold the classifier returns 'unknown' regardless of
 * the LLM's self-reported intent. Picked at 0.6 — low enough to catch
 * obvious commands, high enough to send ambiguous transcripts to
 * clarification rather than executing the wrong action.
 */
export const CLASSIFIER_CONFIDENCE_THRESHOLD = 0.6;

/**
 * Sign-up phrasings must clear the FSM intent gate (TAU_INT = 0.75 in
 * customer-calling transitions). When the LLM returns create_customer in
 * the [0.6, 0.75) band we still bump confidence so voice does not reprompt
 * on an unambiguous new-customer request.
 */
export const SIGNUP_INTENT_ACT_THRESHOLD = 0.75;

const SYSTEM_PROMPT = `You are an intent classifier for a field service operating system.
Given a voice transcript from a field service operator, decide which action they intend to take.

Supported intents (return exactly ONE):
- "create_invoice"      — user wants to draft a NEW invoice for work completed.
                           Example: "Create an invoice for Acme for 450 dollars"
- "draft_estimate"      — user wants to draft a new estimate/quote before work starts.
                           Example: "Draft an estimate for the Johnson water heater"
- "create_appointment"  — user wants to schedule a new appointment or follow-up.
                           Example: "Schedule a follow-up for Mrs Lee next Tuesday at 2pm"
- "update_invoice"      — user wants to ADD or REMOVE a line item on an EXISTING
                           draft invoice. Requires an explicit invoice reference
                           (number or customer name).
                           Examples: "Add a trip fee to invoice INV-0042"
                                     "Remove the diagnostic from the Smith invoice"
- "update_estimate"     — user wants to ADD or REMOVE a line item on an EXISTING
                           draft estimate. Requires an explicit estimate reference
                           (number or customer name).
                           Examples: "Add a site visit to estimate EST-0001"
                                     "Remove the old heater from the Johnson estimate"
- "issue_invoice"       — user wants to SEND/ISSUE an existing DRAFT invoice to
                           the customer. May reference the invoice explicitly by
                           number or customer name, or implicitly ("the one we
                           just drafted", "that invoice", "the Acme invoice").
                           Examples: "Send invoice 1024 to the customer"
                                     "Issue the Acme invoice"
                                     "Send the invoice we just drafted"
- "unknown"             — anything else: genuinely ambiguous transcripts,
                           or commands without a clear target. Note that
                           read-only queries ("when is my next appointment",
                           "how much do I owe") now have dedicated
                           lookup_* intents below — only fall through to
                           "unknown" when no lookup intent matches.
- "create_customer"     — user wants to create a NEW customer record in the CRM,
                           OR an inbound CALLER is signing up as a new customer
                           themselves ("I'd like to sign up", "I'm a new
                           customer", "first time calling, please add me").
                           This is the highest-leak intent on inbound calls —
                           if the caller is not already in the system and
                           wants to become a customer, classify as
                           create_customer with high confidence.
                           Trigger phrasings include "create/add/new customer",
                           "sign up", "set up an account", "become a customer",
                           "first time calling", "add me to your system",
                           and any natural caller-side phrasing for
                           establishing a new account.
                           Extract the customer's displayName plus any stated
                           email or phone. When only the name is given (or even
                           no name at all — the caller-id phone is captured
                           upstream), still classify as create_customer so the
                           downstream flow can ask a clarifying question — do
                           NOT fall back to "unknown" just because email/phone
                           or even displayName are missing.
                           Examples: "Create a new customer named Alex"
                                     "Add customer Acme Corp, email alex@acme.com"
                                     "New customer: Sarah, phone 555-0100"
                                     "Add a customer called Jordan Lee"
                                     "Create customer Maria Gomez at maria@gomez.co"
                                     "I'd like to sign up as a new customer"
                                     "I'm a new customer"
                                     "Can you set up an account for me?"
                                     "I want to become a customer"
                                     "First time calling, please add me"
                                     "Quisiera registrarme como nuevo cliente"
                                     "Soy un cliente nuevo"
- "create_job"          — user wants to open a NEW job record (distinct from
                           scheduling an appointment). Extract customerName
                           and jobTitle.
                           Examples: "Start a new job for Bob's water heater"
                                     "Create a job for Smith plumbing — kitchen drain"
- "reschedule_appointment" — user wants to move an EXISTING appointment to a
                           different time. Extract appointmentReference
                           (the old slot or the job/customer identifier)
                           and newDateTimeDescription (the new time).
                           Examples: "Move the Miller job to Thursday at 2pm"
                                     "Push tomorrow's 10am to 3pm"
                                     "Reschedule the Davis appointment to next Monday"
- "cancel_appointment"  — user wants to CANCEL an existing appointment.
                           Extract appointmentReference and, when stated,
                           cancellationReason. This is irreversible — never
                           auto-execute.
                           Examples: "Cancel tomorrow's 3pm, the customer called out"
                                     "Kill the Johnson appointment"
                                     "Cancel the Wilson job — weather closed us down"
- "reassign_appointment" — user wants to assign an EXISTING appointment to a
                           different technician. Extract appointmentReference
                           and targetTechnicianName.
                           Examples: "Give Tuesday's Davis job to Mike"
                                     "Reassign the 2pm to Sarah"
- "add_note"            — user wants to attach a note to an existing record.
                           Extract noteTargetKind (job / customer / invoice /
                           estimate / appointment) and noteBody.
                           Examples: "Note on the Rodriguez job: customer
                                      wants a call before we arrive"
                                     "Add a note to Smith's file: prefers SMS"
- "send_invoice"        — user wants to SEND an existing invoice to a
                           customer (email or SMS). This is a customer
                           comms action — never auto-execute, always
                           require a screen-tap approval. Extract the
                           invoice reference and sendChannel.
                           Examples: "Send invoice INV-0042 to Sarah"
                                     "Email the Jones invoice"
                                     "Text the Miller invoice to them"
- "record_payment"      — user wants to log a PAYMENT received against an
                           invoice. This is money-moving — never
                           auto-execute, always require a screen-tap
                           approval. Extract amount (integer cents),
                           paymentMethod, paymentReference (check #),
                           and the invoice / customer it applies to.
                           Examples: "Mark the Jones invoice paid, 450 cash"
                                     "Record a check for 200 from Smith, check 1042"
                                     "Rodriguez paid the invoice in full"
- "emergency_dispatch"  — caller describes a life-safety or property-
                           emergency situation requiring IMMEDIATE
                           response: no heat/cool in extreme weather, gas
                           smell, burning smell, smoke, sparks, flooding,
                           burst pipe, sewage backup, no water. Skip normal
                           intent confirmation — escalate directly to
                           on-call dispatcher. Never auto-execute.
                           Examples: "There's a gas smell coming from the furnace"
                                     "My pipes burst and water is everywhere"
                                     "No heat and it's 10 degrees outside"
                                     "I smell burning from my AC unit"
- "operator_request"   — caller explicitly asks to speak with a person,
                          dispatcher, owner, or asks to leave the AI agent.
                          Skip normal intent confirmation — escalate
                          directly to on-call dispatcher.
                          Examples: "Let me talk to a human"
                                    "I want a real person"
                                    "Can I speak to a person please"
                                    "Transfer me to dispatch"
                                    "I don't want to talk to a bot"
                                    "Can I speak with the owner"
                          NOTE: "I want to schedule with a person" is NOT
                          operator_request — the intent is scheduling, not
                          transferring.
- "confirm"            — caller confirms or agrees to a pending action the
                          agent just proposed. Conversational, non-proposal.
                          Examples: "Yes, that's right"
                                    "Go ahead"
                                    "Correct, book it"
                                    "Yep, that works"
- "lookup_appointments" — caller is ASKING about their upcoming
                           appointment(s). Read-only — never moves money
                           or creates records. Routed to the
                           lookup_appointments skill, which speaks the
                           next visit + technician.
                           Examples: "When is my next appointment?"
                                     "What time are you coming on Tuesday?"
                                     "Do I have a service call scheduled?"
                                     "When are y'all coming out?"
                                     "Remind me when my appointment is"
- "lookup_invoices"     — caller is ASKING about invoices on their
                           account. Read-only. The skill returns count
                           + totals + per-invoice info.
                           Examples: "Do I have any invoices outstanding?"
                                     "What invoices do I owe?"
                                     "Can you read me my open invoices?"
                                     "How many bills do I have?"
                                     "What's the latest invoice you sent me?"
- "lookup_balance"      — caller is ASKING for the dollar total they
                           owe right now. Read-only.
                           Examples: "What's my balance?"
                                     "How much do I owe?"
                                     "What do I still owe you guys?"
                                     "Can you tell me my account balance?"
                                     "Total amount due on my account?"
- "lookup_jobs"         — caller is ASKING about their recent or current
                           jobs. Read-only.
                           Examples: "What jobs do I have open?"
                                     "Tell me about my last service call"
                                     "What's the status of my repair?"
                                     "Did you finish the work order?"
                                     "What jobs are on my account?"
- "lookup_agreements"   — caller is ASKING about their service plan /
                           agreement / membership. Read-only.
                           Examples: "When does my service plan run next?"
                                     "Do I still have my maintenance agreement?"
                                     "When's my next maintenance visit?"
                                     "What's on my service contract?"
                                     "Am I still on the membership plan?"
- "language_switch"     — caller asks to switch the call language.
                           Read-only, non-proposal — the adapter flips
                           the session language and acknowledges. Trigger
                           phrasings include "english please", "speak
                           english", "hablo español", "en español".
                           Spanish prompt examples (so the classifier
                           handles bilingual mid-call switches):
                              "Hablo español, por favor"
                              "¿Puedo continuar en español?"
                              "Switch to english please"
                              "I'd rather speak english"
- "lookup_account_summary" — caller asks an open-ended "what's on my
                           account" / "give me an update" question.
                           Read-only. The skill stitches the appointment,
                           balance, and agreement summaries into a
                           two-sentence digest.
                           Examples: "What's on my account?"
                                     "Give me a quick summary"
                                     "Catch me up on my account"
                                     "Where do I stand?"
                                     "Tell me about my account"
- "lookup_customer"     — caller is ASKING about the contact info or
                           CRM record we have on file for them — name,
                           phone, email, communication notes. Read-only.
                           Examples: "Can you confirm my contact info?"
                                     "What number do you have on file?"
                                     "Read me the email you have for me"
                                     "Do you have my correct address?"
                                     "Check what's on my customer record"
- "lookup_estimates"    — caller is ASKING about quotes/estimates on
                           their account — count, totals, status of
                           prior estimates. Read-only.
                           Examples: "What estimates have you sent me?"
                                     "Read me my open quotes"
                                     "Did you send me an estimate yet?"
                                     "What's the status of my quote?"
                                     "How much was that estimate?"
- "unknown"             — anything else: ambiguous transcripts, or edit
                           commands without a clear reference.

Distinctions that matter:
- "create an invoice/estimate" vs "add to invoice/estimate" — the word
  "add/remove/update" plus a reference to an EXISTING invoice or estimate
  = update_invoice or update_estimate. Any phrasing starting a NEW one
  = create_invoice or draft_estimate.
- "send/issue/deliver an invoice" = issue_invoice, NOT create_invoice.
- Invoice vs estimate — the operator usually says which. When they say
  "invoice" or use an "INV-" prefix, use the invoice intent; when they say
  "estimate/quote" or "EST-", use the estimate intent. When genuinely
  ambiguous, prefer "unknown".
- For issue_invoice, put the invoice number or reference in jobReference.
  If the user says "the one we just drafted" with no explicit ID, omit
  jobReference — the router resolves it from conversation context.
- "add customer <name>" = create_customer (CRM record).
  "add a <thing> to <existing invoice/estimate>" = update_invoice/update_estimate.
  When "add" refers to a line item, money, or an existing document, it is
  NOT create_customer even if a customer name appears in the sentence.

Return valid JSON with exactly this shape (no prose, no markdown fences):
{
  "intentType": "<one of the values above>",
  "confidence": <number between 0 and 1>,
  "reasoning": "<one sentence explaining the classification>",
  "extractedEntities": {
    "customerName": "<string, optional — existing-customer reference on invoice/estimate/appointment>",
    "jobReference": "<string, optional>",
    "amount": <integer cents, optional>,
    "dateTimeDescription": "<verbatim date/time phrase from transcript, optional>",
    "lineItemDescriptions": ["<string>", ...],
    "displayName": "<string, optional — NEW customer's name on create_customer>",
    "email": "<string, optional — NEW customer's email on create_customer>",
    "phone": "<string, optional — NEW customer's phone on create_customer>",
    "appointmentReference": "<string, optional — existing appointment reference>",
    "newDateTimeDescription": "<string, optional — new time for reschedule_appointment>",
    "targetTechnicianName": "<string, optional — target technician on reassign_appointment>",
    "cancellationReason": "<string, optional — free-text reason on cancel_appointment>",
    "cancellationType": "<customer_request|technician_unavailable|scheduling_conflict|other, optional>",
    "noteBody": "<string, optional — the note text on add_note>",
    "noteTargetKind": "<job|customer|invoice|estimate|appointment, optional>",
    "sendChannel": "<email|sms, optional — on send_invoice>",
    "paymentMethod": "<cash|check|card|other, optional — on record_payment>",
    "paymentReference": "<string, optional — check number or memo on record_payment>",
    "jobTitle": "<string, optional — title of new job on create_job>"
  }
}

Confidence calibration:
- 0.9+ : unambiguous command, key entities extracted
- 0.7-0.9 : clear command, some entities missing but inferable
- 0.5-0.7 : probable command, significant entity gaps
- below 0.5 : ambiguous — prefer "unknown"

Never invent entities. Extract only what the transcript actually says.`;

function isSupportedIntent(value: unknown): value is IntentType {
  return typeof value === 'string' && (SUPPORTED_INTENTS as readonly string[]).includes(value);
}

function clamp01(n: number): number {
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

export function parseClassifierJson(content: string): IntentClassification | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;

  if (!isSupportedIntent(obj.intentType)) return null;

  const rawConfidence = typeof obj.confidence === 'number' ? obj.confidence : 0;
  const confidence = clamp01(rawConfidence);

  const result: IntentClassification = {
    intentType: obj.intentType,
    confidence,
  };

  if (typeof obj.reasoning === 'string') {
    result.reasoning = obj.reasoning;
  }

  // Enum-typed fields that the LLM returned with an invalid value
  // are collected here so the router can emit a structured warn log
  // (P1-5). Silent drops hide classifier-prompt drift; loud-but-
  // non-blocking logging gives us visibility without breaking flow.
  const invalidEnumFields: Array<{ field: string; value: unknown }> = [];

  // Allowed-value tables for each enum the classifier may return.
  // Kept close to the extraction loop so they live next to the
  // field names they guard. Adding a new enum means adding one
  // entry here and one line in the extraction block below — no new
  // if/else branch required.
  const CANCELLATION_TYPES = [
    'customer_request',
    'technician_unavailable',
    'scheduling_conflict',
    'other',
  ] as const;
  const NOTE_TARGET_KINDS = [
    'job',
    'customer',
    'invoice',
    'estimate',
    'appointment',
  ] as const;
  const SEND_CHANNELS = ['email', 'sms'] as const;
  const PAYMENT_METHODS = ['cash', 'check', 'card', 'other'] as const;

  /**
   * Validate an LLM-provided value against a fixed allowed-set.
   * Returns the typed value when valid, undefined when absent, and
   * undefined with a recorded invalid-field entry when present-but-
   * out-of-set. Keeps the four enum-check blocks below to a single
   * line each.
   */
  function pickEnum<T extends string>(
    entity: Record<string, unknown>,
    fieldName: string,
    allowed: readonly T[]
  ): T | undefined {
    const value = entity[fieldName];
    if (value === undefined) return undefined;
    if ((allowed as readonly unknown[]).includes(value)) return value as T;
    invalidEnumFields.push({ field: fieldName, value });
    return undefined;
  }

  if (typeof obj.extractedEntities === 'object' && obj.extractedEntities !== null) {
    const ee = obj.extractedEntities as Record<string, unknown>;
    const extracted: ExtractedEntities = {};
    if (typeof ee.customerName === 'string') extracted.customerName = ee.customerName;
    if (typeof ee.jobReference === 'string') extracted.jobReference = ee.jobReference;
    if (typeof ee.amount === 'number') extracted.amount = ee.amount;
    if (typeof ee.dateTimeDescription === 'string') extracted.dateTimeDescription = ee.dateTimeDescription;
    if (Array.isArray(ee.lineItemDescriptions)) {
      extracted.lineItemDescriptions = ee.lineItemDescriptions.filter(
        (s): s is string => typeof s === 'string'
      );
    }
    if (typeof ee.displayName === 'string') extracted.displayName = ee.displayName;
    if (typeof ee.email === 'string') extracted.email = ee.email;
    if (typeof ee.phone === 'string') extracted.phone = ee.phone;
    // Scheduling-edit fields
    if (typeof ee.appointmentReference === 'string') extracted.appointmentReference = ee.appointmentReference;
    if (typeof ee.newDateTimeDescription === 'string') extracted.newDateTimeDescription = ee.newDateTimeDescription;
    if (typeof ee.targetTechnicianName === 'string') extracted.targetTechnicianName = ee.targetTechnicianName;
    if (typeof ee.cancellationReason === 'string') extracted.cancellationReason = ee.cancellationReason;
    const cancellationType = pickEnum(ee, 'cancellationType', CANCELLATION_TYPES);
    if (cancellationType) extracted.cancellationType = cancellationType;
    // add_note fields
    if (typeof ee.noteBody === 'string') extracted.noteBody = ee.noteBody;
    const noteTargetKind = pickEnum(ee, 'noteTargetKind', NOTE_TARGET_KINDS);
    if (noteTargetKind) extracted.noteTargetKind = noteTargetKind;
    // send_invoice fields
    const sendChannel = pickEnum(ee, 'sendChannel', SEND_CHANNELS);
    if (sendChannel) extracted.sendChannel = sendChannel;
    // record_payment fields
    const paymentMethod = pickEnum(ee, 'paymentMethod', PAYMENT_METHODS);
    if (paymentMethod) extracted.paymentMethod = paymentMethod;
    if (typeof ee.paymentReference === 'string') extracted.paymentReference = ee.paymentReference;
    // create_job fields
    if (typeof ee.jobTitle === 'string') extracted.jobTitle = ee.jobTitle;
    if (Object.keys(extracted).length > 0) {
      result.extractedEntities = extracted;
    }
  }

  if (invalidEnumFields.length > 0) {
    result.invalidEnumFields = invalidEnumFields;
  }

  return result;
}

function unknownResult(
  reason: string,
  unknownReason: UnknownReason
): IntentClassification {
  return {
    intentType: 'unknown',
    confidence: 0,
    reasoning: reason,
    unknownReason,
  };
}

/**
 * P18-001: deterministic short-circuit for caller-side sign-up
 * phrasings. The voice-call flow has been losing every inbound
 * non-customer because the LLM was returning 'unknown' for "I'd like
 * to sign up as a new customer" — phrases that are unambiguously a
 * `create_customer` intent. We detect those phrasings up-front with a
 * cheap regex pass; the LLM is still consulted to extract entities
 * (displayName / email / phone) but the intent decision is locked in
 * by the regex so a model regression cannot silently re-introduce the
 * leak. Returns the canonical phrase set the regex matched so the
 * caller can override the LLM's intentType when (and only when) the
 * regex fired.
 *
 * Keeps the bar tight: matches are anchored to whole-word phrasings
 * to avoid false positives (e.g. "I'd like to set up an appointment"
 * must NOT collapse to create_customer).
 *
 * Includes lightweight Spanish phrasings to keep parity with the
 * P11-002 multilingual path — same intent, same confidence.
 */
const CREATE_CUSTOMER_SIGNUP_PATTERNS: ReadonlyArray<RegExp> = [
  /\bsign(?:ing)?\s*up\b(?!.*\bappointment\b)/i,
  /\bnew\s+customer\b/i,
  /\bbecome\s+a\s+customer\b/i,
  // PR #265 review fix: each "account/me" phrasing was firing on
  // adjacent appointment/schedule wording — e.g. "set up an account
  // for my appointment" was being collapsed to create_customer and
  // overriding the LLM's correct create_appointment classification.
  // Negative lookaheads exclude appointment/schedule context, and the
  // generic "add me" was tightened to "add/register me to (your) system"
  // so "add me to the schedule" stays in create_appointment.
  /\bset\s+up\s+(?:an?\s+)?account\b(?!.*\b(?:appointment|schedule)\b)/i,
  /\bopen\s+(?:an?\s+)?account\b(?!.*\b(?:appointment|schedule)\b)/i,
  /\bfirst[-\s]time\s+calling\b/i,
  /\b(?:add|register)\s+me\s+to\s+(?:your\s+)?system\b/i,
  /\bregistrarme\b/i,
  /\bcliente\s+nuevo\b/i,
  /\bnuevo\s+cliente\b/i,
];

export function isCreateCustomerSignupPhrasing(transcript: string): boolean {
  if (!transcript) return false;
  return CREATE_CUSTOMER_SIGNUP_PATTERNS.some((rx) => rx.test(transcript));
}

export async function classifyIntent(
  transcript: string,
  context: ClassifyContext,
  gateway: LLMGateway
): Promise<IntentClassification> {
  // Cheap short-circuit: empty / whitespace transcripts never trigger an LLM call.
  if (!transcript || transcript.trim().length === 0) {
    return unknownResult('empty transcript', 'empty_transcript');
  }

  // Compose the system prompt: base classifier rules + (optional)
  // tenant vertical context + (optional) caller plan context. Each
  // optional block is delivered as a separate system message so it
  // doesn't dilute the canonical intent taxonomy and so per-tenant
  // prompt drift can't break the JSON contract enforced by the base
  // prompt.
  const systemMessages: Array<{ role: 'system'; content: string }> = [
    { role: 'system', content: SYSTEM_PROMPT },
  ];
  if (context.verticalPromptSection && context.verticalPromptSection.trim().length > 0) {
    systemMessages.push({
      role: 'system',
      content: `Tenant vertical context (use ONLY for entity recognition; do not change the JSON output schema):\n${context.verticalPromptSection}`,
    });
  }
  if (context.planPromptSection && context.planPromptSection.trim().length > 0) {
    systemMessages.push({
      role: 'system',
      content: `Caller plan context (use to personalize the response; do not change the JSON output schema):\n${context.planPromptSection}`,
    });
  }

  const response = await gateway.complete({
    taskType: 'classify_intent',
    messages: [
      ...systemMessages,
      { role: 'user', content: transcript },
    ],
    responseFormat: 'json',
    // Pass tenantId so gateway-layer features (per-tenant cache keys,
    // cost accounting, future routing) can scope correctly. Without
    // this, a cached response for tenant A could be returned to
    // tenant B if two transcripts collide on the content hash.
    metadata: { tenantId: context.tenantId },
  });

  const tokenUsage = response.tokenUsage
    ? { input: response.tokenUsage.input, output: response.tokenUsage.output }
    : undefined;

  const parsed = parseClassifierJson(response.content);
  // P18-001: deterministic create_customer fallback. When the
  // transcript carries a clear sign-up phrasing but the LLM returned
  // 'unknown' (or low confidence), force the intent to create_customer
  // so the voice agent never silently drops a non-customer caller.
  // We keep any extracted entities the LLM did manage to pull, and
  // pin confidence to 0.85 — comfortably above CLASSIFIER_CONFIDENCE_THRESHOLD
  // and the FSM's TAU_INT (0.75 in the calling-agent transitions).
  // An already-identified customer cannot "sign up" again — suppress the
  // deterministic create_customer override so they're recognized instead
  // of enrolled as a duplicate.
  const signupOverride =
    isCreateCustomerSignupPhrasing(transcript) && !context.callerIsExistingCustomer;
  if (!parsed) {
    if (signupOverride) {
      const result: IntentClassification = {
        intentType: 'create_customer',
        confidence: 0.85,
        reasoning: 'sign-up phrasing matched deterministic pattern',
      };
      if (tokenUsage) result.tokenUsage = tokenUsage;
      return result;
    }
    const result = unknownResult('could not parse classifier output', 'parse_failed');
    if (tokenUsage) result.tokenUsage = tokenUsage;
    return result;
  }
  if (tokenUsage) parsed.tokenUsage = tokenUsage;
  if (
    signupOverride &&
    (parsed.intentType === 'unknown' ||
      parsed.confidence < CLASSIFIER_CONFIDENCE_THRESHOLD ||
      parsed.intentType !== 'create_customer' ||
      (parsed.intentType === 'create_customer' &&
        parsed.confidence < SIGNUP_INTENT_ACT_THRESHOLD))
  ) {
    const overridden: IntentClassification = {
      intentType: 'create_customer',
      confidence: Math.max(0.85, parsed.confidence),
      reasoning: 'sign-up phrasing matched deterministic pattern',
      extractedEntities: parsed.extractedEntities,
    };
    if (tokenUsage) overridden.tokenUsage = tokenUsage;
    return overridden;
  }

  // Final guardrail: low confidence → unknown, even if the LLM picked an intent.
  // We keep the original intent and confidence in the result so the router
  // can emit a clarification proposal that offers the low-confidence intent
  // as a suggestion ("did you mean: create invoice?") instead of dropping.
  if (parsed.confidence < CLASSIFIER_CONFIDENCE_THRESHOLD) {
    const lowConf: IntentClassification = {
      intentType: 'unknown',
      confidence: parsed.confidence,
      reasoning:
        parsed.reasoning ??
        `confidence ${parsed.confidence.toFixed(2)} below threshold (intent: ${parsed.intentType})`,
      extractedEntities: parsed.extractedEntities,
      unknownReason: 'low_confidence',
      lowConfidenceIntent:
        parsed.intentType !== 'unknown' ? parsed.intentType : undefined,
    };
    if (tokenUsage) lowConf.tokenUsage = tokenUsage;
    return lowConf;
  }

  // Classifier picked 'unknown' at adequate confidence — nothing to route.
  // The router will emit a clarification so the operator is never left
  // wondering whether their command was heard.
  if (parsed.intentType === 'unknown') {
    return {
      ...parsed,
      unknownReason: 'unknown_intent',
    };
  }

  return parsed;
}

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
  // P11-002: caller asks to switch the call language ("english please" /
  // "hablo español"). The adapter consumes this as a signal to flip the
  // session language — it is NOT a proposal-driving intent.
  | 'language_switch'
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
  'language_switch',
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
}

/**
 * Below this threshold the classifier returns 'unknown' regardless of
 * the LLM's self-reported intent. Picked at 0.6 — low enough to catch
 * obvious commands, high enough to send ambiguous transcripts to
 * clarification rather than executing the wrong action.
 */
export const CLASSIFIER_CONFIDENCE_THRESHOLD = 0.6;

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
- "create_customer"     — user wants to create a NEW customer record in the CRM.
                           Trigger phrasings include "create/add/new customer".
                           Extract the customer's displayName plus any stated
                           email or phone. When only the name is given, still
                           classify as create_customer so the downstream flow
                           can ask a clarifying question — do NOT fall back
                           to "unknown" just because email/phone are missing.
                           Examples: "Create a new customer named Alex"
                                     "Add customer Acme Corp, email alex@acme.com"
                                     "New customer: Sarah, phone 555-0100"
                                     "Add a customer called Jordan Lee"
                                     "Create customer Maria Gomez at maria@gomez.co"
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

export async function classifyIntent(
  transcript: string,
  context: ClassifyContext,
  gateway: LLMGateway
): Promise<IntentClassification> {
  // Cheap short-circuit: empty / whitespace transcripts never trigger an LLM call.
  if (!transcript || transcript.trim().length === 0) {
    return unknownResult('empty transcript', 'empty_transcript');
  }

  const response = await gateway.complete({
    taskType: 'classify_intent',
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
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
  if (!parsed) {
    const result = unknownResult('could not parse classifier output', 'parse_failed');
    if (tokenUsage) result.tokenUsage = tokenUsage;
    return result;
  }
  if (tokenUsage) parsed.tokenUsage = tokenUsage;

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

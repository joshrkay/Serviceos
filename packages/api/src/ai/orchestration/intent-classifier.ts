import { LLMGateway } from '../gateway/gateway';

/**
 * Voice-to-action intent classifier.
 *
 * Takes a voice transcript, returns a structured classification that
 * the voice-action-router uses to dispatch to the right AI task.
 *
 * Phase 1 handled: create_invoice, draft_estimate, create_appointment.
 * Phase 2 adds:    update_invoice (add/remove line item).
 * Phase 3/4 intents (send_invoice, query_*) still return 'unknown'
 * today so the classifier doesn't hallucinate coverage it can't
 * actually execute.
 */

export type IntentType =
  | 'create_invoice'
  | 'draft_estimate'
  | 'create_appointment'
  | 'update_invoice'
  | 'update_estimate'
  | 'create_customer'
  | 'create_job'
  | 'reschedule_appointment'
  | 'cancel_appointment'
  | 'reassign_appointment'
  | 'add_note'
  | 'send_invoice'
  | 'record_payment'
  | 'unknown';

const SUPPORTED_INTENTS: readonly IntentType[] = [
  'create_invoice',
  'draft_estimate',
  'create_appointment',
  'update_invoice',
  'update_estimate',
  'create_customer',
  'create_job',
  'reschedule_appointment',
  'cancel_appointment',
  'reassign_appointment',
  'add_note',
  'send_invoice',
  'record_payment',
  'unknown',
] as const;

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
- "unknown"             — anything else: queries ("when is my next
                           appointment"), ambiguous transcripts, or edit
                           commands without a clear reference.

Distinctions that matter:
- "create an invoice/estimate" vs "add to invoice/estimate" — the word
  "add/remove/update" plus a reference to an EXISTING invoice or estimate
  = update_invoice or update_estimate. Any phrasing starting a NEW one
  = create_invoice or draft_estimate.
- Invoice vs estimate — the operator usually says which. When they say
  "invoice" or use an "INV-" prefix, use the invoice intent; when they say
  "estimate/quote" or "EST-", use the estimate intent. When genuinely
  ambiguous, prefer "unknown".
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
    if (
      ee.cancellationType === 'customer_request' ||
      ee.cancellationType === 'technician_unavailable' ||
      ee.cancellationType === 'scheduling_conflict' ||
      ee.cancellationType === 'other'
    ) {
      extracted.cancellationType = ee.cancellationType;
    }
    // add_note fields
    if (typeof ee.noteBody === 'string') extracted.noteBody = ee.noteBody;
    if (
      ee.noteTargetKind === 'job' ||
      ee.noteTargetKind === 'customer' ||
      ee.noteTargetKind === 'invoice' ||
      ee.noteTargetKind === 'estimate' ||
      ee.noteTargetKind === 'appointment'
    ) {
      extracted.noteTargetKind = ee.noteTargetKind;
    }
    // send_invoice fields
    if (ee.sendChannel === 'email' || ee.sendChannel === 'sms') {
      extracted.sendChannel = ee.sendChannel;
    }
    // record_payment fields
    if (
      ee.paymentMethod === 'cash' ||
      ee.paymentMethod === 'check' ||
      ee.paymentMethod === 'card' ||
      ee.paymentMethod === 'other'
    ) {
      extracted.paymentMethod = ee.paymentMethod;
    }
    if (typeof ee.paymentReference === 'string') extracted.paymentReference = ee.paymentReference;
    // create_job fields
    if (typeof ee.jobTitle === 'string') extracted.jobTitle = ee.jobTitle;
    if (Object.keys(extracted).length > 0) {
      result.extractedEntities = extracted;
    }
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

  const parsed = parseClassifierJson(response.content);
  if (!parsed) {
    return unknownResult('could not parse classifier output', 'parse_failed');
  }

  // Final guardrail: low confidence → unknown, even if the LLM picked an intent.
  // We keep the original intent and confidence in the result so the router
  // can emit a clarification proposal that offers the low-confidence intent
  // as a suggestion ("did you mean: create invoice?") instead of dropping.
  if (parsed.confidence < CLASSIFIER_CONFIDENCE_THRESHOLD) {
    return {
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

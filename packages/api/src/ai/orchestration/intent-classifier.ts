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
  | 'unknown';

const SUPPORTED_INTENTS: readonly IntentType[] = [
  'create_invoice',
  'draft_estimate',
  'create_appointment',
  'update_invoice',
  'update_estimate',
  'create_customer',
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
}

export interface IntentClassification {
  intentType: IntentType;
  confidence: number; // 0-1
  reasoning?: string;
  extractedEntities?: ExtractedEntities;
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
- "unknown"             — anything else: send commands, queries ("when is my next
                           appointment"), ambiguous transcripts, or edit commands
                           without a clear invoice/estimate reference.

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
    "phone": "<string, optional — NEW customer's phone on create_customer>"
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
    if (Object.keys(extracted).length > 0) {
      result.extractedEntities = extracted;
    }
  }

  return result;
}

function unknownResult(reason: string): IntentClassification {
  return {
    intentType: 'unknown',
    confidence: 0,
    reasoning: reason,
  };
}

export async function classifyIntent(
  transcript: string,
  _context: ClassifyContext,
  gateway: LLMGateway
): Promise<IntentClassification> {
  // Cheap short-circuit: empty / whitespace transcripts never trigger an LLM call.
  if (!transcript || transcript.trim().length === 0) {
    return unknownResult('empty transcript');
  }

  const response = await gateway.complete({
    taskType: 'classify_intent',
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: transcript },
    ],
    responseFormat: 'json',
  });

  const parsed = parseClassifierJson(response.content);
  if (!parsed) {
    return unknownResult('could not parse classifier output');
  }

  // Final guardrail: low confidence → unknown, even if the LLM picked an intent.
  if (parsed.confidence < CLASSIFIER_CONFIDENCE_THRESHOLD) {
    return {
      intentType: 'unknown',
      confidence: parsed.confidence,
      reasoning:
        parsed.reasoning ?? `confidence ${parsed.confidence.toFixed(2)} below threshold`,
      extractedEntities: parsed.extractedEntities,
    };
  }

  return parsed;
}

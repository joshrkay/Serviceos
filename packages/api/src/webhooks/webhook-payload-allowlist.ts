/**
 * U7-05+ — what a `webhook_events` receipt may keep.
 *
 * `webhook_events` is a global, never-pruned table (no tenant_id, no RLS)
 * whose job is dedup: the (source, idempotency_key) unique index and the
 * status columns. Writers used to store the provider's whole body as
 * `payload`: Stripe's `event.data` (checkout `customer_details`, charge
 * `billing_details`, dispute evidence, Connect `individual`), Clerk's user
 * (staff names, emails, phones, sign-up IP), Twilio's form (From, To, Body,
 * MediaUrlN, caller city), SendGrid's batch (recipient email, bounce text) and
 * the Vapi caller's number. Nothing needs those afterwards: every route acts on
 * the request it is handling, and a redelivery carries the provider's body
 * again. So each source keeps an allowlist: the keys some reader of the stored
 * payload uses, plus the ids, types, amounts and statuses that make a receipt
 * debuggable.
 *
 * Readers of `webhook_events.payload` (the complete list):
 *   - workers/money-reconciliation.ts (L5), Stripe `checkout.session.completed`:
 *     object.amount_total, object.payment_intent (an id, or an expanded
 *     object's id), object.payment_status and object.metadata.{tenant_id,
 *     invoice_id, deposit_for_job_id}.
 *   - Nothing else. The repositories map the column, but their callers read
 *     only the row's existence, id, status, processed_at and created_at
 *     (handleWebhookEvent's dedup and retry claim, the Twilio/Vapi/LSA
 *     processed short-circuit, the voicemail receipt lookup, the one-tap
 *     nonce `inserted` flag).
 *
 * The same function backs the writers (both Pg repositories and their
 * in-memory twins) and the one-time backfill of legacy rows
 * (webhook-payload-backfill.ts), so a backfilled row and a new row have the
 * same shape. It is idempotent: minimizing a minimized payload returns it
 * unchanged. A source with no policy throws (`UnclassifiedWebhookSourceError`)
 * instead of storing an unreviewed body; a new receipt writer adds its policy
 * here (test/webhooks/webhook-payload-allowlist.test.ts checks every writer).
 */

export type WebhookPayload = Record<string, unknown>;

export class UnclassifiedWebhookSourceError extends Error {
  constructor(public readonly source: string) {
    super(
      `no webhook_events payload policy for source '${source}': add one to ` +
        'webhooks/webhook-payload-allowlist.ts (U7-05+) before storing its receipts',
    );
    this.name = 'UnclassifiedWebhookSourceError';
  }
}

type Scalar = string | number | boolean | null;

function isScalar(v: unknown): v is Scalar {
  return v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && !Buffer.isBuffer(v);
}

/** The scalar values of `keys` that `obj` holds, in `keys` order. */
function pickScalars(obj: Record<string, unknown>, keys: readonly string[]): WebhookPayload {
  const out: WebhookPayload = {};
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(obj, key) && isScalar(obj[key])) out[key] = obj[key];
  }
  return out;
}

// ---------- Stripe ----------

/**
 * Metadata keys our code stamps on Stripe objects. Every one is an internal
 * id (or the `collection` enum on terminal payments); any other key, which a
 * dashboard user could type free text into, is dropped.
 */
const STRIPE_METADATA_KEYS = [
  'tenant_id',
  'invoice_id',
  'deposit_for_job_id',
  'estimate_id',
  'customer_id',
  'payment_id',
  'agreement_id',
  'plan_id',
  'collection',
] as const;

interface StripeObjectPolicy {
  /**
   * Kept when scalar. A Stripe id field Stripe expanded into an object (a
   * `customer`, `payment_intent` or `payment_method` carrying billing details)
   * keeps only `{ id }`; `metadata` keeps only STRIPE_METADATA_KEYS.
   */
  readonly keys: readonly string[];
  /** Nested objects reduced to these scalar keys (error codes, never messages). */
  readonly nested?: Readonly<Record<string, readonly string[]>>;
}

const STRIPE_ERROR_KEYS = ['code', 'decline_code', 'type'] as const;

const STRIPE_POLICIES = {
  checkout_session: {
    keys: [
      'id', 'object', 'amount_subtotal', 'amount_total', 'currency', 'created', 'expires_at',
      'livemode', 'mode', 'payment_status', 'status', 'customer', 'invoice', 'payment_intent',
      'payment_link', 'setup_intent', 'subscription', 'metadata',
    ],
  },
  payment_intent: {
    keys: [
      'id', 'object', 'amount', 'amount_capturable', 'amount_received', 'application_fee_amount',
      'canceled_at', 'cancellation_reason', 'capture_method', 'created', 'currency', 'livemode',
      'status', 'customer', 'invoice', 'latest_charge', 'on_behalf_of', 'payment_method',
      'transfer_group', 'metadata',
    ],
    nested: { last_payment_error: STRIPE_ERROR_KEYS },
  },
  charge: {
    keys: [
      'id', 'object', 'amount', 'amount_captured', 'amount_refunded', 'application_fee_amount',
      'captured', 'created', 'currency', 'disputed', 'failure_code', 'livemode', 'paid', 'refunded',
      'status', 'balance_transaction', 'customer', 'invoice', 'on_behalf_of', 'payment_intent',
      'payment_method', 'transfer_group', 'metadata',
    ],
  },
  refund: {
    keys: [
      'id', 'object', 'amount', 'created', 'currency', 'failure_reason', 'reason', 'status',
      'balance_transaction', 'charge', 'payment_intent', 'metadata',
    ],
  },
  dispute: {
    keys: [
      'id', 'object', 'amount', 'created', 'currency', 'is_charge_refundable', 'livemode', 'reason',
      'status', 'charge', 'payment_intent', 'metadata',
    ],
  },
  setup_intent: {
    keys: [
      'id', 'object', 'cancellation_reason', 'created', 'livemode', 'status', 'usage', 'customer',
      'on_behalf_of', 'payment_method', 'metadata',
    ],
    nested: { last_setup_error: STRIPE_ERROR_KEYS },
  },
  invoice: {
    keys: [
      'id', 'object', 'amount_due', 'amount_paid', 'amount_remaining', 'attempt_count', 'attempted',
      'billing_reason', 'created', 'currency', 'livemode', 'next_payment_attempt', 'paid',
      'period_end', 'period_start', 'status', 'subtotal', 'total', 'charge', 'customer',
      'payment_intent', 'subscription', 'metadata',
    ],
  },
  subscription: {
    keys: [
      'id', 'object', 'cancel_at', 'cancel_at_period_end', 'canceled_at', 'created', 'currency',
      'current_period_end', 'current_period_start', 'ended_at', 'livemode', 'status', 'trial_end',
      'trial_start', 'customer', 'latest_invoice', 'metadata',
    ],
  },
  account: {
    keys: ['id', 'object', 'type', 'created', 'charges_enabled', 'payouts_enabled', 'details_submitted'],
  },
  /** Any other event type: enough to find the object at Stripe. */
  other: { keys: ['id', 'object', 'created', 'livemode'] },
} as const satisfies Record<string, StripeObjectPolicy>;

type StripeObjectKind = keyof typeof STRIPE_POLICIES;

/**
 * The event type decides the object's shape. Families follow Stripe's event
 * names; `account.updated` is the only `account.*` event whose object is an
 * Account (`account.external_account.*` carries bank details, so it falls to
 * `other`).
 */
export function stripeObjectKind(eventType: string): StripeObjectKind {
  if (eventType.startsWith('checkout.session.')) return 'checkout_session';
  if (eventType.startsWith('payment_intent.')) return 'payment_intent';
  if (eventType.startsWith('charge.dispute.')) return 'dispute';
  if (eventType.startsWith('charge.refund.')) return 'refund';
  if (eventType.startsWith('charge.')) return 'charge';
  if (eventType.startsWith('setup_intent.')) return 'setup_intent';
  if (eventType.startsWith('invoice.')) return 'invoice';
  if (eventType.startsWith('customer.subscription.')) return 'subscription';
  if (eventType === 'account.updated') return 'account';
  return 'other';
}

function pickStripeMetadata(v: unknown): WebhookPayload | undefined {
  if (!isRecord(v)) return undefined;
  const out: WebhookPayload = {};
  for (const key of STRIPE_METADATA_KEYS) {
    if (typeof v[key] === 'string') out[key] = v[key];
  }
  return out;
}

function pickStripeObject(obj: Record<string, unknown>, policy: StripeObjectPolicy): WebhookPayload {
  const out: WebhookPayload = {};
  for (const key of policy.keys) {
    if (!Object.prototype.hasOwnProperty.call(obj, key)) continue;
    const v = obj[key];
    if (key === 'metadata') {
      const metadata = pickStripeMetadata(v);
      if (metadata) out.metadata = metadata;
    } else if (isScalar(v)) {
      out[key] = v;
    } else if (isRecord(v) && typeof v.id === 'string') {
      out[key] = { id: v.id };
    }
  }
  for (const [key, subKeys] of Object.entries(policy.nested ?? {})) {
    const v = obj[key];
    if (v === null) out[key] = null;
    else if (isRecord(v)) out[key] = pickScalars(v, subKeys);
  }
  return out;
}

/**
 * The Stripe route stores `event.data` (`{ object, previous_attributes? }`);
 * the reconciliation reads `payload->'object'`, so the shape stays
 * `{ object }`. `previous_attributes` is dropped: it echoes changed fields,
 * personal ones included.
 */
function minimizeStripe(eventType: string, payload: Record<string, unknown>): WebhookPayload {
  const object = payload.object;
  if (!isRecord(object)) return {};
  return { object: pickStripeObject(object, STRIPE_POLICIES[stripeObjectKind(eventType)]) };
}

// ---------- Clerk (staff PII) ----------

const CLERK_ENVELOPE_KEYS = ['type', 'object', 'timestamp', 'instance_id'] as const;
const CLERK_DATA_KEYS = ['id', 'object', 'deleted', 'created_at', 'updated_at'] as const;

/**
 * Clerk users are staff, not customers, but their names, email addresses,
 * phone numbers, OAuth profiles, metadata and the sign-up request's IP and
 * user agent (`event_attributes`) are personal data all the same, and no
 * reader needs them: the route reads them from the request.
 */
function minimizeClerk(payload: Record<string, unknown>): WebhookPayload {
  const out = pickScalars(payload, CLERK_ENVELOPE_KEYS);
  if (isRecord(payload.data)) out.data = pickScalars(payload.data, CLERK_DATA_KEYS);
  return out;
}

// ---------- Twilio ----------

/**
 * SIDs, statuses and counts from Twilio's voice, messaging and status
 * callbacks. Dropped: From, To, Caller, Called, CallerName, every *City /
 * *State / *Zip / *Country, Body, MediaUrlN / MediaContentTypeN, Digits,
 * SpeechResult, ForwardedFrom, StirVerstat and anything unlisted.
 */
const TWILIO_KEYS = [
  'AccountSid', 'ApiVersion', 'MessageSid', 'SmsSid', 'SmsMessageSid', 'MessagingServiceSid',
  'MessageStatus', 'SmsStatus', 'NumMedia', 'NumSegments', 'ErrorCode', 'CallSid', 'ParentCallSid',
  'CallStatus', 'CallDuration', 'Direction', 'SequenceNumber', 'Timestamp', 'CallbackSource',
] as const;

// ---------- SendGrid ----------

const SENDGRID_EVENT_KEYS = ['sg_event_id', 'sg_message_id', 'event', 'timestamp'] as const;

/**
 * The batch as an array. Accepts the parsed JSON the route now passes, and
 * the legacy shapes the backfill meets: the route used to store the raw-mounted
 * request Buffer, which JSON-serialized to `{ type: 'Buffer', data: [bytes] }`.
 */
function sendGridEvents(events: unknown): unknown[] {
  let v = events;
  if (Buffer.isBuffer(v)) v = parseJson(v.toString('utf8'));
  else if (isRecord(v) && v.type === 'Buffer' && Array.isArray(v.data) && v.data.every((n) => typeof n === 'number')) {
    v = parseJson(Buffer.from(v.data as number[]).toString('utf8'));
  }
  if (Array.isArray(v)) return v;
  return isRecord(v) ? [v] : [];
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Recipient email, bounce `reason`, `ip`, `useragent`, `url`, categories and custom args are dropped. */
function minimizeSendGrid(payload: Record<string, unknown>): WebhookPayload {
  return {
    events: sendGridEvents(payload.events)
      .filter(isRecord)
      .map((e) => pickScalars(e, SENDGRID_EVENT_KEYS)),
  };
}

// ---------- registry ----------

type Minimizer = (eventType: string, payload: Record<string, unknown>) => WebhookPayload;

const keep =
  (keys: readonly string[]): Minimizer =>
  (_eventType, payload) =>
    pickScalars(payload, keys);

/**
 * One policy per `webhook_events.source`. The id-only sources (LSA, the
 * voicemail legs, the one-tap nonces) already wrote ids; their policy pins
 * that. `vapi` once stored the caller's `fromE164`. The orphaned-copy record
 * keeps the Twilio recording URL: deleting the copy later needs it, and it
 * carries only the account and recording SIDs.
 */
const POLICIES: Readonly<Record<string, Minimizer>> = {
  stripe: minimizeStripe,
  clerk: (_eventType, payload) => minimizeClerk(payload),
  twilio: keep(TWILIO_KEYS),
  sendgrid: (_eventType, payload) => minimizeSendGrid(payload),
  vapi: keep(['tenantId', 'callId']),
  lsa: keep(['tenantId', 'leadId']),
  twilio_voicemail_lead: keep(['callSid', 'recordingSid']),
  twilio_voicemail_transcription: keep(['callSid', 'recordingSid', 'voiceRecordingId']),
  twilio_voicemail_orphaned_copy: keep(['tenantId', 'callSid', 'recordingSid', 'recordingUrl', 'reason']),
  one_tap_approve: keep([]),
  one_tap_undo: keep([]),
};

/** The sources a receipt may be written for. */
export const WEBHOOK_RECEIPT_SOURCES: readonly string[] = Object.keys(POLICIES);

export function hasWebhookPayloadPolicy(source: string): boolean {
  return Object.prototype.hasOwnProperty.call(POLICIES, source);
}

/**
 * The payload to store for one receipt. Throws UnclassifiedWebhookSourceError
 * for a source with no policy. A non-object payload minimizes to the policy's
 * empty shape.
 */
export function minimizeWebhookPayload(source: string, eventType: string, payload: unknown): WebhookPayload {
  if (!hasWebhookPayloadPolicy(source)) throw new UnclassifiedWebhookSourceError(source);
  return POLICIES[source](eventType, isRecord(payload) ? payload : {});
}

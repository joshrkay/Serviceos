/**
 * Owner→customer click-to-call. Creates a Twilio call to the owner's callback
 * number, then a signed TwiML callback (routes/calls.ts `/bridge`) <Dial>s the
 * customer with the business caller-ID — so the customer never sees the owner's
 * personal number, and the call is logged on the customer's conversation
 * timeline. Mirrors the SMS REST fetch+basic-auth pattern of
 * per-tenant-twilio-delivery-provider.ts; no Twilio SDK call object.
 *
 * The owner's number is collected on-device and passed as `agentPhone`; there
 * is no users.phone column. DNC is enforced exactly as it is for SMS.
 */
import { AuditRepository, createAuditEvent } from '../audit/audit';
import { DncRepository, normalizePhone } from '../compliance/dnc';
import type { CustomerRepository } from '../customers/customer';
import {
  ConversationRepository,
  getOrCreateCustomerConversation,
  type Message,
} from '../conversations/conversation-service';
import type { TenantTwilioCreds } from '../integrations/credentials';

export type OutboundCallErrorCode =
  | 'not_found'
  | 'no_recipient'
  | 'dnc_blocked'
  | 'not_configured'
  | 'provider_failed';

export class OutboundCallError extends Error {
  constructor(
    public readonly code: OutboundCallErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'OutboundCallError';
  }
}

export interface OutboundCallDeps {
  customerRepo: Pick<CustomerRepository, 'findById'>;
  conversationRepo: ConversationRepository;
  dncRepo: Pick<DncRepository, 'isOnDnc'>;
  auditRepo?: AuditRepository;
  /** Resolves the tenant's Twilio creds (e.g. getTenantTwilioCreds(tid, pool)). */
  getCreds: (tenantId: string) => Promise<TenantTwilioCreds>;
  /** Public base URL Twilio calls back to for the bridge TwiML (PUBLIC_API_URL). */
  publicApiUrl: string;
  /** Injectable for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Override Twilio REST host for tests. */
  apiBaseUrl?: string;
}

export interface InitiateOutboundCallInput {
  tenantId: string;
  customerId: string;
  agentPhone: string;
  actorId: string;
  actorRole: string;
}

export interface InitiateOutboundCallResult {
  callSid: string;
  status: string;
  messageId: string;
  conversationId: string;
}

interface TwilioCallResponse {
  sid: string;
  status: string;
  error_code?: number;
  error_message?: string;
}

/** Last-4 only — never log a full customer number. */
function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  return digits.length >= 4 ? `•••${digits.slice(-4)}` : phone;
}

async function markFailed(
  deps: OutboundCallDeps,
  tenantId: string,
  message: Message,
  error: string,
): Promise<void> {
  try {
    await deps.conversationRepo.updateMessageMetadata(tenantId, message.id, {
      ...(message.metadata ?? {}),
      status: 'failed',
      error,
    });
  } catch {
    // Best-effort: the call already failed; don't mask that with a log-write error.
  }
}

export async function initiateOutboundCall(
  deps: OutboundCallDeps,
  input: InitiateOutboundCallInput,
): Promise<InitiateOutboundCallResult> {
  const customer = await deps.customerRepo.findById(input.tenantId, input.customerId);
  if (!customer) throw new OutboundCallError('not_found', 'Customer not found');
  const customerPhone = customer.primaryPhone?.trim();
  if (!customerPhone) throw new OutboundCallError('no_recipient', 'Customer has no phone number on file');

  if (await deps.dncRepo.isOnDnc(input.tenantId, normalizePhone(customerPhone))) {
    throw new OutboundCallError('dnc_blocked', 'This customer has opted out of contact');
  }

  let creds: TenantTwilioCreds;
  try {
    creds = await deps.getCreds(input.tenantId);
  } catch {
    throw new OutboundCallError('not_configured', 'Calling is not configured for this account');
  }
  const businessNumber = creds.phoneE164;
  if (!creds.accountSid || !creds.authToken || !businessNumber) {
    throw new OutboundCallError('not_configured', 'Calling is not configured for this account');
  }

  // Log the call on the customer's thread (drives GET /customers/:id/timeline).
  const { conversation } = await getOrCreateCustomerConversation(
    deps.conversationRepo,
    {
      tenantId: input.tenantId,
      customerId: input.customerId,
      createdBy: input.actorId,
      actorRole: input.actorRole,
    },
    deps.auditRepo,
  );
  const message = await deps.conversationRepo.addMessage({
    tenantId: input.tenantId,
    conversationId: conversation.id,
    messageType: 'system_event',
    content: `Outbound call to ${maskPhone(customerPhone)}`,
    senderId: input.actorId,
    senderRole: input.actorRole,
    source: 'outbound_call',
    metadata: {
      direction: 'outbound',
      channel: 'call',
      status: 'initiating',
      target: customerPhone,
      callerId: businessNumber,
    },
  });

  const apiBaseUrl = deps.apiBaseUrl ?? 'https://api.twilio.com/2010-04-01';
  const bridgeUrl =
    `${deps.publicApiUrl.replace(/\/+$/, '')}/api/calls/bridge` +
    `?tenantId=${encodeURIComponent(input.tenantId)}` +
    `&conversationId=${encodeURIComponent(conversation.id)}` +
    `&messageId=${encodeURIComponent(message.id)}`;
  const body = new URLSearchParams({
    To: input.agentPhone,
    From: businessNumber,
    Url: bridgeUrl,
    Method: 'POST',
  });
  const auth = Buffer.from(`${creds.accountSid}:${creds.authToken}`).toString('base64');
  const fetchImpl = deps.fetchImpl ?? fetch;

  let data: TwilioCallResponse;
  try {
    const response = await fetchImpl(`${apiBaseUrl}/Accounts/${creds.accountSid}/Calls.json`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      await markFailed(deps, input.tenantId, message, text.slice(0, 300));
      throw new OutboundCallError('provider_failed', 'Call provider failed');
    }
    data = (await response.json()) as TwilioCallResponse;
  } catch (err) {
    if (err instanceof OutboundCallError) throw err;
    await markFailed(deps, input.tenantId, message, err instanceof Error ? err.message : String(err));
    throw new OutboundCallError('provider_failed', 'Call provider failed');
  }
  if (data.error_code) {
    await markFailed(
      deps,
      input.tenantId,
      message,
      `${data.error_code} ${data.error_message ?? ''}`.trim(),
    );
    throw new OutboundCallError('provider_failed', 'Call provider rejected the call');
  }

  await deps.conversationRepo.updateMessageMetadata(input.tenantId, message.id, {
    direction: 'outbound',
    channel: 'call',
    status: 'ringing',
    target: customerPhone,
    callerId: businessNumber,
    callSid: data.sid,
  });

  if (deps.auditRepo) {
    await deps.auditRepo.create(
      createAuditEvent({
        tenantId: input.tenantId,
        actorId: input.actorId,
        actorRole: input.actorRole,
        eventType: 'call.initiated',
        entityType: 'customer',
        entityId: input.customerId,
        metadata: { callSid: data.sid, conversationId: conversation.id, messageId: message.id },
      }),
    );
  }

  return {
    callSid: data.sid,
    status: data.status,
    messageId: message.id,
    conversationId: conversation.id,
  };
}

/**
 * Build the bridge TwiML returned to Twilio when the owner answers: dial the
 * customer with the business caller-ID. Kept pure for unit testing.
 */
export function buildBridgeTwiml(args: { customerPhone: string; callerId: string }): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    `<Response><Dial callerId="${xmlEscape(args.callerId)}">` +
    `<Number>${xmlEscape(args.customerPhone)}</Number></Dial></Response>`
  );
}

/** Polite hangup when the bridge target can't be resolved. */
export function buildHangupTwiml(message = 'We could not connect your call.'): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    `<Response><Say>${xmlEscape(message)}</Say><Hangup/></Response>`
  );
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

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
import { type Logger } from '../logging/logger';
import { DncRepository, normalizePhone } from '../compliance/dnc';
import { normalizeMobileE164 } from '../shared/phone/normalize';
import type {
  OutboundConsentContext,
  OutboundConsentResult,
} from '../voice/outbound-consent';
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
  | 'consent_blocked'
  | 'not_configured'
  | 'provider_failed';

/** TCPA/DNC express-consent enforcement mode (config `TCPA_CONSENT_ENFORCEMENT`). */
export type ConsentEnforcementMode = 'off' | 'warn' | 'block';

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
  logger?: Logger;
  /**
   * TCPA/DNC express-consent enforcement mode (config `TCPA_CONSENT_ENFORCEMENT`).
   * Defaults to 'off' when absent, which preserves prior behavior exactly: only
   * the `dncRepo.isOnDnc` opt-out check runs. 'warn' and 'block' additionally
   * consult {@link checkConsent}. Off-by-default so production is unchanged
   * until an operator opts in.
   */
  consentEnforcement?: ConsentEnforcementMode;
  /**
   * Per-customer TCPA/DNC consent gate. Injected for testability; in production
   * bound to `checkOutboundConsent` over the tenant pool. Consulted ONLY when
   * `consentEnforcement` is 'warn' or 'block'. Absent ⇒ the gate is skipped
   * (equivalent to 'off'). This function must NOT emit its own audit event —
   * `initiateOutboundCall` owns the consent-decision audit so 'warn' mode
   * doesn't record a misleading "blocked" event.
   */
  checkConsent?: (ctx: OutboundConsentContext) => Promise<OutboundConsentResult>;
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

  // TCPA / DNC express-consent gate (config `TCPA_CONSENT_ENFORCEMENT`).
  // Off by default: production behaves exactly as before (the DNC opt-out check
  // above is the only gate). Only when an operator opts into 'warn' or 'block'
  // does the per-customer express-consent gate run. Runs BEFORE any Twilio call
  // or conversation write, so a block never places a call or logs a message.
  const consentMode = deps.consentEnforcement ?? 'off';
  if (consentMode !== 'off' && deps.checkConsent) {
    // The consent gate's format filter (isOutboundAllowed) requires strict
    // E.164 (`+1XXXXXXXXXX`). `customers.primaryPhone` is stored as the owner
    // typed it — a validly-stored formatted/local number ("(555) 111-2222")
    // would otherwise be refused as `malformed` in block mode. Normalize first;
    // a genuinely unparseable number falls through as-is so the gate still
    // classifies it malformed (fail-closed in block mode).
    let consentPhone = customerPhone;
    try {
      consentPhone = normalizeMobileE164(customerPhone);
    } catch {
      // Leave the raw value — isOutboundAllowed will flag it malformed and the
      // gate handles the block/warn decision, exactly as before.
    }
    const consent = await deps.checkConsent({
      tenantId: input.tenantId,
      phoneE164: consentPhone,
      actorId: input.actorId,
      actorRole: input.actorRole,
    });
    const decision = consent.allowed
      ? 'granted'
      : consentMode === 'block'
        ? 'blocked'
        : 'warned';
    if (!consent.allowed) {
      deps.logger?.warn('outbound call consent gate denied', {
        tenantId: input.tenantId,
        customerId: input.customerId,
        phone: maskPhone(customerPhone),
        reason: consent.reason,
        mode: consentMode,
        decision,
      });
    }
    // Audit every consent decision (granted/warned/blocked) per the audit
    // invariant. Only emitted when enforcement is on, so 'off' stays silent.
    if (deps.auditRepo) {
      await deps.auditRepo.create(
        createAuditEvent({
          tenantId: input.tenantId,
          actorId: input.actorId,
          actorRole: input.actorRole,
          eventType: `call.consent_${decision}`,
          entityType: 'customer',
          entityId: input.customerId,
          metadata: {
            reason: consent.reason ?? null,
            message: consent.message ?? '',
            mode: consentMode,
            decision,
          },
        }),
      );
    }
    if (!consent.allowed && consentMode === 'block') {
      throw new OutboundCallError(
        'consent_blocked',
        consent.message ?? 'Customer has not granted call consent',
      );
    }
    // 'warn' + denied → observability only; fall through and place the call.
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

  // The call is already placed at Twilio — the post-success bookkeeping below
  // must never turn a connected call into a 500. Best-effort, like markFailed.
  try {
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
  } catch (err) {
    // Swallow: the call is live; losing the status/audit write must not 500 —
    // but log it so the lost audit/status is diagnosable (audit-event invariant).
    deps.logger?.warn('outbound call post-success bookkeeping failed', {
      tenantId: input.tenantId,
      callSid: data.sid,
      messageId: message.id,
      error: err instanceof Error ? err.message : String(err),
    });
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

/**
 * Resolve the bridge target for a TwiML callback: the customer phone + business
 * caller-id stamped on the outbound-call log message. Returns null (→ hangup)
 * unless the message exists, is actually an `outbound_call` log, and carries
 * both string fields — so the bridge never dials a `target` that happens to sit
 * in some other message's metadata. Pure, so it's unit-tested without HTTP.
 */
export function resolveBridgeTarget(
  messages: Array<Pick<Message, 'id' | 'source' | 'metadata'>>,
  messageId: string,
): { customerPhone: string; callerId: string } | null {
  const msg = messages.find((m) => m.id === messageId);
  if (!msg || msg.source !== 'outbound_call') return null;
  const target = msg.metadata?.['target'];
  const callerId = msg.metadata?.['callerId'];
  if (typeof target !== 'string' || typeof callerId !== 'string') return null;
  return { customerPhone: target, callerId };
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

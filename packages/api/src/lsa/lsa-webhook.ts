/**
 * #1738 — Google Local Services Ads lead webhook handler.
 *
 * Mounted at `POST /webhooks/lsa/:tenantId` on the shared webhook base
 * (P0-014: raw-body capture, `webhook_events` receipt/markProcessed
 * idempotency, fail-closed verification). Flow:
 *
 *   1. Tenant must have an ENABLED LSA link; otherwise 403 (indistinguishable
 *      from a bad signature, so tenants cannot be probed).
 *   2. Verify, fail closed → 403. Either an HMAC header
 *      `x-lsa-signature: t=<unix>,v1=<hex>` over `<t>.<rawBody>` (replay
 *      window 300s, same scheme as the other signed webhooks), or a
 *      Google-style shared key in the body (`google_key`, constant-time
 *      compared) for senders that cannot sign.
 *   3. Dedup on (tenant, lead id) via the shared receipt store. Short-circuit
 *      only a fully-processed duplicate (VOX-04 pattern): a receipt that was
 *      never marked processed means the earlier delivery died mid-flight, so a
 *      retry must reprocess. Reprocessing is safe: captureLead dedupes on
 *      phone and `lsa_leads` is unique on (tenant, lead id).
 *   4. captureLead -> Lead (source marketplace + Google attribution) + audit.
 *   5. Speed-to-lead first response, ONLY for the delivery that inserted the
 *      `lsa_leads` row (so a replay can never double-text), only when the owner
 *      opted in (`autoRespond`), and only through the injected sender, which is
 *      the DNC-gated conversation-reply path, and only when the sender
 *      asserted `sms_consent: true` (leads carry no consent field of their own).
 *      A refusal is recorded as the outcome — consent/DNC is never bypassed.
 */
import * as crypto from 'crypto';
import type { AuditRepository } from '../audit/audit';
import { createAuditEvent } from '../audit/audit';
import { buildAttributionMetadata } from '../leads/attribution-metadata';
import type { LeadRepository } from '../leads/lead';
import { captureLead } from '../leads/lead-service';
import { sendSpeedToLeadResponse, type SpeedToLeadSender } from '../leads/speed-to-lead';
import { verifyWebhookSignature } from '../webhooks/webhook-handler';
import type { SettingsRepository } from '../settings/settings';
import type { LsaIntegrationRepository } from './lsa-integration';
import {
  isSpeedToLeadEligibleLsaType,
  lsaLeadPayloadSchema,
  type LsaLeadPayload,
  mapLsaPayloadToLeadInput,
} from './lsa-lead-mapping';

export interface LsaWebhookReceiptRepository {
  recordReceipt(
    provider: string,
    eventId: string,
    eventType: string,
    payload: Record<string, unknown>,
  ): Promise<{ inserted: boolean; record?: { processedAt?: Date | null } }>;
  markProcessed(provider: string, eventId: string): Promise<void>;
}

export interface LsaWebhookDeps {
  integrationRepo: LsaIntegrationRepository;
  leadRepo: LeadRepository;
  auditRepo: AuditRepository;
  webhookRepo: LsaWebhookReceiptRepository;
  settingsRepo: Pick<SettingsRepository, 'findByTenant'>;
  /** Consent/DNC-gated send. Absent => speed-to-lead is recorded as unavailable. */
  sendSpeedToLead?: SpeedToLeadSender;
}

export interface LsaWebhookRequest {
  tenantId: string;
  rawBody: string;
  signatureHeader?: string | null;
}

export interface LsaWebhookResult {
  status: number;
  body: Record<string, unknown>;
}

const SIGNATURE_TOLERANCE_SECONDS = 300;

function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

export function verifyLsaRequest(args: {
  rawBody: string;
  secret: string;
  signatureHeader?: string | null;
  parsedBody?: unknown;
}): boolean {
  if (!args.secret) return false;
  if (args.signatureHeader) {
    return verifyWebhookSignature(
      args.rawBody,
      args.signatureHeader,
      args.secret,
      SIGNATURE_TOLERANCE_SECONDS,
    );
  }
  const key = (args.parsedBody as { google_key?: unknown } | undefined)?.google_key;
  return typeof key === 'string' && key.length > 0 && safeEqual(key, args.secret);
}

export async function handleLsaLeadEvent(
  deps: LsaWebhookDeps,
  req: LsaWebhookRequest,
): Promise<LsaWebhookResult> {
  const forbidden: LsaWebhookResult = { status: 403, body: { error: 'FORBIDDEN' } };

  const integration = await deps.integrationRepo.get(req.tenantId);
  if (!integration || !integration.enabled) return forbidden;
  const secret = await deps.integrationRepo.getWebhookSecret(req.tenantId);
  if (!secret) return forbidden;

  let parsed: unknown;
  try {
    parsed = JSON.parse(req.rawBody);
  } catch {
    parsed = undefined;
  }
  if (!verifyLsaRequest({ rawBody: req.rawBody, secret, signatureHeader: req.signatureHeader, parsedBody: parsed })) {
    return forbidden;
  }

  if (parsed === undefined) return { status: 400, body: { error: 'INVALID_JSON' } };
  // The shared key is a credential, not lead data — strip before validation.
  const { google_key: _key, ...rest } = (parsed ?? {}) as Record<string, unknown>;
  const result = lsaLeadPayloadSchema.safeParse(rest);
  if (!result.success) {
    return { status: 400, body: { error: 'INVALID_PAYLOAD', issues: result.error.issues.map((i) => i.path.join('.')) } };
  }
  const payload = result.data;

  const eventId = `${req.tenantId}:${payload.lead_id}`;
  const receipt = await deps.webhookRepo.recordReceipt('lsa', eventId, 'lead.received', {
    tenantId: req.tenantId,
    leadId: payload.lead_id,
  });
  if (!receipt.inserted && receipt.record?.processedAt) {
    return { status: 200, body: { received: true, duplicate: true } };
  }

  const captured = await captureLead(
    mapLsaPayloadToLeadInput(req.tenantId, payload, integration.accountId),
    deps.leadRepo,
    deps.auditRepo,
  );
  const lead = captured.lead;

  const recorded = await deps.integrationRepo.recordLead({
    tenantId: req.tenantId,
    externalLeadId: payload.lead_id,
    leadId: lead.id,
    leadType: payload.lead_type,
  });

  let speedToLead: string | undefined;
  if (recorded.inserted) {
    await deps.auditRepo.create(
      createAuditEvent({
        tenantId: req.tenantId,
        actorId: 'system:lsa',
        actorRole: 'system',
        eventType: 'lsa_lead.received',
        entityType: 'lead',
        entityId: lead.id,
        metadata: {
          externalLeadId: payload.lead_id,
          leadType: payload.lead_type,
          captureOutcome: captured.outcome,
          ...buildAttributionMetadata(lead),
        },
      }),
    );

    speedToLead = await runSpeedToLead(deps, req.tenantId, integration.autoRespond, payload, lead);
    await deps.integrationRepo.setSpeedToLeadOutcome(req.tenantId, payload.lead_id, speedToLead);
  }

  await deps.webhookRepo.markProcessed('lsa', eventId);
  return {
    status: 200,
    body: {
      received: true,
      leadId: lead.id,
      outcome: captured.outcome,
      ...(speedToLead ? { speedToLead } : { duplicate: true }),
    },
  };
}

async function runSpeedToLead(
  deps: LsaWebhookDeps,
  tenantId: string,
  autoRespond: boolean,
  payload: LsaLeadPayload,
  lead: Parameters<typeof sendSpeedToLeadResponse>[1]['lead'],
): Promise<string> {
  if (!autoRespond) return 'disabled';
  if (!isSpeedToLeadEligibleLsaType(payload.lead_type)) return 'phone_lead';
  // Consent gate: Lead rows carry no SMS-consent field and the reply path only
  // enforces DNC for leads, so consent must be asserted by the sender. Never
  // inferred from the lead having contacted the business.
  if (payload.sms_consent !== true) return 'no_sms_consent';
  if (!deps.sendSpeedToLead) return 'unavailable';
  try {
    const settings = await deps.settingsRepo.findByTenant(tenantId);
    const outcome = await sendSpeedToLeadResponse(
      { send: deps.sendSpeedToLead },
      {
        lead,
        businessName: settings?.businessName ?? '',
        // The owner's LSA-scoped opt-in stands in for the (not yet owner
        // editable) tenant-wide speed_to_lead_enabled flag; the template is
        // still the tenant's own.
        settings: { speedToLeadEnabled: true, speedToLeadTemplate: settings?.speedToLeadTemplate },
      },
    );
    return outcome.reason;
  } catch (err) {
    return `send_failed:${err instanceof Error ? err.message : String(err)}`;
  }
}

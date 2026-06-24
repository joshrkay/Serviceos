/**
 * LC-2 — signed lead-intake webhook.
 *
 * A server-to-server intake surface for website form backends and partner
 * channels that can HMAC-sign their submissions. Distinct from the
 * browser-facing `/public/intake` form (unsigned + honeypot): this path
 * proves authenticity over the exact request bytes, so an integrator's form
 * relay / CRM can post leads without a logged-in session.
 *
 * Reuses the webhook base verbatim — `verifyWebhookSignature` (timing-safe
 * HMAC-SHA256 + 5-min timestamp tolerance) and `handleWebhookEvent`
 * (status-based idempotency / replay dedup) — rather than re-implementing
 * either. Payloads are validated by the shared `inboundLeadSchema`
 * (field-level errors). Duplicate-prevention runs against existing customers
 * AND open leads: a repeat phone is FLAGGED, never silently duplicated.
 *
 * Mount with `express.raw({ type: 'application/json' })` BEFORE the global
 * `express.json()` so the HMAC sees the exact signed bytes (see app.ts).
 */
import * as crypto from 'crypto';
import { Request, Router, Response } from 'express';
import { inboundLeadSchema } from '@ai-service-os/shared';
import {
  verifyWebhookSignature,
  handleWebhookEvent,
  WebhookRepository,
  InMemoryWebhookRepository,
} from '../webhooks/webhook-handler';
import { LeadRepository } from '../leads/lead';
import { createLead } from '../leads/lead-service';
import { AuditRepository, createAuditEvent } from '../audit/audit';
import { TenantRepository } from '../auth/clerk';
import { CustomerRepository } from '../customers/customer';
import {
  checkCustomerDuplicatesPg,
  isCustomerDuplicateLoader,
  normalizePhone,
  DuplicateWarning,
} from '../customers/dedup';
import { toErrorResponse } from '../shared/errors';
import { isValidTenantId } from '../db/schema';
import { createLogger } from '../logging/logger';
import { Queue } from '../queues/queue';

const logger = createLogger({
  service: 'lead-intake',
  environment: process.env.NODE_ENV || 'dev',
});

const WEBHOOK_SOURCE = 'lead_intake';
const WEBHOOK_EVENT_TYPE = 'lead.submitted';
const LEAD_INTAKE_ACTOR_ID = 'lead_intake_webhook';
const LEAD_INTAKE_ACTOR_ROLE = 'public';
/** Signature header — Stripe-style `t=<ts>,v1=<hex>` (verifyWebhookSignature). */
const SIGNATURE_HEADER = 'x-webhook-signature';
const IDEMPOTENCY_HEADER = 'x-idempotency-key';

export interface LeadIntakeRouterDeps {
  leadRepo: LeadRepository;
  tenantRepo: TenantRepository;
  auditRepo: AuditRepository;
  customerRepo: CustomerRepository;
  /** HMAC signing secret (WEBHOOK_SIGNING_SECRET). When absent, all
   *  submissions are rejected 500 — fail closed, never accept unsigned. */
  signingSecret?: string;
  /** Durable replay/idempotency store; falls back to in-memory for tests. */
  webhookRepo?: WebhookRepository;
  /** LC-3 — when wired, createLead enqueues a speed-to-lead auto-response. */
  queue?: Queue;
}

function rawBodyString(req: Request): string {
  if (Buffer.isBuffer(req.body)) return req.body.toString('utf8');
  // Defensive: the mount MUST put express.raw() before express.json().
  throw new Error(
    'Lead-intake body pre-parsed; mount /webhooks/lead-intake before express.json()',
  );
}

export function createLeadIntakeRouter(deps: LeadIntakeRouterDeps): Router {
  const router = Router();
  const webhookRepo: WebhookRepository =
    deps.webhookRepo ?? new InMemoryWebhookRepository();

  router.post('/:tenantId/leads', async (req: Request, res: Response) => {
    const tenantId = req.params.tenantId;
    let webhookEventId: string | undefined;
    try {
      if (!isValidTenantId(tenantId)) {
        res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Invalid tenantId' });
        return;
      }

      // Fail closed: never accept an unsigned submission.
      if (!deps.signingSecret) {
        logger.warn('WEBHOOK_SIGNING_SECRET not configured — rejecting lead-intake webhook');
        res.status(500).json({ error: 'Lead intake webhook not configured' });
        return;
      }

      const signature = req.headers[SIGNATURE_HEADER] as string | undefined;
      if (!signature) {
        res.status(400).json({ error: 'VALIDATION_ERROR', message: `Missing ${SIGNATURE_HEADER} header` });
        return;
      }

      const rawBody = rawBodyString(req);
      if (!verifyWebhookSignature(rawBody, signature, deps.signingSecret)) {
        logger.warn('Lead-intake signature verification failed', { tenantId });
        res.status(401).json({ error: 'UNAUTHORIZED', message: 'Invalid signature' });
        return;
      }

      let body: Record<string, unknown>;
      try {
        body = JSON.parse(rawBody) as Record<string, unknown>;
      } catch {
        res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Invalid JSON body' });
        return;
      }

      const tenant = await deps.tenantRepo.findById(tenantId);
      if (!tenant) {
        // Don't act as a tenant-existence oracle beyond the 404 the form needs.
        res.status(404).json({ error: 'NOT_FOUND', message: 'Intake form not found' });
        return;
      }

      // Field-level validation (throws ZodError → 400 via toErrorResponse).
      const parsed = inboundLeadSchema.parse(body);

      // Replay/idempotency dedup over the exact submission (or a caller-
      // supplied key). A duplicate delivery never creates a second lead.
      const idempotencyKey =
        (req.headers[IDEMPOTENCY_HEADER] as string | undefined) ??
        crypto.createHash('sha256').update(`${tenantId}.${rawBody}`).digest('hex');
      const { event: webhookEvent, duplicate } = await handleWebhookEvent(
        WEBHOOK_SOURCE,
        WEBHOOK_EVENT_TYPE,
        body,
        `${tenantId}:${idempotencyKey}`,
        webhookRepo,
      );
      webhookEventId = webhookEvent.id;
      if (duplicate) {
        res.status(200).json({ ok: true, duplicate: true });
        return;
      }

      // Lead-level duplicate-prevention: an existing OPEN lead for the same
      // normalized phone is FLAGGED, not duplicated (mirrors the partial-
      // unique index idx_leads_phone_unique_open). A converted contact who
      // comes back DOES get a fresh lead.
      if (parsed.primaryPhone) {
        const normalized = normalizePhone(parsed.primaryPhone);
        const existingLead = normalized
          ? await deps.leadRepo.findByPhoneNormalized(tenantId, normalized)
          : null;
        if (existingLead && !existingLead.convertedCustomerId) {
          await deps.auditRepo.create(
            createAuditEvent({
              tenantId,
              actorId: LEAD_INTAKE_ACTOR_ID,
              actorRole: LEAD_INTAKE_ACTOR_ROLE,
              eventType: 'lead.intake_duplicate',
              entityType: 'lead',
              entityId: existingLead.id,
              metadata: { source: parsed.source, reason: 'open_lead_same_phone' },
            }),
          );
          await webhookRepo.updateStatus(webhookEvent.id, 'processed');
          res.status(200).json({ ok: true, leadId: existingLead.id, duplicate: true });
          return;
        }
      }

      // Customer duplicate-prevention: flag (don't block) when the lead looks
      // like an existing customer, so the inbox can surface "possible match".
      let customerMatches: DuplicateWarning[] = [];
      if (isCustomerDuplicateLoader(deps.customerRepo)) {
        customerMatches = await checkCustomerDuplicatesPg(
          {
            tenantId,
            firstName: parsed.firstName,
            lastName: parsed.lastName,
            email: parsed.email,
            primaryPhone: parsed.primaryPhone,
          },
          deps.customerRepo,
        );
      }

      const lead = await createLead(
        {
          tenantId,
          firstName: parsed.firstName,
          lastName: parsed.lastName,
          companyName: parsed.companyName,
          primaryPhone: parsed.primaryPhone,
          email: parsed.email,
          source: parsed.source,
          sourceDetail: parsed.sourceDetail,
          utmSource: parsed.utmSource,
          utmMedium: parsed.utmMedium,
          utmCampaign: parsed.utmCampaign,
          attribution: parsed.attribution,
          // The verbatim submission — retained for the inbox (migration 204).
          rawPayload: parsed.rawPayload ?? body,
          // LC-3 — explicit SMS consent gates the speed-to-lead SMS reply.
          smsConsent: parsed.smsConsent,
          createdBy: LEAD_INTAKE_ACTOR_ID,
          actorRole: LEAD_INTAKE_ACTOR_ROLE,
          queue: deps.queue,
        },
        deps.leadRepo,
        deps.auditRepo,
      );

      if (customerMatches.length > 0) {
        await deps.auditRepo.create(
          createAuditEvent({
            tenantId,
            actorId: LEAD_INTAKE_ACTOR_ID,
            actorRole: LEAD_INTAKE_ACTOR_ROLE,
            eventType: 'lead.intake_customer_match',
            entityType: 'lead',
            entityId: lead.id,
            metadata: {
              matches: customerMatches.map((m) => ({
                customerId: m.existingId,
                matchType: m.matchType,
                confidence: m.confidence,
              })),
            },
          }),
        );
      }

      await webhookRepo.updateStatus(webhookEvent.id, 'processed');
      res.status(201).json({
        ok: true,
        leadId: lead.id,
        possibleCustomerMatches: customerMatches.map((m) => ({
          customerId: m.existingId,
          matchType: m.matchType,
          confidence: m.confidence,
        })),
      });
    } catch (err) {
      // Mark the webhook failed so a legit retry can reconcile (status-based
      // dedup treats 'failed' as not-duplicate).
      if (webhookEventId) {
        await webhookRepo
          .updateStatus(webhookEventId, 'failed', err instanceof Error ? err.message : 'error')
          .catch(() => {});
      }
      const { statusCode, body } = toErrorResponse(err);
      res.status(statusCode).json(body);
    }
  });

  return router;
}

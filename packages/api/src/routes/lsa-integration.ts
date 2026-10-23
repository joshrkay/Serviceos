import { Router, Response } from 'express';
import { z } from 'zod';
import type { AuthenticatedRequest } from '../auth/clerk';
import { requireAuth, requireRole, requireTenant } from '../middleware/auth';
import { toErrorResponse, ValidationError, NotFoundError } from '../shared/errors';
import { routeParam } from '../shared/route-params';
import { AuditRepository, createAuditEvent } from '../audit/audit';
import type { LeadRepository } from '../leads/lead';
import {
  LSA_DISPOSITIONS,
  type LsaIntegration,
  type LsaIntegrationRepository,
} from '../lsa/lsa-integration';
import {
  NOOP_LSA_DISPOSITION_REPORTER,
  type LsaDispositionReporter,
} from '../lsa/disposition-reporter';

/**
 * #1738 — owner-only settings for Google Local Services Ads lead intake.
 *
 *   GET    /api/lsa-integration                        — link status + recent LSA leads
 *   POST   /api/lsa-integration/link                   — link (or rotate the secret); secret shown ONCE
 *   PUT    /api/lsa-integration                        — enable/disable, speed-to-lead opt-in
 *   DELETE /api/lsa-integration                        — unlink
 *   POST   /api/lsa-integration/leads/:leadId/disposition — record booked/not_booked/spam
 *                                                        (reported to Google only when configured)
 *
 * Linking is a per-tenant webhook secret (see lsa/lsa-integration.ts); the
 * OAuth path is a documented follow-up.
 */
export interface LsaIntegrationRouteDeps {
  integrationRepo: LsaIntegrationRepository;
  leadRepo: Pick<LeadRepository, 'findById'>;
  auditRepo: AuditRepository;
  /** Public API origin the webhook URL is built from. */
  publicApiUrl?: string | undefined;
  /** No-op unless the LSA_DISPOSITION_REPORTING_ENABLED flag + a client are wired. */
  dispositionReporter?: LsaDispositionReporter | undefined;
  /** False => POST /link answers 503 (no TENANT_ENCRYPTION_KEY to protect the secret). */
  canStoreSecrets?: boolean | undefined;
}

const RECENT_LIMIT = 20;

const linkSchema = z.object({ accountId: z.string().trim().max(64).optional() });
const updateSchema = z
  .object({
    enabled: z.boolean().optional(),
    autoRespond: z.boolean().optional(),
    accountId: z.string().trim().max(64).nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'No changes supplied' });
const dispositionSchema = z.object({ disposition: z.enum(LSA_DISPOSITIONS) });

function view(i: LsaIntegration, deps: LsaIntegrationRouteDeps, tenantId: string) {
  return {
    enabled: i.enabled,
    autoRespond: i.autoRespond,
    secretHint: i.secretHint,
    accountId: i.accountId ?? null,
    webhookUrl: deps.publicApiUrl ? `${deps.publicApiUrl.replace(/\/$/, '')}/webhooks/lsa/${tenantId}` : null,
    linkedAt: i.createdAt.toISOString(),
    updatedAt: i.updatedAt.toISOString(),
  };
}

export function createLsaIntegrationRouter(deps: LsaIntegrationRouteDeps): Router {
  const router = Router();
  const reporter = deps.dispositionReporter ?? NOOP_LSA_DISPOSITION_REPORTER;
  const guard = [requireAuth, requireTenant, requireRole('owner')];

  async function audit(
    req: AuthenticatedRequest,
    eventType: string,
    entityType: string,
    entityId: string,
    metadata: Record<string, unknown>,
  ) {
    await deps.auditRepo.create(
      createAuditEvent({
        tenantId: req.auth!.tenantId,
        actorId: req.auth!.userId,
        actorRole: req.auth!.role,
        eventType,
        entityType,
        entityId,
        metadata,
      }),
    );
  }

  router.get('/', ...guard, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const tenantId = req.auth!.tenantId;
      const integration = await deps.integrationRepo.get(tenantId);
      if (!integration) {
        res.json({ data: null });
        return;
      }
      const recent = await deps.integrationRepo.listRecent(tenantId, RECENT_LIMIT);
      const leads = await Promise.all(
        recent.map(async (r) => {
          const lead = await deps.leadRepo.findById(tenantId, r.leadId);
          const name = lead
            ? [lead.firstName, lead.lastName].filter(Boolean).join(' ') || lead.companyName || null
            : null;
          return {
            leadId: r.leadId,
            name,
            stage: lead?.stage ?? null,
            leadType: r.leadType,
            receivedAt: r.receivedAt.toISOString(),
            speedToLead: r.speedToLeadOutcome ?? null,
            disposition: r.disposition ?? null,
            dispositionReported: Boolean(r.dispositionReportedAt),
          };
        }),
      );
      res.json({ data: { ...view(integration, deps, tenantId), recentLeads: leads } });
    } catch (err) {
      const { statusCode, body } = toErrorResponse(err);
      res.status(statusCode).json(body);
    }
  });

  router.post('/link', ...guard, async (req: AuthenticatedRequest, res: Response) => {
    try {
      if (deps.canStoreSecrets === false) {
        res.status(503).json({ error: 'UNAVAILABLE', message: 'Lead intake is not configured on this server' });
        return;
      }
      const parsed = linkSchema.safeParse(req.body ?? {});
      if (!parsed.success) throw new ValidationError('Invalid request');
      const tenantId = req.auth!.tenantId;
      const existed = Boolean(await deps.integrationRepo.get(tenantId));
      const { integration, webhookSecret } = await deps.integrationRepo.link({
        tenantId,
        linkedBy: req.auth!.userId,
        ...(parsed.data.accountId ? { accountId: parsed.data.accountId } : {}),
      });
      await audit(req, existed ? 'lsa_integration.secret_rotated' : 'lsa_integration.linked', 'lsa_integration', tenantId, {
        secretHint: integration.secretHint,
      });
      // The secret is returned exactly once; only a hint is ever readable again.
      res.status(201).json({ data: { ...view(integration, deps, tenantId), webhookSecret } });
    } catch (err) {
      const { statusCode, body } = toErrorResponse(err);
      res.status(statusCode).json(body);
    }
  });

  router.put('/', ...guard, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const parsed = updateSchema.safeParse(req.body ?? {});
      if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid request');
      const tenantId = req.auth!.tenantId;
      const updated = await deps.integrationRepo.update(tenantId, parsed.data);
      if (!updated) throw new NotFoundError('LSA integration', tenantId);
      await audit(req, 'lsa_integration.updated', 'lsa_integration', tenantId, { ...parsed.data });
      res.json({ data: view(updated, deps, tenantId) });
    } catch (err) {
      const { statusCode, body } = toErrorResponse(err);
      res.status(statusCode).json(body);
    }
  });

  router.delete('/', ...guard, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const tenantId = req.auth!.tenantId;
      const ok = await deps.integrationRepo.unlink(tenantId);
      if (!ok) throw new NotFoundError('LSA integration', tenantId);
      await audit(req, 'lsa_integration.unlinked', 'lsa_integration', tenantId, {});
      res.json({ unlinked: true });
    } catch (err) {
      const { statusCode, body } = toErrorResponse(err);
      res.status(statusCode).json(body);
    }
  });

  router.post('/leads/:leadId/disposition', ...guard, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const parsed = dispositionSchema.safeParse(req.body ?? {});
      if (!parsed.success) throw new ValidationError('disposition must be booked, not_booked or spam');
      const tenantId = req.auth!.tenantId;
      const leadId = routeParam(req, 'leadId');
      const rec = await deps.integrationRepo.findLeadByLeadId(tenantId, leadId);
      if (!rec) throw new NotFoundError('LSA lead', leadId);

      let reported = false;
      try {
        reported = (
          await reporter.report({
            tenantId,
            externalLeadId: rec.externalLeadId,
            disposition: parsed.data.disposition,
          })
        ).reported;
      } catch {
        // Report-back is best-effort and optional; the local disposition still stands.
      }
      await deps.integrationRepo.markDisposition(tenantId, rec.externalLeadId, parsed.data.disposition, reported);
      await audit(req, 'lsa_lead.disposition_recorded', 'lead', leadId, {
        disposition: parsed.data.disposition,
        reportedToGoogle: reported,
      });
      res.json({ data: { leadId, disposition: parsed.data.disposition, reportedToGoogle: reported } });
    } catch (err) {
      const { statusCode, body } = toErrorResponse(err);
      res.status(statusCode).json(body);
    }
  });

  return router;
}

/**
 * Customer-portal public lead intake — P12-005.
 *
 * Distinct from `public-intake.ts` (anonymous marketing landing pages):
 * this route serves the authenticated customer self-serve portal where
 * an existing customer requests a new service ("request-service").
 * Such leads are now first-class `source='customer_portal'` rather than
 * the prior `'web_form' + sourceDetail='Customer Portal'` workaround.
 *
 * The route is intentionally thin and exported for direct unit testing.
 * Mount wiring lives in app.ts (out of scope for P12-005 — not listed in
 * the story's allowed files). This module is import-safe regardless.
 */
import { Request, Router, Response } from 'express';
import { z } from 'zod';
import { toErrorResponse } from '../shared/errors';
import { LeadRepository } from '../leads/lead';
import { createLead } from '../leads/lead-service';
import { AuditRepository } from '../audit/audit';
import { TenantRepository } from '../auth/clerk';
import { attributionSchema, LeadSource } from '../leads/enums';

// First-class source for the customer portal.
export const CUSTOMER_PORTAL_SOURCE: LeadSource = 'customer_portal';
const PORTAL_ACTOR_ID = 'customer_portal';
const PORTAL_ACTOR_ROLE = 'customer';

const requestServiceSchema = z.object({
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().max(100).optional(),
  primaryPhone: z.string().trim().min(7).max(40).optional(),
  email: z.string().trim().email().max(200).optional(),
  serviceType: z.string().trim().max(100).optional(),
  description: z.string().trim().max(5000).optional(),
  preferredDates: z.string().trim().max(200).optional(),
  address: z.string().trim().max(500).optional(),
  utmSource: z.string().trim().max(200).optional(),
  utmMedium: z.string().trim().max(200).optional(),
  utmCampaign: z.string().trim().max(200).optional(),
  attribution: attributionSchema.optional(),
}).refine(
  (v) => Boolean(v.primaryPhone || v.email),
  { message: 'A primaryPhone or email is required so we can reach you' }
);

const TENANT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function buildSourceDetail(p: z.infer<typeof requestServiceSchema>): string | undefined {
  const parts: string[] = [];
  if (p.serviceType) parts.push(`Service: ${p.serviceType}`);
  if (p.preferredDates) parts.push(`Preferred: ${p.preferredDates}`);
  if (p.address) parts.push(`Address: ${p.address}`);
  if (p.description) parts.push(`Description: ${p.description}`);
  if (parts.length === 0) return undefined;
  const joined = parts.join(' | ');
  return joined.length > 500 ? joined.slice(0, 497) + '...' : joined;
}

export function createPublicPortalRouter(
  leadRepo: LeadRepository,
  tenantRepo: TenantRepository,
  auditRepo: AuditRepository,
): Router {
  const router = Router();

  router.post('/:tenantId/request-service', async (req: Request, res: Response) => {
    try {
      const tenantId = req.params.tenantId;
      if (!TENANT_UUID.test(tenantId)) {
        res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Invalid tenantId' });
        return;
      }

      const tenant = await tenantRepo.findById(tenantId);
      if (!tenant) {
        res.status(404).json({ error: 'NOT_FOUND', message: 'Portal not found' });
        return;
      }

      const parsed = requestServiceSchema.parse(req.body ?? {});

      const lead = await createLead(
        {
          tenantId,
          firstName: parsed.firstName,
          lastName: parsed.lastName,
          companyName: undefined,
          primaryPhone: parsed.primaryPhone,
          email: parsed.email,
          // P12-005 — first-class portal source. The prior workaround
          // (`source='web_form'` + `sourceDetail='Customer Portal'`) is
          // retired in favor of this dedicated value.
          source: CUSTOMER_PORTAL_SOURCE,
          sourceDetail: buildSourceDetail(parsed),
          utmSource: parsed.utmSource,
          utmMedium: parsed.utmMedium,
          utmCampaign: parsed.utmCampaign,
          attribution: parsed.attribution,
          createdBy: PORTAL_ACTOR_ID,
          actorRole: PORTAL_ACTOR_ROLE,
        },
        leadRepo,
        auditRepo
      );

      res.status(201).json({ ok: true, leadId: lead.id });
    } catch (err) {
      const { statusCode, body } = toErrorResponse(err);
      res.status(statusCode).json(body);
    }
  });

  return router;
}

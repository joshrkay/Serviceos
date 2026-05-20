/**
 * Public lead-intake endpoint — no auth, tenant identified by UUID in path.
 *
 * The tenant id sits in the URL because intake forms are shareable links
 * (and embedded in marketing landing pages); a JWT requires login. We
 * prefer the UUID over a slug for now to avoid an extra column on the
 * tenants table — marketers can route through their own short URLs.
 *
 * Defenses:
 *   - Honeypot field `_company_url`: bots fill all fields, humans don't
 *     touch the visually-hidden one. Requests with the field set return
 *     200 OK but never write a row, so the bot thinks it succeeded.
 *   - Rate limit: applied at the mount point in app.ts via
 *     express-rate-limit (the existing `/public` limiter wraps this
 *     route too; the mount adds a tighter intake-specific bucket).
 *   - Server stamps `source` and `createdBy` so the API caller cannot
 *     forge attribution or impersonate an internal user.
 */
import { Request, Router, Response } from 'express';
import type { Pool } from 'pg';
import { z } from 'zod';
import { toErrorResponse } from '../shared/errors';
import { LeadRepository } from '../leads/lead';
import { createLead } from '../leads/lead-service';
import { AuditRepository } from '../audit/audit';
import { TenantRepository } from '../auth/clerk';
import { attributionSchema, LeadSource } from '../leads/enums';
import { SettingsRepository } from '../settings/settings';
import { VerticalPackRegistry } from '../shared/vertical-pack-registry';
import { formatBusinessHoursSummary } from '../public-intake/format-business-hours';
import { isValidVerticalType } from '../shared/vertical-types';

const PUBLIC_INTAKE_SOURCE: LeadSource = 'web_form';
const PUBLIC_INTAKE_ACTOR_ID = 'public_intake';
const PUBLIC_INTAKE_ACTOR_ROLE = 'public';

const intakeSchema = z.object({
  // Name + at least one contact channel are required by the lead model.
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().max(100).optional(),
  primaryPhone: z.string().trim().min(7).max(40).optional(),
  email: z.string().trim().email().max(200).optional(),
  // Free-form intake context — service type, urgency, problem description,
  // address, preferred dates — collapses into a single sourceDetail blob
  // so we don't need new columns for fields we only display, never query.
  serviceType: z.string().trim().max(100).optional(),
  urgency: z.string().trim().max(40).optional(),
  description: z.string().trim().max(5000).optional(),
  preferredDates: z.string().trim().max(200).optional(),
  address: z.string().trim().max(500).optional(),
  utmSource: z.string().trim().max(200).optional(),
  utmMedium: z.string().trim().max(200).optional(),
  utmCampaign: z.string().trim().max(200).optional(),
  attribution: attributionSchema.optional(),
  // Honeypot — must be empty/absent. Real users never fill this; bots do.
  _company_url: z.string().max(500).optional(),
}).refine(
  (v) => Boolean(v.primaryPhone || v.email),
  { message: 'A primaryPhone or email is required so we can reach you' }
);

const TENANT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function buildSourceDetail(p: z.infer<typeof intakeSchema>): string | undefined {
  const parts: string[] = [];
  if (p.serviceType) parts.push(`Service: ${p.serviceType}`);
  if (p.urgency) parts.push(`Urgency: ${p.urgency}`);
  if (p.preferredDates) parts.push(`Preferred: ${p.preferredDates}`);
  if (p.address) parts.push(`Address: ${p.address}`);
  if (p.description) parts.push(`Description: ${p.description}`);
  if (parts.length === 0) return undefined;
  // Lead.sourceDetail is capped at 500 chars by createLeadSchema.
  const joined = parts.join(' | ');
  return joined.length > 500 ? joined.slice(0, 497) + '...' : joined;
}

export function createPublicIntakeRouter(
  leadRepo: LeadRepository,
  tenantRepo: TenantRepository,
  auditRepo: AuditRepository,
  settingsRepo: SettingsRepository,
  packRegistry: VerticalPackRegistry,
  pool?: Pool,
): Router {
  const router = Router();

  router.post('/:tenantId/leads', async (req: Request, res: Response) => {
    try {
      const tenantId = req.params.tenantId;
      if (!TENANT_UUID.test(tenantId)) {
        res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Invalid tenantId' });
        return;
      }

      const tenant = await tenantRepo.findById(tenantId);
      if (!tenant) {
        // Don't differentiate "tenant doesn't exist" vs other validation
        // failures to avoid acting as a tenant-existence oracle.
        res.status(404).json({ error: 'NOT_FOUND', message: 'Intake form not found' });
        return;
      }

      const parsed = intakeSchema.parse(req.body ?? {});

      // Honeypot tripped — return 200 so bots think it worked, but never
      // write the row.
      if (parsed._company_url && parsed._company_url.trim().length > 0) {
        res.status(200).json({ ok: true });
        return;
      }

      const lead = await createLead(
        {
          tenantId,
          firstName: parsed.firstName,
          lastName: parsed.lastName,
          companyName: undefined,
          primaryPhone: parsed.primaryPhone,
          email: parsed.email,
          source: PUBLIC_INTAKE_SOURCE,
          sourceDetail: buildSourceDetail(parsed),
          utmSource: parsed.utmSource,
          utmMedium: parsed.utmMedium,
          utmCampaign: parsed.utmCampaign,
          attribution: parsed.attribution,
          createdBy: PUBLIC_INTAKE_ACTOR_ID,
          actorRole: PUBLIC_INTAKE_ACTOR_ROLE,
        },
        leadRepo,
        auditRepo
      );

      // Don't echo the full lead back — public callers don't need ids.
      res.status(201).json({ ok: true, leadId: lead.id });
    } catch (err) {
      const { statusCode, body } = toErrorResponse(err);
      res.status(statusCode).json(body);
    }
  });

  // Public tenant info for the intake form header + service-type list.
  // Read-only; same UUID-in-path validation and rate limiting as the POST.
  router.get('/:tenantId', async (req: Request, res: Response) => {
    try {
      const tenantId = req.params.tenantId;
      if (!TENANT_UUID.test(tenantId)) {
        res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Invalid tenantId' });
        return;
      }

      const tenant = await tenantRepo.findById(tenantId);
      if (!tenant) {
        res.status(404).json({ error: 'NOT_FOUND', message: 'Intake form not found' });
        return;
      }

      const settings = await settingsRepo.findByTenant(tenantId);

      const serviceTypes: { verticalType: string; displayName: string }[] = [];
      const seenVerticals = new Set<string>();
      for (const packId of settings?.activeVerticalPacks ?? []) {
        let pack = await packRegistry.getByPackId(packId);
        if (!pack && isValidVerticalType(packId)) {
          const candidates = await packRegistry.findByVertical(packId);
          pack =
            candidates
              .filter((p) => p.status === 'active')
              .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())[0] ?? null;
        }
        if (pack && !seenVerticals.has(pack.verticalType)) {
          seenVerticals.add(pack.verticalType);
          serviceTypes.push({
            verticalType: pack.verticalType,
            displayName: pack.displayName,
          });
        }
      }

      let businessHours: unknown = null;
      if (pool) {
        const tsRow = await pool.query<{ business_hours: unknown }>(
          `SELECT business_hours FROM tenant_settings WHERE tenant_id=$1`,
          [tenantId],
        );
        businessHours = tsRow.rows[0]?.business_hours ?? null;
      }

      res.status(200).json({
        businessName: settings?.businessName ?? tenant.name,
        businessPhone: settings?.businessPhone ?? null,
        serviceTypes,
        businessHoursSummary: formatBusinessHoursSummary(
          businessHours,
          settings?.timezone,
        ),
        intakeTagline: null,
      });
    } catch (err) {
      const { statusCode, body } = toErrorResponse(err);
      res.status(statusCode).json(body);
    }
  });

  return router;
}

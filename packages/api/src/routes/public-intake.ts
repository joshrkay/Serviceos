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
import { asyncRoute } from '../middleware/async-route';
import { LeadRepository } from '../leads/lead';
import { captureLead } from '../leads/lead-service';
import type { NewLeadAutoReply } from '../leads/new-lead-auto-reply';
import { AuditRepository } from '../audit/audit';
import { TenantRepository } from '../auth/clerk';
import { attributionSchema, LeadSource } from '../leads/enums';
import type { SettingsRepository, TenantSettings } from '../settings/settings';
import { withTenantClient, withTenantScope } from '../db/tenant-transaction';
import { VerticalPackRegistry } from '../shared/vertical-pack-registry';
import { formatBusinessHoursSummary } from '../public-intake/format-business-hours';
import { resolvePublicBusinessPhone, resolvePublicServiceTypes } from '../public-intake/public-business-info';
import { routeParam } from '../shared/route-params';

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
  // preferred dates — collapses into a single sourceDetail blob so we don't
  // need new columns for fields we only display, never query.
  serviceType: z.string().trim().max(100).optional(),
  urgency: z.string().trim().max(40).optional(),
  description: z.string().trim().max(5000).optional(),
  preferredDates: z.string().trim().max(200).optional(),
  // Free-text address kept for backward compat; structured fields preferred.
  address: z.string().trim().max(500).optional(),
  street1: z.string().trim().min(1).max(200).optional(),
  street2: z.string().trim().max(200).optional(),
  city: z.string().trim().min(1).max(100).optional(),
  state: z.string().trim().min(1).max(50).optional(),
  postalCode: z.string().trim().min(1).max(20).optional(),
  country: z.string().trim().min(1).max(50).optional(),
  accessNotes: z.string().trim().max(2000).optional(),
  utmSource: z.string().trim().max(200).optional(),
  utmMedium: z.string().trim().max(200).optional(),
  utmCampaign: z.string().trim().max(200).optional(),
  attribution: attributionSchema.optional(),
  // #1738 — the form's UNTICKED "text me about this request" box. Only an
  // explicit true lets the instant reply text go out; absent means no.
  smsConsent: z.boolean().optional(),
  // Honeypot — must be empty/absent. Real users never fill this; bots do.
  _company_url: z.string().max(500).optional(),
}).refine(
  (v) => Boolean(v.primaryPhone || v.email),
  { message: 'A primaryPhone or email is required so we can reach you' }
).refine(
  (v) => {
    const any =
      Boolean(v.street1) || Boolean(v.city) || Boolean(v.state) || Boolean(v.postalCode);
    if (!any) return true;
    return Boolean(v.street1 && v.city && v.state && v.postalCode);
  },
  { message: 'street1, city, state, and postalCode are required together' }
);

const TENANT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function buildSourceDetail(p: z.infer<typeof intakeSchema>): string | undefined {
  const parts: string[] = [];
  if (p.serviceType) parts.push(`Service: ${p.serviceType}`);
  if (p.urgency) parts.push(`Urgency: ${p.urgency}`);
  if (p.preferredDates) parts.push(`Preferred: ${p.preferredDates}`);
  const structuredAddress =
    p.street1 && p.city && p.state && p.postalCode
      ? [p.street1, p.street2, `${p.city}, ${p.state} ${p.postalCode}`]
          .filter(Boolean)
          .join(', ')
      : undefined;
  const addressLine = structuredAddress || p.address;
  if (addressLine) parts.push(`Address: ${addressLine}`);
  if (p.description) parts.push(`Description: ${p.description}`);
  if (parts.length === 0) return undefined;
  // Lead.sourceDetail is capped at 500 chars by createLeadSchema.
  const joined = parts.join(' | ');
  return joined.length > 500 ? joined.slice(0, 497) + '...' : joined;
}

/** Prefer structured address; free-text `address` alone is incomplete (street1 only). */
function resolveIntakeAddress(p: z.infer<typeof intakeSchema>): {
  street1?: string;
  street2?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string;
  accessNotes?: string;
} {
  if (p.street1 && p.city && p.state && p.postalCode) {
    return {
      street1: p.street1,
      street2: p.street2,
      city: p.city,
      state: p.state,
      postalCode: p.postalCode,
      country: p.country,
      accessNotes: p.accessNotes,
    };
  }
  // Free-text only — store on street1 for display; convert will still require
  // a complete address (city/state/postal) via the convert prompt.
  if (p.address) {
    return { street1: p.address };
  }
  return {};
}

interface PublicHeaderRows {
  settings: TenantSettings | null;
  businessPhone: string | null;
  businessHours: unknown;
  averageRating?: number;
  reviewCount?: number;
}

/**
 * The URL tenant's own rows the intake header shows. With a pool the caller
 * runs this inside withTenantScope, so every read — the repository's, the
 * phone fallback's and the two below — is one statement on that one tenant
 * transaction, as rls_app_runtime. Without one (in-memory dev) only the
 * settings repository is read, as before.
 */
async function readPublicHeaderRows(
  settingsRepo: SettingsRepository,
  tenantId: string,
  pool: Pool | undefined,
): Promise<PublicHeaderRows> {
  const settings = await settingsRepo.findByTenant(tenantId);
  const businessPhone = await resolvePublicBusinessPhone(settings, tenantId, pool);
  if (!pool) return { settings, businessPhone, businessHours: null };

  return withTenantClient(pool, tenantId, async (client) => {
    const tsRow = await client.query<{ business_hours: unknown }>(
      `SELECT business_hours FROM tenant_settings WHERE tenant_id=$1`,
      [tenantId],
    );
    const rev = await client.query<{ avg: string | null; c: string }>(
      `SELECT AVG(rating)::float AS avg, COUNT(*)::int AS c
       FROM google_reviews WHERE tenant_id = $1`,
      [tenantId],
    );
    const rows: PublicHeaderRows = {
      settings,
      businessPhone,
      businessHours: tsRow.rows[0]?.business_hours ?? null,
    };
    const count = Number(rev.rows[0]?.c ?? 0);
    if (count > 0) {
      rows.reviewCount = count;
      rows.averageRating = Math.round(Number(rev.rows[0]?.avg ?? 0) * 10) / 10;
    }
    return rows;
  });
}

export function createPublicIntakeRouter(
  leadRepo: LeadRepository,
  tenantRepo: TenantRepository,
  auditRepo: AuditRepository,
  settingsRepo: SettingsRepository,
  packRegistry: VerticalPackRegistry,
  pool?: Pool,
  autoReplyToNewLead?: NewLeadAutoReply,
): Router {
  const router = Router();

  router.post('/:tenantId/leads', asyncRoute(async (req: Request, res: Response) => {
    const tenantId = routeParam(req, 'tenantId');
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

    const addressFields = resolveIntakeAddress(parsed);
    const { lead, outcome } = await captureLead(
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
        ...addressFields,
        createdBy: PUBLIC_INTAKE_ACTOR_ID,
        actorRole: PUBLIC_INTAKE_ACTOR_ROLE,
      },
      leadRepo,
      auditRepo
    );

    // #1738 — owner-opt-in instant reply. Never throws, so a texting problem
    // can't fail the visitor's submission; every outcome is audited on the lead.
    if (autoReplyToNewLead) {
      await autoReplyToNewLead({ lead, outcome, smsConsent: parsed.smsConsent === true });
    }

    // Don't echo the full lead back — public callers don't need ids.
    res.status(201).json({ ok: true, leadId: lead.id });
  }));

  // Public tenant info for the intake form header + service-type list.
  // Read-only; same UUID-in-path validation and rate limiting as the POST.
  router.get('/:tenantId', asyncRoute(async (req: Request, res: Response) => {
    const tenantId = routeParam(req, 'tenantId');
    if (!TENANT_UUID.test(tenantId)) {
      res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Invalid tenantId' });
      return;
    }

    const tenant = await tenantRepo.findById(tenantId);
    if (!tenant) {
      res.status(404).json({ error: 'NOT_FOUND', message: 'Intake form not found' });
      return;
    }

    // Every tenant row this header shows — the settings row, the phone
    // fallback, business hours, the review summary — is read in ONE tenant
    // transaction under the RLS runtime role: withTenantScope publishes it, so
    // the settings repository and resolvePublicBusinessPhone join it too. The
    // service list comes after it: the pack catalog is a global table read on
    // a checkout of its own, which must not be held beside the session.
    const { settings, businessPhone, businessHours, averageRating, reviewCount } = pool
      ? await withTenantScope(pool, tenantId, () => readPublicHeaderRows(settingsRepo, tenantId, pool))
      : await readPublicHeaderRows(settingsRepo, tenantId, undefined);
    const serviceTypes = await resolvePublicServiceTypes(settings, packRegistry);

    res.status(200).json({
      // #1275 — tenant.name is an internal-only label, never a substitute
      // for the customer-facing business name (see auth/clerk.ts's
      // bootstrapTenant). When settings/businessName is absent, omit the
      // field entirely rather than leak it; the web client already has a
      // generic display fallback for that case.
      ...(settings?.businessName ? { businessName: settings.businessName } : {}),
      businessPhone,
      serviceTypes,
      businessHoursSummary: formatBusinessHoursSummary(
        businessHours,
        settings?.timezone,
      ),
      intakeTagline: null,
      ...(averageRating !== undefined ? { averageRating, reviewCount } : {}),
    });
  }));

  return router;
}

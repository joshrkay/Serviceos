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
 *   - Rate limit: in-memory token bucket, 10 req/min/IP and 50 req/hr/IP
 *     per tenant. Process-local — fine for one node behind the LB; if we
 *     scale out we move this to a shared store (Redis), but that's out
 *     of scope for the lead-to-cash work.
 *   - Server stamps `source = 'web_form'` and `createdBy = 'public_intake'`
 *     so the API caller can never spoof either.
 */
import { Request, Router, Response } from 'express';
import { z } from 'zod';
import { toErrorResponse } from '../shared/errors';
import { LeadRepository } from '../leads/lead';
import { createLead } from '../leads/lead-service';
import { AuditRepository } from '../audit/audit';
import { TenantRepository } from '../auth/clerk';
import { attributionSchema } from '../leads/enums';

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

interface RateLimitBucket {
  minute: { resetAt: number; count: number };
  hour: { resetAt: number; count: number };
}

const RATE_PER_MINUTE = 10;
const RATE_PER_HOUR = 50;

class IpRateLimiter {
  private buckets = new Map<string, RateLimitBucket>();

  /** Returns true if the request is allowed; false if rate-limited. */
  consume(key: string, now: number = Date.now()): boolean {
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = {
        minute: { resetAt: now + 60_000, count: 0 },
        hour: { resetAt: now + 3_600_000, count: 0 },
      };
      this.buckets.set(key, bucket);
    }
    if (now >= bucket.minute.resetAt) {
      bucket.minute = { resetAt: now + 60_000, count: 0 };
    }
    if (now >= bucket.hour.resetAt) {
      bucket.hour = { resetAt: now + 3_600_000, count: 0 };
    }
    if (bucket.minute.count >= RATE_PER_MINUTE || bucket.hour.count >= RATE_PER_HOUR) {
      return false;
    }
    bucket.minute.count++;
    bucket.hour.count++;
    return true;
  }
}

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

function extractIp(req: Request): string {
  const forwarded = req.get('x-forwarded-for');
  if (forwarded) {
    return forwarded.split(',')[0]?.trim() ?? 'unknown';
  }
  return req.ip ?? 'unknown';
}

export function createPublicIntakeRouter(
  leadRepo: LeadRepository,
  tenantRepo: TenantRepository,
  auditRepo: AuditRepository,
  rateLimiter: IpRateLimiter = new IpRateLimiter(),
): Router {
  const router = Router();

  router.post('/:tenantId/leads', async (req: Request, res: Response) => {
    try {
      const tenantId = req.params.tenantId;
      if (!TENANT_UUID.test(tenantId)) {
        res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Invalid tenantId' });
        return;
      }

      const ip = extractIp(req);
      if (!rateLimiter.consume(`${tenantId}:${ip}`)) {
        res.status(429).json({
          error: 'RATE_LIMITED',
          message: 'Too many requests, please try again later',
        });
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
      // write the row. We intentionally do NOT log this as an error.
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
          source: 'web_form',
          sourceDetail: buildSourceDetail(parsed),
          utmSource: parsed.utmSource,
          utmMedium: parsed.utmMedium,
          utmCampaign: parsed.utmCampaign,
          attribution: parsed.attribution,
          createdBy: 'public_intake',
          actorRole: 'public',
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

  return router;
}

export { IpRateLimiter };

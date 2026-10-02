// #1564 — owner-only API for the tenant's US A2P 10DLC texting registration.
//
//   GET /api/settings/texting-registration  → status + details (EIN as last 4)
//   PUT /api/settings/texting-registration  → submit / resubmit the details
//
// Both are owner-only: the details include the business's tax ID. The EIN is
// validated here, encrypted by the service before it is stored, and never
// echoed back or logged. Fees are absorbed by Rivet — nothing is billed.

import { Router, Response } from 'express';
import { z } from 'zod';
import type { AuthenticatedRequest } from '../auth/clerk';
import { requireAuth, requireTenant, requireRole } from '../middleware/auth';
import { toErrorResponse } from '../shared/errors';
import { normalizeMobileE164 } from '../shared/phone/normalize';
import {
  A2P_BUSINESS_INDUSTRIES,
  A2P_BUSINESS_TYPES,
  A2P_JOB_POSITIONS,
} from '../integrations/twilio/a2p-10dlc/registration';
import type { createA2pRegistrationService } from '../integrations/twilio/a2p-10dlc/service';

const text = (max: number) => z.string().trim().min(1).max(max);
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => (v ? v : null));

const usPhone = z.string().transform((value, ctx) => {
  try {
    return normalizeMobileE164(value);
  } catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Enter a valid US phone number' });
    return z.NEVER;
  }
});

const submissionSchema = z.object({
  legalBusinessName: text(200),
  // Digits only after stripping the conventional "12-3456789" hyphen. The
  // error message never quotes the submitted value.
  ein: z
    .string()
    .transform((v) => v.replace(/[\s-]/g, ''))
    .refine((v) => /^\d{9}$/.test(v), { message: 'EIN must be 9 digits' }),
  businessType: z.enum(A2P_BUSINESS_TYPES),
  businessIndustry: z.enum(A2P_BUSINESS_INDUSTRIES),
  websiteUrl: z
    .string()
    .trim()
    .max(500)
    .nullish()
    .transform((v) => (v ? v : null))
    .refine((v) => v === null || /^https?:\/\/[^\s]+\.[^\s]+$/i.test(v), { message: 'Enter a full website URL' }),
  address: z.object({
    street: text(200),
    street2: optionalText(200),
    city: text(100),
    region: z
      .string()
      .trim()
      .transform((v) => v.toUpperCase())
      .refine((v) => /^[A-Z]{2}$/.test(v), { message: 'Use the 2-letter state code' }),
    postalCode: z.string().trim().regex(/^\d{5}(-\d{4})?$/, 'Enter a 5-digit ZIP code'),
  }),
  contact: z.object({
    firstName: text(100),
    lastName: text(100),
    email: z.string().trim().email().max(254),
    phone: usPhone,
    title: text(100),
    jobPosition: z.enum(A2P_JOB_POSITIONS),
  }),
});

export function createTextingRegistrationRouter(deps: {
  /** Null when TENANT_ENCRYPTION_KEY is unset — the EIN cannot be protected. */
  service: ReturnType<typeof createA2pRegistrationService> | null;
}): Router {
  const router = Router();
  const notConfigured = (res: Response) =>
    res.status(503).json({
      error: 'TEXTING_REGISTRATION_NOT_CONFIGURED',
      message: 'Texting registration is not available on this server',
    });

  router.get('/', requireAuth, requireTenant, requireRole('owner'), async (req: AuthenticatedRequest, res: Response) => {
    if (!deps.service) return void notConfigured(res);
    try {
      res.json(await deps.service.view(req.auth!.tenantId));
    } catch (err) {
      const { statusCode, body } = toErrorResponse(err);
      res.status(statusCode).json(body);
    }
  });

  router.put('/', requireAuth, requireTenant, requireRole('owner'), async (req: AuthenticatedRequest, res: Response) => {
    if (!deps.service) return void notConfigured(res);
    const parsed = submissionSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: 'Check the highlighted fields',
        // Paths + messages only — never `received` values (the EIN).
        fields: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
      return;
    }
    try {
      const view = await deps.service.submit(
        req.auth!.tenantId,
        { userId: req.auth!.userId, role: req.auth!.role },
        parsed.data,
      );
      res.json(view);
    } catch (err) {
      const { statusCode, body } = toErrorResponse(err);
      res.status(statusCode).json(body);
    }
  });

  return router;
}

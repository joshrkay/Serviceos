import { Router, Response } from 'express';
import { z } from 'zod';

import { AuthenticatedRequest } from '../auth/clerk';
import { asyncRoute } from '../middleware/async-route';
import { requireAuth, requireTenant, requirePermission } from '../middleware/auth';
import { AuditRepository, createAuditEvent } from '../audit/audit';
import { PaymentCollectionMode, SettingsRepository } from '../settings/settings';
import { resolveCustomerLanguage } from '../i18n/resolve-language';
import { routeParam } from '../shared/route-params';
import type { Language } from '../ai/i18n/i18n';
import { formatUsdCentsPlain } from '@ai-service-os/shared';
import {
  CustomerTextWordingRepository,
  MAX_WORDING_LENGTH,
  WORDING_FILL_INS,
  WORDING_PURPOSES,
  WordingPurpose,
  isWordingPurpose,
  wordingProblems,
} from './customer-text-wording';
import {
  renderEstimateSms,
  renderInvoiceSms,
  renderPortalLinkSms,
  renderThankYouSms,
  smsInvoiceCollectOnSiteLine,
} from './templates';

/** The languages an owner can write each text in (D-045, "write both"). */
const LANGUAGES = ['en', 'es'] as const satisfies readonly Language[];
const languageSchema = z.enum(LANGUAGES);

// Generous: the real limit is checked after trimming, with a reason the owner can act on.
// No language means the business's own.
const saveSchema = z.object({ body: z.string().max(20000), language: languageSchema.optional() });

const SAMPLE = {
  customerName: 'Sam Rivera',
  estimateNumber: 'EST-1042',
  invoiceNumber: 'INV-1042',
  totalCents: 48500,
};

/** Our wording for each text, with sample values, in one language. */
function ourWording(
  purpose: WordingPurpose,
  ctx: {
    businessName: string;
    language: Language;
    baseUrl: string;
    paymentCollectionMode: PaymentCollectionMode;
  },
): string {
  switch (purpose) {
    case 'estimate_text':
      return renderEstimateSms({
        customerName: SAMPLE.customerName,
        estimateNumber: SAMPLE.estimateNumber,
        totalCents: SAMPLE.totalCents,
        businessName: ctx.businessName,
        viewUrl: `${ctx.baseUrl}/e/sample`,
        language: ctx.language,
      }).body;
    case 'invoice_text':
      return renderInvoiceSms({
        customerName: SAMPLE.customerName,
        invoiceNumber: SAMPLE.invoiceNumber,
        totalCents: SAMPLE.totalCents,
        businessName: ctx.businessName,
        viewUrl: `${ctx.baseUrl}/pay/sample`,
        language: ctx.language,
        // What this business's invoices actually say (paid in person or online).
        paymentCollectionMode: ctx.paymentCollectionMode,
      }).body;
    case 'portal_link_text':
      return renderPortalLinkSms({
        customerName: SAMPLE.customerName,
        businessName: ctx.businessName,
        portalUrl: `${ctx.baseUrl}/portal/sample`,
        language: ctx.language,
      }).body;
    case 'thank_you_text':
      return renderThankYouSms({ businessName: ctx.businessName, language: ctx.language }).body;
  }
}

function sampleValues(purpose: WordingPurpose, businessName: string, baseUrl: string): Record<string, string> {
  const all: Record<string, string> = {
    customer_name: SAMPLE.customerName,
    business_name: businessName,
    number: purpose === 'invoice_text' ? SAMPLE.invoiceNumber : SAMPLE.estimateNumber,
    total: formatUsdCentsPlain(SAMPLE.totalCents),
    link:
      purpose === 'invoice_text'
        ? `${baseUrl}/pay/sample`
        : purpose === 'portal_link_text'
          ? `${baseUrl}/portal/sample`
          : `${baseUrl}/e/sample`,
  };
  return Object.fromEntries(WORDING_FILL_INS[purpose].map((k) => [k, all[k]]));
}

/**
 * D-045 — Settings → Text wording. The owner reads our wording for each
 * customer text (with sample values), saves their own with `{{fill-ins}}`, or
 * resets to ours, once per language. A customer gets the owner's wording in
 * the language they read when there is one, else ours in that language
 * (customer-text-wording.ts).
 */
export function createCustomerTextWordingRouter(deps: {
  repo: CustomerTextWordingRepository;
  settingsRepo: SettingsRepository;
  auditRepo: AuditRepository;
  publicBaseUrl: string;
}): Router {
  const router = Router();
  const baseUrl = deps.publicBaseUrl.replace(/\/$/, '');
  const businessLanguage = async (tenantId: string): Promise<Language> =>
    resolveCustomerLanguage({
      tenantDefaultLanguage: (await deps.settingsRepo.findByTenant(tenantId))?.defaultLanguage,
    });

  router.get(
    '/',
    requireAuth,
    requireTenant,
    requirePermission('settings:view'),
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      const tenantId = req.auth!.tenantId;
      const [settings, saved] = await Promise.all([
        deps.settingsRepo.findByTenant(tenantId),
        deps.repo.list(tenantId),
      ]);
      const businessName = settings?.businessName ?? 'Your service team';
      const language = resolveCustomerLanguage({ tenantDefaultLanguage: settings?.defaultLanguage });
      const paymentCollectionMode = settings?.paymentCollectionMode ?? 'pay_link';
      res.json({
        language,
        languages: LANGUAGES,
        maxLength: MAX_WORDING_LENGTH,
        texts: WORDING_PURPOSES.map((purpose) => ({
          purpose,
          fillIns: WORDING_FILL_INS[purpose],
          sampleValues: sampleValues(purpose, businessName, baseUrl),
          byLanguage: Object.fromEntries(
            LANGUAGES.map((lang) => {
              const mine = saved.find((s) => s.purpose === purpose && s.language === lang);
              return [
                lang,
                {
                  ours: ourWording(purpose, { businessName, language: lang, baseUrl, paymentCollectionMode }),
                  // Lines every send adds after the owner's wording (an invoice
                  // paid in person says so), so the preview shows what customers get.
                  addedLines:
                    purpose === 'invoice_text'
                      ? smsInvoiceCollectOnSiteLine({ businessName, language: lang, paymentCollectionMode })
                      : [],
                  saved: mine ? { body: mine.body, updatedAt: mine.updatedAt.toISOString() } : null,
                },
              ];
            }),
          ),
        })),
      });
    }),
  );

  router.put(
    '/:purpose',
    requireAuth,
    requireTenant,
    requirePermission('settings:update'),
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      const purpose = routeParam(req, 'purpose');
      if (!isWordingPurpose(purpose)) {
        res.status(404).json({ error: 'NOT_FOUND', message: 'No such text' });
        return;
      }
      const parsed = saveSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Send the wording as text.' });
        return;
      }
      const body = parsed.data.body.trim();
      const problems = wordingProblems(purpose, body);
      if (problems.length > 0) {
        res.status(400).json({ error: 'VALIDATION_ERROR', message: problems.join(' '), problems });
        return;
      }
      const { tenantId, userId, role } = req.auth!;
      // Only customers who read this language get it.
      const language = parsed.data.language ?? (await businessLanguage(tenantId));
      const saved = await deps.repo.save(tenantId, purpose, body, language, userId);
      await deps.auditRepo.create(
        createAuditEvent({
          tenantId,
          actorId: userId,
          actorRole: role,
          eventType: 'customer_text_wording.saved',
          entityType: 'customer_text_wording',
          entityId: purpose,
          metadata: { purpose, language, length: body.length },
        }),
      );
      res.json({
        purpose,
        language,
        saved: { body: saved.body, updatedAt: saved.updatedAt.toISOString() },
      });
    }),
  );

  router.delete(
    '/:purpose',
    requireAuth,
    requireTenant,
    requirePermission('settings:update'),
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      const purpose = routeParam(req, 'purpose');
      if (!isWordingPurpose(purpose)) {
        res.status(404).json({ error: 'NOT_FOUND', message: 'No such text' });
        return;
      }
      const lang = languageSchema.optional().safeParse(req.query.language);
      if (!lang.success) {
        res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Unknown language.' });
        return;
      }
      const { tenantId, userId, role } = req.auth!;
      const language = lang.data ?? (await businessLanguage(tenantId));
      const removed = await deps.repo.remove(tenantId, purpose, language);
      if (removed) {
        await deps.auditRepo.create(
          createAuditEvent({
            tenantId,
            actorId: userId,
            actorRole: role,
            eventType: 'customer_text_wording.reset',
            entityType: 'customer_text_wording',
            entityId: purpose,
            metadata: { purpose, language },
          }),
        );
      }
      res.json({ purpose, language, saved: null });
    }),
  );

  return router;
}

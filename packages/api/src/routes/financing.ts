import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../auth/clerk';
import { asyncRoute } from '../middleware/async-route';
import { requireAuth, requireTenant, requirePermission } from '../middleware/auth';
import { AuditRepository } from '../audit/audit';
import { InvoiceRepository } from '../invoices/invoice';
import { JobRepository } from '../jobs/job';
import { CustomerRepository } from '../customers/customer';
import { verifyWebhookSignature } from '../webhooks/webhook-handler';
import {
  FinancingRepository,
  applyFinancingStatusUpdate,
  offerFinancing,
} from '../financing/financing';
import { FinancingProviderClient, mapWisetackStatus } from '../financing/financing-provider';
import { offerFinancingSchema } from '../shared/contracts';

export interface FinancingRouterDeps {
  financingRepo: FinancingRepository;
  invoiceRepo: InvoiceRepository;
  jobRepo: JobRepository;
  customerRepo: CustomerRepository;
  provider: FinancingProviderClient;
  auditRepo: AuditRepository;
}

/**
 * FIN (Jobber parity) — consumer financing on invoices.
 *
 * Mounted at /api/financing (JSON, authed): offer financing on an invoice
 * (creates a provider application + consumer link) and read offers. The
 * provider status webhook is a separate raw-body router (see
 * createFinancingWebhookRouter) so its HMAC is computed over exact bytes.
 */
export function createFinancingRouter(deps: FinancingRouterDeps): Router {
  const router = Router();

  router.post(
    '/invoices/:invoiceId/offer',
    requireAuth,
    requireTenant,
    requirePermission('invoices:update'),
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      const parsed = offerFinancingSchema.parse(req.body);
      const tenantId = req.auth!.tenantId;
      const invoice = await deps.invoiceRepo.findById(tenantId, req.params.invoiceId);
      if (!invoice) {
        res.status(404).json({ error: 'NOT_FOUND', message: 'Invoice not found' });
        return;
      }
      const amountCents = parsed.amountCents ?? invoice.amountDueCents ?? invoice.totals.totalCents;

      // Invoices reference the customer through their job.
      let customerId: string | null = null;
      let customerName = 'Customer';
      let customerEmail: string | undefined;
      let customerPhone: string | undefined;
      const job = await deps.jobRepo.findById(tenantId, invoice.jobId);
      if (job?.customerId) {
        customerId = job.customerId;
        const customer = await deps.customerRepo.findById(tenantId, job.customerId);
        if (customer) {
          customerName =
            customer.displayName || `${customer.firstName} ${customer.lastName}`.trim() || 'Customer';
          customerEmail = customer.email;
          customerPhone = customer.primaryPhone;
        }
      }

      const application = await offerFinancing(
        {
          tenantId,
          invoiceId: invoice.id,
          customerId,
          amountCents,
          invoiceNumber: invoice.invoiceNumber ?? invoice.id,
          customerName,
          customerEmail,
          customerPhone,
          returnUrl: parsed.returnUrl,
          createdBy: req.auth!.userId,
          actorRole: req.auth!.role,
        },
        deps.financingRepo,
        deps.provider,
        deps.auditRepo
      );
      res.status(201).json(application);
    })
  );

  router.get(
    '/invoices/:invoiceId',
    requireAuth,
    requireTenant,
    requirePermission('invoices:view'),
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      const apps = await deps.financingRepo.listByInvoice(req.auth!.tenantId, req.params.invoiceId);
      res.json(apps);
    })
  );

  router.get(
    '/:id',
    requireAuth,
    requireTenant,
    requirePermission('invoices:view'),
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      const app = await deps.financingRepo.findById(req.auth!.tenantId, req.params.id);
      if (!app) {
        res.status(404).json({ error: 'NOT_FOUND', message: 'Financing application not found' });
        return;
      }
      res.json(app);
    })
  );

  return router;
}

export interface FinancingWebhookDeps {
  financingRepo: FinancingRepository;
  auditRepo: AuditRepository;
  /** Provider webhook signing secret; when unset every call is 503'd. */
  webhookSecret?: string;
}

/**
 * Provider status webhook. Mount at /webhooks/wisetack with express.raw()
 * BEFORE the global express.json() so req.body is the exact signed Buffer.
 *
 * Wisetack echoes the `external_reference` we set at creation
 * (`"${tenantId}:${applicationId}"`), so we resolve the row from that rather
 * than expecting top-level tenant/application fields the provider never sends.
 */
export function createFinancingWebhookRouter(deps: FinancingWebhookDeps): Router {
  const router = Router();
  router.post(
    '/',
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      if (!deps.webhookSecret) {
        res.status(503).json({ error: 'NOT_CONFIGURED' });
        return;
      }
      const rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
      const signature = req.header('x-wisetack-signature') ?? req.header('x-signature') ?? '';
      if (!verifyWebhookSignature(rawBody, signature, deps.webhookSecret)) {
        res.status(401).json({ error: 'BAD_SIGNATURE' });
        return;
      }
      let body: { external_reference?: string; status?: string; status_reason?: string };
      try {
        body = JSON.parse(rawBody);
      } catch {
        res.status(400).json({ error: 'BAD_JSON' });
        return;
      }
      // external_reference is "tenantId:applicationId" (set in createApplication).
      const [tenantId, applicationId] = (body.external_reference ?? '').split(':');
      if (!tenantId || !applicationId) {
        res.status(400).json({ error: 'INVALID_REFERENCE' });
        return;
      }
      const status = mapWisetackStatus(body.status ?? '');
      const updated = await applyFinancingStatusUpdate(
        tenantId,
        applicationId,
        status,
        body.status_reason ?? null,
        deps.financingRepo,
        deps.auditRepo
      );
      // Always 200 a verified webhook so the provider stops retrying.
      res.status(200).json({ ok: true, applied: updated !== null });
    })
  );
  return router;
}

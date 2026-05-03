import { Logger } from '../logging/logger';
import { QueueMessage, WorkerHandler } from '../queues/queue';
import { JobRepository } from '../jobs/job';
import { EstimateRepository } from '../estimates/estimate';
import { InvoiceRepository } from '../invoices/invoice';
import { SettingsRepository } from '../settings/settings';
import { AuditRepository } from '../audit/audit';
import { convertEstimateToInvoice } from '../invoices/estimate-to-invoice';

export interface InvoiceFromCompletedJobPayload {
  tenantId: string;
  jobId: string;
}

/**
 * On job.completed, draft an invoice from the most recent accepted
 * estimate so the operator doesn't have to re-key line items. The
 * invoice is left in `draft` status — a human still reviews it before
 * issuing. If the job has no accepted estimate, the worker is a no-op
 * and logs the reason; the operator can still create an invoice
 * manually.
 *
 * Idempotency: `convertEstimateToInvoice` returns the existing invoice
 * if one already references the estimate, so re-deliveries don't
 * create duplicates.
 */
export function createInvoiceFromCompletedJobWorker(deps: {
  jobRepo: JobRepository;
  estimateRepo: EstimateRepository;
  invoiceRepo: InvoiceRepository;
  settingsRepo: SettingsRepository;
  auditRepo: AuditRepository;
}): WorkerHandler<InvoiceFromCompletedJobPayload> {
  const { jobRepo, estimateRepo, invoiceRepo, settingsRepo, auditRepo } = deps;

  return {
    type: 'invoice_from_completed_job',
    async handle(
      message: QueueMessage<InvoiceFromCompletedJobPayload>,
      logger: Logger
    ): Promise<void> {
      const { tenantId, jobId } = message.payload;

      const job = await jobRepo.findById(tenantId, jobId);
      if (!job) {
        logger.warn('Cannot draft invoice: job not found', { tenantId, jobId });
        return;
      }

      const estimates = await estimateRepo.findByTenant(tenantId, { jobId });
      const accepted = estimates
        .filter((e) => e.status === 'accepted')
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];

      if (!accepted) {
        logger.info(
          'No accepted estimate for completed job; skipping auto-invoice',
          { tenantId, jobId }
        );
        return;
      }

      const invoice = await convertEstimateToInvoice(
        {
          tenantId,
          estimateId: accepted.id,
          createdBy: 'job_completion_worker',
        },
        estimateRepo,
        jobRepo,
        invoiceRepo,
        settingsRepo,
        auditRepo,
      );

      logger.info('Drafted invoice from completed job', {
        tenantId,
        jobId,
        estimateId: accepted.id,
        invoiceId: invoice.id,
        invoiceNumber: invoice.invoiceNumber,
      });
    },
  };
}

export interface TechnicianJobUpdate {
  updateType: string;
  content: string;
  timestamp: Date;
}

export interface JobContext {
  jobId: string;
  tenantId: string;
  status: string;
  hasExistingDraftInvoice: boolean;
  completedAt?: Date;
}

export interface InvoiceOpportunitySignal {
  shouldDraft: boolean;
  reason: string;
  confidence: number;
}

const COMPLETION_UPDATE_TYPES = ['work_completed', 'job_completed', 'final_update'];

export function detectInvoiceOpportunity(
  update: TechnicianJobUpdate,
  jobContext: JobContext
): InvoiceOpportunitySignal {
  // Don't draft if invoice already exists
  if (jobContext.hasExistingDraftInvoice) {
    return { shouldDraft: false, reason: 'Draft invoice already exists', confidence: 1.0 };
  }

  // Don't draft if job not completed
  if (jobContext.status !== 'completed') {
    // Check if this update signals completion
    if (COMPLETION_UPDATE_TYPES.includes(update.updateType)) {
      return {
        shouldDraft: true,
        reason: 'Technician reported work completion',
        confidence: 0.8,
      };
    }
    return { shouldDraft: false, reason: 'Job not yet completed', confidence: 0.9 };
  }

  // Job is completed, no existing invoice
  return {
    shouldDraft: true,
    reason: 'Job completed with no existing invoice',
    confidence: 0.9,
  };
}

export function validateOpportunityInput(update: TechnicianJobUpdate, jobContext: JobContext): string[] {
  const errors: string[] = [];
  if (!update.updateType) errors.push('updateType is required');
  if (!update.content) errors.push('content is required');
  if (!jobContext.jobId) errors.push('jobId is required');
  if (!jobContext.tenantId) errors.push('tenantId is required');
  if (!jobContext.status) errors.push('job status is required');
  return errors;
}

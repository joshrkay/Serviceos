import { Proposal, ProposalType } from '../proposal';
import { ExecutionHandler, ExecutionContext, ExecutionResult } from './handlers';
import { JobPhotoService } from '../../jobs/job-photo-service';
import { InvoicePhotoService } from '../../invoices/invoice-photo-service';
import { isValidJobPhotoCategory } from '../../jobs/job-photo';

export class AttachJobPhotoExecutionHandler implements ExecutionHandler {
  proposalType: ProposalType = 'attach_job_photo';

  constructor(private readonly photoService?: JobPhotoService) {}

  async execute(proposal: Proposal, context: ExecutionContext): Promise<ExecutionResult> {
    const { payload } = proposal;
    const jobId = payload.jobId;
    const fileId = payload.fileId;
    const category = payload.category;

    if (typeof jobId !== 'string' || typeof fileId !== 'string') {
      return { success: false, error: 'jobId and fileId are required' };
    }
    if (!isValidJobPhotoCategory(category)) {
      return { success: false, error: 'Invalid photo category' };
    }

    if (!this.photoService) {
      return { success: true, resultEntityId: jobId };
    }

    try {
      const takenAt =
        typeof payload.takenAt === 'string' ? new Date(payload.takenAt) : undefined;
      let photo = await this.photoService.attachPhotoToJob(
        context.tenantId,
        jobId,
        fileId,
        category,
        typeof payload.notes === 'string' ? payload.notes : undefined,
        takenAt,
        context.executedBy,
      );
      if (payload.clientVisible === true) {
        photo =
          (await this.photoService.setClientVisible(
            context.tenantId,
            jobId,
            photo.id,
            true,
          )) ?? photo;
      }
      return { success: true, resultEntityId: photo.id };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

export class AttachInvoicePhotoExecutionHandler implements ExecutionHandler {
  proposalType: ProposalType = 'attach_invoice_photo';

  constructor(private readonly photoService?: InvoicePhotoService) {}

  async execute(proposal: Proposal, context: ExecutionContext): Promise<ExecutionResult> {
    const { payload } = proposal;
    const invoiceId = payload.invoiceId;
    const fileId = payload.fileId;
    const category = payload.category;

    if (typeof invoiceId !== 'string' || typeof fileId !== 'string') {
      return { success: false, error: 'invoiceId and fileId are required' };
    }
    if (!isValidJobPhotoCategory(category)) {
      return { success: false, error: 'Invalid photo category' };
    }

    if (!this.photoService) {
      return { success: true, resultEntityId: invoiceId };
    }

    try {
      const takenAt =
        typeof payload.takenAt === 'string' ? new Date(payload.takenAt) : undefined;
      let photo = await this.photoService.attachPhotoToInvoice(
        context.tenantId,
        invoiceId,
        fileId,
        category,
        typeof payload.notes === 'string' ? payload.notes : undefined,
        takenAt,
        context.executedBy,
        payload.clientVisible === true,
      );
      if (payload.clientVisible === true) {
        photo =
          (await this.photoService.setClientVisible(
            context.tenantId,
            invoiceId,
            photo.id,
            true,
          )) ?? photo;
      }
      return { success: true, resultEntityId: photo.id };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

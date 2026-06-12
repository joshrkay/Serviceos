import { z } from 'zod';
import { JOB_PHOTO_CATEGORIES } from '../../jobs/job-photo';

export const attachJobPhotoPayloadSchema = z.object({
  jobId: z.string().uuid(),
  fileId: z.string().uuid(),
  category: z.enum(JOB_PHOTO_CATEGORIES),
  notes: z.string().optional(),
  takenAt: z.string().datetime().optional(),
  clientVisible: z.boolean().optional(),
});

export const attachInvoicePhotoPayloadSchema = z.object({
  invoiceId: z.string().uuid(),
  fileId: z.string().uuid(),
  category: z.enum(JOB_PHOTO_CATEGORIES),
  notes: z.string().optional(),
  takenAt: z.string().datetime().optional(),
  clientVisible: z.boolean().optional(),
});

export type AttachJobPhotoPayload = z.infer<typeof attachJobPhotoPayloadSchema>;
export type AttachInvoicePhotoPayload = z.infer<typeof attachInvoicePhotoPayloadSchema>;

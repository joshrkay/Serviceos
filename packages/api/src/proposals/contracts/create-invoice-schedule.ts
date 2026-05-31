import { z } from 'zod';

/**
 * create_invoice_schedule proposal payload (P21-002).
 *
 * Sets up a progress/milestone billing plan for a job. Capture-class: writing
 * the schedule + drafting the first milestone invoice moves no money (sending
 * each milestone invoice is a separate step). The Zod rules mirror
 * `invoices/invoice-schedule.ts validateMilestones` so the proposal layer and
 * the data layer reject the same shapes: percent in basis points (≤ 10000),
 * non-negative flat cents, and exactly one `remainder` milestone.
 */
const milestoneSchema = z.object({
  label: z.string().min(1),
  type: z.enum(['percent', 'flat', 'remainder']),
  /** percent: bps (0–10000); flat: integer cents; remainder: ignored. */
  value: z.number().int().min(0),
  trigger: z.enum(['on_accept', 'on_completion', 'manual']),
});

export const createInvoiceSchedulePayloadSchema = z
  .object({
    jobId: z.string().uuid(),
    estimateId: z.string().uuid().optional(),
    /** Optional explicit total; when omitted the executor derives it from the estimate. */
    totalAmountCents: z.number().int().min(0).optional(),
    milestones: z.array(milestoneSchema).min(1),
  })
  .refine((v) => v.milestones.filter((m) => m.type === 'remainder').length === 1, {
    message: 'Exactly one milestone must be of type "remainder"',
    path: ['milestones'],
  })
  .refine((v) => v.milestones.every((m) => m.type !== 'percent' || m.value <= 10000), {
    message: 'percent milestones must be ≤ 10000 bps',
    path: ['milestones'],
  });

export type CreateInvoiceSchedulePayload = z.infer<typeof createInvoiceSchedulePayloadSchema>;

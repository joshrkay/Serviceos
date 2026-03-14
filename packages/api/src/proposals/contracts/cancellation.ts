import { z } from 'zod';

export const cancelAppointmentPayloadSchema = z.object({
  appointmentId: z.string().uuid(),
  reason: z.string().min(1),
  cancellationType: z.enum([
    'customer_request',
    'technician_unavailable',
    'scheduling_conflict',
    'other',
  ]),
});

export type CancelAppointmentPayload = z.infer<typeof cancelAppointmentPayloadSchema>;

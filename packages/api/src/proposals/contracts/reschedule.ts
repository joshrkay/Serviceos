import { z } from 'zod';

export const rescheduleAppointmentPayloadSchema = z.object({
  appointmentId: z.string().uuid(),
  newScheduledStart: z.string().min(1),
  newScheduledEnd: z.string().min(1),
  newArrivalWindowStart: z.string().optional(),
  newArrivalWindowEnd: z.string().optional(),
  reason: z.string().optional(),
});

export type RescheduleAppointmentPayload = z.infer<typeof rescheduleAppointmentPayloadSchema>;

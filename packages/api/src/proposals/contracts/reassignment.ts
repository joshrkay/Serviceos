import { z } from 'zod';

export const reassignAppointmentPayloadSchema = z.object({
  appointmentId: z.string().uuid(),
  fromTechnicianId: z.string().uuid().optional(),
  toTechnicianId: z.string().uuid(),
  reason: z.string().optional(),
});

export type ReassignAppointmentPayload = z.infer<typeof reassignAppointmentPayloadSchema>;

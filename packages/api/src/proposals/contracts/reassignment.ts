import { z } from 'zod';

export const reassignAppointmentPayloadSchema = z.object({
  appointmentId: z.guid(),
  fromTechnicianId: z.guid().optional(),
  toTechnicianId: z.guid(),
  reason: z.string().optional(),
});

export type ReassignAppointmentPayload = z.infer<typeof reassignAppointmentPayloadSchema>;

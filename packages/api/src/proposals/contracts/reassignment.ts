import { z } from 'zod';

export const reassignAppointmentPayloadSchema = z.object({
  appointmentId: z.guid(),
  fromTechnicianId: z.guid().optional(),
  toTechnicianId: z.guid(),
  reason: z.string().optional(),
  /**
   * FR-2 phase 3c — the dispatcher chose to book this tech over a visit
   * already on their calendar. Only ever `true` (absent otherwise); set by
   * the dispatch board's explicit "Book anyway" confirmation, never by AI.
   */
  acceptOverlap: z.literal(true).optional(),
});

export type ReassignAppointmentPayload = z.infer<typeof reassignAppointmentPayloadSchema>;

import { z } from 'zod';

export const addCrewMemberPayloadSchema = z.object({
  appointmentId: z.guid(),
  technicianId: z.guid(),
  reason: z.string().optional(),
});

export type AddCrewMemberPayload = z.infer<typeof addCrewMemberPayloadSchema>;

export const removeCrewMemberPayloadSchema = z.object({
  appointmentId: z.guid(),
  technicianId: z.guid(),
  reason: z.string().optional(),
});

export type RemoveCrewMemberPayload = z.infer<typeof removeCrewMemberPayloadSchema>;

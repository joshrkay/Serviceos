import { z } from 'zod';

export const addCrewMemberPayloadSchema = z.object({
  appointmentId: z.string().uuid(),
  technicianId: z.string().uuid(),
  reason: z.string().optional(),
});

export type AddCrewMemberPayload = z.infer<typeof addCrewMemberPayloadSchema>;

export const removeCrewMemberPayloadSchema = z.object({
  appointmentId: z.string().uuid(),
  technicianId: z.string().uuid(),
  reason: z.string().optional(),
});

export type RemoveCrewMemberPayload = z.infer<typeof removeCrewMemberPayloadSchema>;

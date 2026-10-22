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
  /**
   * Set by the SERVER at creation (never trusted from the client): the
   * overlapping appointments the dispatcher accepted. Approval downgrades
   * only these; a clash with any other visit still blocks.
   */
  acceptedOverlapAppointmentIds: z.array(z.guid()).optional(),
});

export type ReassignAppointmentPayload = z.infer<typeof reassignAppointmentPayloadSchema>;

/**
 * FR-2 phase 3c — the overlap consent is written by the server at creation
 * for one (appointment, technician) pair. It is never accepted from an edit,
 * and it does not survive an edit that retargets the booking.
 */
const OVERLAP_CONSENT_FIELDS = ['acceptOverlap', 'acceptedOverlapAppointmentIds'] as const;

export function withoutOverlapConsent(payload: Record<string, unknown>): Record<string, unknown> {
  const out = { ...payload };
  for (const f of OVERLAP_CONSENT_FIELDS) delete out[f];
  return out;
}

/** True when `edits` change which appointment or technician the reassign is for. */
export function editRetargetsReassign(payload: Record<string, unknown>, edits: Record<string, unknown>): boolean {
  return (['appointmentId', 'toTechnicianId'] as const).some(
    (f) => f in edits && edits[f] !== payload[f],
  );
}

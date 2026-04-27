import { z } from 'zod';

/**
 * add_note proposal payload.
 *
 * Attaches a free-text note to an existing record. `targetKind` is
 * required so the downstream execution handler knows which repo to
 * call. `targetId` may be absent at proposal-creation time when the
 * task handler only got a reference by name ("the Rodriguez job") —
 * in that case the operator resolves the reference at review time
 * and we fall back to `targetReference`.
 */
export const addNotePayloadSchema = z
  .object({
    targetKind: z.enum(['job', 'customer', 'invoice', 'estimate', 'appointment']),
    targetId: z.string().uuid().optional(),
    targetReference: z.string().optional(),
    body: z.string().min(1),
  })
  .refine((v) => Boolean(v.targetId || v.targetReference), {
    message: 'Either targetId or targetReference is required',
  });

export type AddNotePayload = z.infer<typeof addNotePayloadSchema>;

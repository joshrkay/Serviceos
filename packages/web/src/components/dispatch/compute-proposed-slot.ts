export interface SlotAppointment {
  id: string;
  scheduledStart: string;
  scheduledEnd: string;
}

export type SlotPlacement = 'gap' | 'overflow';

export interface ProposedSlot {
  proposedScheduledStart: string;
  proposedScheduledEnd: string;
  placement: SlotPlacement;
}

export function computeProposedSlot(input: {
  /** Lane appointments excluding the dragged card. */
  appointments: SlotAppointment[];
  insertIndex: number;
  dragged: { scheduledStart: string; scheduledEnd: string };
  /** ISO start of the dispatch day when the lane is empty or for leading insert. */
  dayStartIso?: string;
}): ProposedSlot {
  const durationMs =
    new Date(input.dragged.scheduledEnd).getTime() -
    new Date(input.dragged.scheduledStart).getTime();

  if (durationMs <= 0) {
    return {
      proposedScheduledStart: input.dragged.scheduledStart,
      proposedScheduledEnd: input.dragged.scheduledEnd,
      placement: 'overflow',
    };
  }

  const sorted = [...input.appointments].sort(
    (a, b) => new Date(a.scheduledStart).getTime() - new Date(b.scheduledStart).getTime(),
  );

  const overflow = (): ProposedSlot => ({
    proposedScheduledStart: '',
    proposedScheduledEnd: '',
    placement: 'overflow',
  });

  const pack = (startMs: number): ProposedSlot => ({
    proposedScheduledStart: new Date(startMs).toISOString(),
    proposedScheduledEnd: new Date(startMs + durationMs).toISOString(),
    placement: 'gap',
  });

  if (sorted.length === 0) {
    const startMs = input.dayStartIso
      ? new Date(input.dayStartIso).getTime()
      : new Date(input.dragged.scheduledStart).getTime();
    return pack(startMs);
  }

  if (input.insertIndex <= 0) {
    const firstStart = new Date(sorted[0].scheduledStart).getTime();
    const windowStart = input.dayStartIso
      ? new Date(input.dayStartIso).getTime()
      : firstStart - durationMs;
    const startMs = firstStart - durationMs;
    if (startMs < windowStart) return overflow();
    return pack(startMs);
  }

  if (input.insertIndex >= sorted.length) {
    const lastEnd = new Date(sorted[sorted.length - 1].scheduledEnd).getTime();
    return pack(lastEnd);
  }

  const prevEnd = new Date(sorted[input.insertIndex - 1].scheduledEnd).getTime();
  const nextStart = new Date(sorted[input.insertIndex].scheduledStart).getTime();
  if (nextStart - prevEnd < durationMs) return overflow();
  return pack(prevEnd);
}

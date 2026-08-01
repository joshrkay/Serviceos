/**
 * Canonical lane ordering + insert-index math for the dispatch board.
 *
 * The board renders each lane as `filterAppointmentsByStatus(lane.appointments)`
 * sorted by start time (see TechnicianLane). Every index the UI hands back — the
 * gap `insertIndex` from a drop and the `fromIndex/toIndex` from the reorder
 * arrows — is therefore an index into THIS rendered order, not into the raw
 * unfiltered lane. Slot math that sorts the raw lane instead picks the wrong
 * neighbours whenever a status filter is active. These helpers are the single
 * source of truth so drag, hover-preview, no-op detection, and reorder all agree.
 */

export interface LaneAppt {
  id: string;
  scheduledStart: string;
  scheduledEnd: string;
  status?: string;
}

/** The sorted, status-filtered order exactly as TechnicianLane renders it. */
export function laneRenderOrder<T extends LaneAppt>(
  appointments: T[],
  statusFilter?: string,
): T[] {
  const filtered = statusFilter
    ? appointments.filter((a) => a.status === statusFilter)
    : appointments;
  return [...filtered].sort(
    (a, b) => new Date(a.scheduledStart).getTime() - new Date(b.scheduledStart).getTime(),
  );
}

/**
 * Convert a gap `insertIndex` (a position in the rendered order, which still
 * contains the dragged card for same-lane drags) into the list to pack against
 * — dragged removed — plus the insert index adjusted into that reduced list.
 *
 * When the dragged card sits before the target gap, removing it shifts every
 * later position down by one, so the insert index must decrement. Failing to do
 * this lands same-lane drops one slot late. For cross-lane drags the dragged id
 * isn't present, so the list is unchanged and the index passes through.
 */
export function resolveInsert<T extends LaneAppt>(
  renderOrder: T[],
  draggedId: string,
  rawInsertIndex: number,
): { withoutDragged: T[]; insertIndex: number } {
  const origIdx = renderOrder.findIndex((a) => a.id === draggedId);
  const withoutDragged = renderOrder.filter((a) => a.id !== draggedId);
  let insertIndex = rawInsertIndex;
  if (origIdx >= 0 && origIdx < rawInsertIndex) {
    insertIndex = rawInsertIndex - 1;
  }
  return { withoutDragged, insertIndex };
}

/**
 * True when dropping the dragged card at `rawInsertIndex` leaves it exactly
 * where it started. The gap immediately before the card (`origIdx`) and the gap
 * immediately after it (`origIdx + 1`) both mean "no move".
 */
export function isSameLaneNoOp<T extends LaneAppt>(
  renderOrder: T[],
  draggedId: string,
  rawInsertIndex: number,
): boolean {
  const origIdx = renderOrder.findIndex((a) => a.id === draggedId);
  if (origIdx < 0) return false;
  return rawInsertIndex === origIdx || rawInsertIndex === origIdx + 1;
}

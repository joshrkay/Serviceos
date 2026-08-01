import { bumpDispatchBoardRevision, boardDateFromAppointment } from './board-revision';
import { getDispatchBoardEventBus } from './board-event-bus';

export function notifyDispatchBoardChanged(
  tenantId: string,
  scheduledStart: Date,
  /**
   * The appointment's timezone. Publishes to the TENANT-LOCAL board date the
   * dispatcher subscribes by; omit only when no tz is available (falls back to
   * the UTC day, which mis-targets late-evening appointments in western zones).
   */
  timezone?: string,
): string {
  const date = boardDateFromAppointment(scheduledStart, timezone);
  const boardRevision = bumpDispatchBoardRevision(tenantId, date);
  getDispatchBoardEventBus().publishBoardUpdated(tenantId, date, boardRevision);
  return boardRevision;
}

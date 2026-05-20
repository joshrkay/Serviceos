import { bumpDispatchBoardRevision, boardDateFromAppointment } from './board-revision';
import { getDispatchBoardEventBus } from './board-event-bus';

export function notifyDispatchBoardChanged(
  tenantId: string,
  scheduledStart: Date,
): string {
  const date = boardDateFromAppointment(scheduledStart);
  const boardRevision = bumpDispatchBoardRevision(tenantId, date);
  getDispatchBoardEventBus().publishBoardUpdated(tenantId, date, boardRevision);
  return boardRevision;
}

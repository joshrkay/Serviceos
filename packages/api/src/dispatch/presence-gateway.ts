/**
 * Production wiring of the client-gateway's dispatch-presence seam (UC-3):
 * heartbeats land in the (possibly Redis-backed) presence store, visible
 * changes publish presence_updated on the board event bus (which the UC-4
 * mirror fans out across replicas), and reads/subscriptions come from the
 * same store/bus the HTTP + SSE paths use — one source of truth regardless of
 * transport.
 */
import type { DispatchPresenceGatewayDeps } from '../ws/client-gateway';
import { getDispatchBoardEventBus } from './board-event-bus';
import { getDispatchPresenceStore } from './presence-store';

export function createDispatchPresenceGatewayDeps(): DispatchPresenceGatewayDeps {
  return {
    update: async (input) => {
      const changed = await getDispatchPresenceStore().upsert({
        tenantId: input.tenantId,
        date: input.date,
        userId: input.userId,
        displayName: input.displayName,
        appointmentId: input.appointmentId,
        mode: input.mode,
      });
      // Publish only on visible change — a steady-state heartbeat must not
      // fan out into a board refetch per viewer (the UC-3 amplifier).
      if (changed) getDispatchBoardEventBus().publishPresenceUpdated(input.tenantId, input.date);
    },
    clear: async (input) => {
      const changed = await getDispatchPresenceStore().clear(
        input.tenantId,
        input.date,
        input.userId,
      );
      if (changed) getDispatchBoardEventBus().publishPresenceUpdated(input.tenantId, input.date);
    },
    list: async (tenantId, date) => {
      const entries = await getDispatchPresenceStore().list(tenantId, date);
      return entries.map(({ userId, displayName, appointmentId, mode }) => ({
        userId,
        displayName,
        appointmentId,
        mode,
      }));
    },
    subscribeBoard: (tenantId, date, listener) =>
      getDispatchBoardEventBus().subscribe(tenantId, date, listener),
  };
}

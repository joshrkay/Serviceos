/**
 * Dispatch-board event bus.
 *
 * Fan-out for board_updated / presence_updated events to the SSE route
 * (board-events-route.ts) and the WS gateway's per-connection dispatch
 * subscriptions. The in-process listener map is the synchronous same-replica
 * path — unchanged from the single-replica implementation.
 *
 * UC-4 (multi-replica): when a cross-instance transport is attached
 * (initDispatchBoardFanout, double-gated on REDIS_URL + DISPATCH_FANOUT_ENABLED
 * like the U3d voice fan-out), every locally published event is additionally
 * MIRRORED over Redis pub/sub, and events published by OTHER replicas are
 * injected into this replica's local listeners. Self-originated echoes are
 * dropped by replicaId (no double-fire); remote board_updated events also
 * merge their revision token into this replica's revision map so
 * GET /board answers agree across replicas. Unset/failed Redis is
 * byte-identical to today.
 */
import {
  createDispatchBoardEventTransport,
  DISPATCH_REPLICA_ID,
  type DispatchBoardEventTransport,
} from './board-fanout';
import {
  applyRemoteDispatchBoardRevision,
  enableOrderedDispatchBoardRevisions,
} from './board-revision';

export type DispatchBoardEvent =
  | { type: 'board_updated'; date: string; boardRevision: string }
  | { type: 'presence_updated'; date: string };

type Listener = (event: DispatchBoardEvent) => void;

function subKey(tenantId: string, date: string): string {
  return `${tenantId}:${date}`;
}

export interface DispatchBoardEventBusOptions {
  /** This bus's replica identity for self-origin dedup. Defaults to the
   *  per-process DISPATCH_REPLICA_ID; tests override it to simulate multiple
   *  replicas within one process. */
  replicaId?: string;
  /** Cross-instance transport. Omitted ⇒ no mirror (single-replica behavior). */
  transport?: DispatchBoardEventTransport;
}

export class DispatchBoardEventBus {
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly replicaId: string;
  private transport: DispatchBoardEventTransport | null = null;

  constructor(options: DispatchBoardEventBusOptions = {}) {
    this.replicaId = options.replicaId ?? DISPATCH_REPLICA_ID;
    if (options.transport) this.attachTransport(options.transport);
  }

  /**
   * Attach the cross-instance mirror. Local events are published to the
   * transport; remote events (other replicaIds only) are injected into the
   * local listeners, merging board revisions first so a subscriber's follow-up
   * GET /board on this replica sees the token it was just notified about.
   */
  attachTransport(transport: DispatchBoardEventTransport): void {
    this.transport = transport;
    transport.subscribe((env) => {
      if (env.replicaId === this.replicaId) return; // drop our own echo (no double-fire)
      if (env.event.type === 'board_updated') {
        applyRemoteDispatchBoardRevision(env.tenantId, env.event.date, env.event.boardRevision);
      }
      this.deliverLocal(env.tenantId, env.event);
    });
  }

  subscribe(tenantId: string, date: string, listener: Listener): () => void {
    const key = subKey(tenantId, date);
    let set = this.listeners.get(key);
    if (!set) {
      set = new Set();
      this.listeners.set(key, set);
    }
    set.add(listener);
    return () => {
      set?.delete(listener);
      if (set && set.size === 0) this.listeners.delete(key);
    };
  }

  publish(tenantId: string, event: DispatchBoardEvent): void {
    // Synchronous same-replica path first (unchanged), then the additive
    // best-effort mirror — transport.publish never throws by contract.
    this.deliverLocal(tenantId, event);
    this.transport?.publish({ replicaId: this.replicaId, tenantId, event });
  }

  private deliverLocal(tenantId: string, event: DispatchBoardEvent): void {
    const set = this.listeners.get(subKey(tenantId, event.date));
    if (!set) return;
    for (const listener of set) {
      // Isolate listeners: one throwing subscriber (e.g. an SSE write to a
      // dead socket) must not abort fan-out to its siblings or propagate
      // into the publisher's stack.
      try {
        listener(event);
      } catch (err) {
        process.stderr.write(
          `dispatch board listener failed: ${err instanceof Error ? err.message : String(err)}\n`
        );
      }
    }
  }

  publishBoardUpdated(tenantId: string, date: string, boardRevision: string): void {
    this.publish(tenantId, { type: 'board_updated', date, boardRevision });
  }

  publishPresenceUpdated(tenantId: string, date: string): void {
    this.publish(tenantId, { type: 'presence_updated', date });
  }
}

let singleton: DispatchBoardEventBus | null = null;

export function getDispatchBoardEventBus(): DispatchBoardEventBus {
  if (!singleton) singleton = new DispatchBoardEventBus();
  return singleton;
}

/**
 * Wire the cross-replica board fan-out at boot (app.ts). Double-gated like the
 * voice fan-out (U3d): callers pass REDIS_URL only when DISPATCH_FANOUT_ENABLED
 * is true. No URL ⇒ no-op — the bus and revision tokens behave exactly as on a
 * single replica.
 */
export function initDispatchBoardFanout(redisUrl?: string): void {
  if (!redisUrl) return;
  enableOrderedDispatchBoardRevisions(DISPATCH_REPLICA_ID);
  getDispatchBoardEventBus().attachTransport(createDispatchBoardEventTransport(redisUrl));
}

export type DispatchBoardEvent =
  | { type: 'board_updated'; date: string; boardRevision: string }
  | { type: 'presence_updated'; date: string };

type Listener = (event: DispatchBoardEvent) => void;

interface SubscriptionKey {
  tenantId: string;
  date: string;
}

function subKey(tenantId: string, date: string): string {
  return `${tenantId}:${date}`;
}

class DispatchBoardEventBus {
  private readonly listeners = new Map<string, Set<Listener>>();

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
    const set = this.listeners.get(subKey(tenantId, event.date));
    if (!set) return;
    for (const listener of set) {
      listener(event);
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

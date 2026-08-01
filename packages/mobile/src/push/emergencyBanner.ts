// Pure (RN-free) store for the Home emergency banner (U4 / B7). Holds the
// latest unacknowledged escalation/emergency notification that arrived while
// the app was foregrounded; Home subscribes and renders a high-urgency banner
// until the owner dismisses it (dismiss is client-local — see plan Open
// Question 5). Tapping a notification from the tray deep-links instead, so
// this store only covers the "arrived while I was already in the app" case
// the OS banner suppression would otherwise swallow.

export interface EmergencyAlert {
  data: Record<string, unknown>;
  receivedAt: number;
}

let current: EmergencyAlert | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const cb of listeners) cb();
}

/** Latest unacknowledged emergency, or null. Stable reference between events
 *  so useSyncExternalStore consumers don't re-render spuriously. */
export function currentEmergency(): EmergencyAlert | null {
  return current;
}

/** Raise (or replace — newest wins) the banner. */
export function raiseEmergency(data: Record<string, unknown>, now: number = Date.now()): void {
  current = { data, receivedAt: now };
  emit();
}

/** Owner acknowledged — clear the banner. */
export function dismissEmergency(): void {
  if (current === null) return;
  current = null;
  emit();
}

/** Subscribe to changes; returns the unsubscribe. */
export function subscribeEmergency(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Test helper — reset module state between tests. */
export function __resetEmergencyForTests(): void {
  current = null;
  listeners.clear();
}

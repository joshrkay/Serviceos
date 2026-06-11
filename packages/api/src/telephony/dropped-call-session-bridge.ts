/**
 * B5 MVP — maps caller phone → recent voice session so inbound SMS can
 * resume the same thread after a dropped-call recovery text.
 */
const TTL_MS = 24 * 60 * 60 * 1000;

interface BridgeEntry {
  tenantId: string;
  sessionId: string;
  expiresAt: number;
}

const byPhone = new Map<string, BridgeEntry>();

function normalizePhone(e164: string): string {
  return e164.replace(/\D/g, '');
}

function bridgeKey(tenantId: string, e164: string): string {
  return `${tenantId}:${normalizePhone(e164)}`;
}

export function registerDroppedCallSession(
  tenantId: string,
  callerE164: string,
  sessionId: string,
): void {
  if (!callerE164 || normalizePhone(callerE164).length < 7) return;
  byPhone.set(bridgeKey(tenantId, callerE164), {
    tenantId,
    sessionId,
    expiresAt: Date.now() + TTL_MS,
  });
}

export function lookupDroppedCallSession(
  tenantId: string,
  fromE164: string,
): string | undefined {
  const key = bridgeKey(tenantId, fromE164);
  const hit = byPhone.get(key);
  if (!hit || hit.expiresAt < Date.now()) {
    byPhone.delete(key);
    return undefined;
  }
  return hit.sessionId;
}

/** Test-only */
export function __clearDroppedCallSessionBridgeForTests(): void {
  byPhone.clear();
}

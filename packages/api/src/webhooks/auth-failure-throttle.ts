/**
 * Throttle for audit rows written on UNAUTHENTICATED webhook failures
 * (bad signature / no integration for the path tenant). Tenant ids are
 * public, so without a cap anyone could POST bad signatures to
 * /webhooks/twilio/*\/:tenantId and fill a victim tenant's audit trail at
 * the provider rate limit. One row per (tenant, reason, kind) per window
 * keeps the signal ("someone is hitting this tenant with bad signatures")
 * without letting the attacker choose the volume; the rest are counted and
 * reported on the next row that is let through.
 *
 * Per-process: with N replicas the bound is N rows per key per window.
 */
export interface AuthFailureThrottle {
  /** Returns null when the event should be suppressed, otherwise the number
   *  of events suppressed for this key since the last one let through. */
  admit(key: string, nowMs?: number): { suppressedSinceLast: number } | null;
}

export function createAuthFailureThrottle(
  opts: { windowMs: number; maxKeys: number },
): AuthFailureThrottle {
  // Insertion-ordered: the first entry is the least recently admitted, so
  // eviction drops the oldest key and memory stays bounded even when the
  // caller sprays random tenant ids.
  const entries = new Map<string, { admittedAt: number; suppressed: number }>();

  return {
    admit(key, nowMs = Date.now()) {
      const entry = entries.get(key);
      if (entry && nowMs - entry.admittedAt < opts.windowMs) {
        entry.suppressed += 1;
        return null;
      }
      const suppressedSinceLast = entry?.suppressed ?? 0;
      entries.delete(key);
      entries.set(key, { admittedAt: nowMs, suppressed: 0 });
      if (entries.size > opts.maxKeys) {
        const oldest = entries.keys().next().value;
        if (oldest !== undefined) entries.delete(oldest);
      }
      return { suppressedSinceLast };
    },
  };
}

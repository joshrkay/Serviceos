/**
 * B1 — Per-tenant voice persona resolver with TTL cache.
 *
 * Follows the same pattern as `threshold-resolver.ts`:
 *   - One `findByTenant` DB hit per session start, amortised to near-zero
 *     by a 60-second in-process LRU cache.
 *   - Failure-open: a settings-lookup failure returns `null` so the
 *     adapter falls back to the default greeting without crashing the call.
 *
 * `VoicePersona` is the shared type consumed by both adapters. Using a
 * single canonical type here avoids the three inline duplicates that
 * existed before this module was extracted.
 */

import type { SettingsRepository } from './settings';

/** Resolved per-tenant voice persona fields. */
export interface VoicePersona {
  /**
   * Agent name injected into the default greeting template.
   * e.g. "Alex" → "Hi, I'm Alex. How can I help today?"
   */
  agentName?: string;
  /**
   * Fully-custom greeting text. When set, this replaces the entire
   * default opener (including any "How can I help?" CTA) for the
   * in-app channel. For telephony the recording-disclosure sentence
   * is always appended afterward (compliance requirement) but no
   * other text is added — the tenant owns the complete opening line.
   */
  greeting?: string;
}

export type VoicePersonaResolver = (tenantId: string) => Promise<VoicePersona | null>;

interface CacheEntry {
  persona: VoicePersona | null;
  expiresAt: number;
}

export interface VoicePersonaResolverOptions {
  /** Cache TTL in milliseconds. Defaults to 60_000 (1 minute). 0 disables caching. */
  ttlMs?: number;
  /**
   * Maximum cache entries (LRU eviction). Defaults to 1000.
   */
  maxEntries?: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

const DEFAULT_TTL_MS = 60_000;
const DEFAULT_MAX_ENTRIES = 1000;

export function createVoicePersonaResolver(
  settingsRepo: SettingsRepository,
  options: VoicePersonaResolverOptions = {},
): VoicePersonaResolver {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const now = options.now ?? Date.now;
  const cache = new Map<string, CacheEntry>();

  return async (tenantId: string): Promise<VoicePersona | null> => {
    if (!tenantId) return null;

    if (ttlMs > 0) {
      const hit = cache.get(tenantId);
      if (hit && hit.expiresAt > now()) {
        cache.delete(tenantId);
        cache.set(tenantId, hit);
        return hit.persona;
      }
    }

    let persona: VoicePersona | null = null;
    try {
      const settings = await settingsRepo.findByTenant(tenantId);
      if (settings) {
        const result: VoicePersona = {};
        if (settings.voiceAgentName) result.agentName = settings.voiceAgentName;
        if (settings.voiceGreeting) result.greeting = settings.voiceGreeting;
        if (Object.keys(result).length > 0) persona = result;
      }
    } catch {
      persona = null;
    }

    if (ttlMs > 0) {
      cache.delete(tenantId);
      cache.set(tenantId, { persona, expiresAt: now() + ttlMs });
      while (cache.size > maxEntries) {
        const oldest = cache.keys().next().value;
        if (oldest === undefined) break;
        cache.delete(oldest);
      }
    }

    return persona;
  };
}

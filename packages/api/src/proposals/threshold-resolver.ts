/**
 * Tier 4 (AI approval rules — PR B: connect-the-wire).
 *
 * Loads `tenant_settings.auto_approve_threshold` and feeds it into
 * `createProposal` so the per-tenant override actually affects the
 * threshold decision. PR A persisted the value through the Settings
 * UI ↔ DB; this module bridges it into the proposal hot path.
 *
 * Why a dedicated resolver:
 *   - `createProposal` is synchronous; settings lookups are async.
 *     The resolver lives at the entry-point layer (telephony adapter,
 *     in-app adapter, voice-action-router, onboarding orchestrator)
 *     where one extra await is acceptable; passes the resolved
 *     override through the existing `tenantThresholdOverride` field
 *     on `CreateProposalInput`. Internal task handlers are
 *     pass-through and don't need changes.
 *
 *   - Settings rarely change. A small in-process TTL cache keyed by
 *     tenantId avoids one DB hit per proposal turn while keeping the
 *     surface stateless from a test perspective. Default TTL 60s —
 *     short enough that admins see edits reflected in normal feedback
 *     loops, long enough to coalesce repeated lookups during a single
 *     voice call.
 *
 * Failure mode: a settings-lookup failure must not block proposal
 * creation. The resolver returns `undefined` on any error; callers
 * receive the locked product defaults from
 * `DEFAULT_AUTO_APPROVE_THRESHOLDS`, matching legacy behavior.
 */

import type { SettingsRepository } from '../settings/settings';
import type { Mode } from './auto-approve';

export type ThresholdOverride = Partial<Record<Mode, number>>;

export type ThresholdResolver = (tenantId: string) => Promise<ThresholdOverride | undefined>;

interface CacheEntry {
  override: ThresholdOverride | undefined;
  expiresAt: number;
}

export interface ThresholdResolverOptions {
  /** Cache TTL in milliseconds. Defaults to 60_000 (1 minute). 0 disables caching. */
  ttlMs?: number;
  /**
   * Maximum cache entries (LRU eviction). Defaults to 1000 — enough for
   * realistic multi-tenant deployments without unbounded memory growth.
   * Gemini code review (PR #316): the prior unbounded Map could leak
   * memory in tenants-many environments since expired entries are never
   * removed unless the same tenantId is re-resolved after the TTL. The
   * LRU bound caps the high-water mark regardless of access patterns.
   */
  maxEntries?: number;
  /** Injectable clock for tests. Defaults to Date.now. */
  now?: () => number;
}

const DEFAULT_TTL_MS = 60_000;
const DEFAULT_MAX_ENTRIES = 1000;

export function createThresholdResolver(
  settingsRepo: SettingsRepository,
  options: ThresholdResolverOptions = {},
): ThresholdResolver {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const now = options.now ?? Date.now;
  // Insertion-order Map doubles as a cheap LRU when we re-insert on
  // hit and evict from the front when the size cap is exceeded.
  const cache = new Map<string, CacheEntry>();

  return async (tenantId: string): Promise<ThresholdOverride | undefined> => {
    if (!tenantId) return undefined;
    if (ttlMs > 0) {
      const hit = cache.get(tenantId);
      if (hit && hit.expiresAt > now()) {
        // Bump to the back of the LRU on hit.
        cache.delete(tenantId);
        cache.set(tenantId, hit);
        return hit.override;
      }
    }

    let override: ThresholdOverride | undefined;
    try {
      const settings = await settingsRepo.findByTenant(tenantId);
      // Empty / missing override surfaces as undefined per
      // PgSettingsRepository.mapRow, so the proposal layer falls
      // through to DEFAULT_AUTO_APPROVE_THRESHOLDS.
      override = settings?.autoApproveThreshold;
    } catch {
      // Best-effort: a settings-lookup hiccup must not block proposal
      // creation. Cache `undefined` for the TTL window so we don't
      // hammer the DB while it's degraded.
      override = undefined;
    }

    if (ttlMs > 0) {
      // Replace any stale entry, then evict the LRU head if we're
      // over capacity. Map iteration order is insertion-order, so
      // map.keys().next().value is the oldest entry.
      cache.delete(tenantId);
      cache.set(tenantId, { override, expiresAt: now() + ttlMs });
      while (cache.size > maxEntries) {
        const oldest = cache.keys().next().value;
        if (oldest === undefined) break;
        cache.delete(oldest);
      }
    }
    return override;
  };
}

/**
 * No-op resolver. Useful for tests and code paths that don't have a
 * settings repo wired (e.g. legacy harnesses). Always returns
 * `undefined`, mirroring the locked-defaults behavior that shipped
 * before PR B.
 */
export const noopThresholdResolver: ThresholdResolver = async () => undefined;

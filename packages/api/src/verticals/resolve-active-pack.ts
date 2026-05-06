/**
 * §3B helper — build a `verticalPromptResolver` for the calling agent
 * adapters. The returned function takes a tenantId and produces the
 * prompt-shaped section the classifier injects as a system message
 * (see `formatVerticalForCallerPrompt`).
 *
 * Lookup chain:
 *   tenantId
 *   → packActivationRepo.findByTenant → most recently activated active pack
 *   → canonicalPackRegistry.getByPackId → canonical VerticalPack (metadata blob)
 *   → adapt to the rich VerticalPack shape (terminology + categories live in
 *     `metadata` on the canonical pack; the rich shape used by the
 *     `verticals/registry.ts` consumer surfaces them as top-level fields)
 *   → formatVerticalForCallerPrompt → string | undefined
 *
 * Returns undefined when the tenant has no active pack, the pack is
 * missing, or the pack has no terminology/categories — the classifier
 * falls back to its base prompt rather than failing the turn.
 *
 * Caching (PR #315 review): the resolver runs on every classifier
 * call, which on telephony media-streams is potentially every caller
 * utterance. The pack rarely changes mid-call, so the resolved
 * section is memoized per-tenant with a short TTL. Both repo lookups
 * share the cache; cache misses fall back to the durable lookup.
 */

import type { PackActivationRepository } from '../settings/pack-activation';
import type { VerticalPackRegistry, VerticalPack as CanonicalVerticalPack } from '../shared/vertical-pack-registry';
import { isValidVerticalType } from '../shared/vertical-types';
import {
  formatVerticalForCallerPrompt,
  formatIntakeQuestionsForPrompt,
  formatObjectionScriptsForPrompt,
} from './context-assembly';
import type {
  IntakeQuestionList,
  ObjectionScriptList,
  ServiceCategory,
  TerminologyMap,
  VerticalPack,
} from './registry';

export interface ResolveActivePackDeps {
  packActivationRepo: PackActivationRepository;
  canonicalPackRegistry: VerticalPackRegistry;
  /**
   * Cache TTL in milliseconds. Defaults to 5 minutes — short enough
   * that a pack change appears to admins within a normal feedback
   * loop, long enough that a single in-progress call sees consistent
   * terminology across turns. Set to 0 to disable caching (tests).
   */
  cacheTtlMs?: number;
  /**
   * Maximum cache entries (LRU eviction). Defaults to 1000. Mirrors
   * the threshold-resolver bound — prevents unbounded memory growth
   * in tenants-many environments.
   */
  maxCacheEntries?: number;
  /** Injectable clock for tests. Defaults to Date.now. */
  now?: () => number;
}

interface CacheEntry {
  section: string | undefined;
  expiresAt: number;
}

const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_CACHE_ENTRIES = 1000;

export function buildVerticalPromptResolver(
  deps: ResolveActivePackDeps,
): (tenantId: string) => Promise<string | undefined> {
  const ttlMs = deps.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const maxEntries = deps.maxCacheEntries ?? DEFAULT_MAX_CACHE_ENTRIES;
  const now = deps.now ?? Date.now;
  const cache = new Map<string, CacheEntry>();

  return async (tenantId: string): Promise<string | undefined> => {
    if (ttlMs > 0) {
      const hit = cache.get(tenantId);
      if (hit && hit.expiresAt > now()) {
        // Bump to back of LRU on hit.
        cache.delete(tenantId);
        cache.set(tenantId, hit);
        return hit.section;
      }
    }

    const activations = await deps.packActivationRepo.findByTenant(tenantId);
    // Codex P2 (PR #315): pick the most recently activated active pack
    // explicitly. InMemoryPackActivationRepository preserves insertion
    // order while PgPackActivationRepository orders by activated_at
    // DESC; relying on the implicit "first active" returns different
    // packs in dev vs. prod when a tenant has multiple active packs
    // and silently misclassifies the same utterance.
    const active = activations
      .filter((a) => a.status === 'active')
      .sort((a, b) => b.activatedAt.getTime() - a.activatedAt.getTime())[0];

    let section: string | undefined;
    if (active) {
      const canonical = await resolveCanonicalPack(active.packId, deps.canonicalPackRegistry);
      // Codex P2 (PR #315): reject canonical packs whose registry status
      // is not 'active'. A pack can be deprecated in the registry while
      // tenant activations remain active; loadPackConfig already enforces
      // this gate, and bypassing it here would feed deprecated taxonomy
      // into the live classifier.
      if (canonical && canonical.status === 'active') {
        const metadata = (canonical.metadata ?? {}) as Record<string, unknown>;
        const terminology = (metadata.terminology as TerminologyMap | undefined) ?? {};
        const categories = (metadata.categories as ServiceCategory[] | undefined) ?? [];
        // §3D — surface intake_questions onto the rich pack so the
        // formatter (or downstream consumers) can render them.
        const intakeQuestions = (metadata.intake_questions as IntakeQuestionList | undefined);
        // §3E — surface objection_scripts onto the rich pack.
        const objectionScripts = (metadata.objection_scripts as ObjectionScriptList | undefined);

        const richPack: VerticalPack = {
          ...canonical,
          name: canonical.displayName,
          type: canonical.verticalType,
          isActive: canonical.status === 'active',
          terminology,
          categories,
          ...(intakeQuestions && intakeQuestions.length > 0
            ? { intakeQuestions }
            : {}),
          ...(objectionScripts && objectionScripts.length > 0
            ? { objectionScripts }
            : {}),
        };

        // §3B + §3D + §3E combined: render the vertical block, intake
        // questions, and objection scripts as one section. All three
        // come from the same pack so we emit them together in a single
        // classifier system message rather than splitting; the model
        // sees them as one coherent tenant-vertical context.
        const verticalBlock = formatVerticalForCallerPrompt(richPack);
        const intakeBlock = formatIntakeQuestionsForPrompt(richPack);
        const objectionBlock = formatObjectionScriptsForPrompt(richPack);
        const formatted = [verticalBlock, intakeBlock, objectionBlock]
          .filter((s) => s.length > 0)
          .join('\n\n');
        section = formatted.length > 0 ? formatted : undefined;
      }
    }

    if (ttlMs > 0) {
      cache.delete(tenantId);
      cache.set(tenantId, { section, expiresAt: now() + ttlMs });
      while (cache.size > maxEntries) {
        const oldest = cache.keys().next().value;
        if (oldest === undefined) break;
        cache.delete(oldest);
      }
    }
    return section;
  };
}

/**
 * Codex P1 (PR #315) — packId convention reconciliation.
 *
 * Three packId conventions exist in the codebase today:
 *   - Onboarding (`routes/onboarding.ts`) activates 'hvac' / 'plumbing'
 *     directly off the SERVICE_TO_PACK map.
 *   - `seedCanonicalVerticalPacks` registers 'hvac-v1' / 'plumbing-v1'.
 *   - `createVerticalPack` (rich pack helper) builds packId '{type}-pack'.
 *
 * An exact `getByPackId(activation.packId)` lookup misses any tenant
 * onboarded through the standard flow because their activation row
 * carries 'hvac' but the registry has 'hvac-v1'. Without this
 * reconciliation, the resolver returned undefined for every onboarded
 * tenant and the §3B/3D/3E classifier-context path was silently dead.
 *
 * Resolution order:
 *   1. Exact packId match (fast path, also picks up custom packs).
 *   2. If activation.packId is itself a valid VerticalType (eg 'hvac'),
 *      fall back to findByVertical(verticalType) and pick the most
 *      recently updated active pack — typically the canonical seed.
 */
async function resolveCanonicalPack(
  activationPackId: string,
  registry: VerticalPackRegistry,
): Promise<CanonicalVerticalPack | null> {
  const exact = await registry.getByPackId(activationPackId);
  if (exact) return exact;

  if (isValidVerticalType(activationPackId)) {
    const candidates = await registry.findByVertical(activationPackId);
    const active = candidates
      .filter((p) => p.status === 'active')
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())[0];
    return active ?? null;
  }
  return null;
}

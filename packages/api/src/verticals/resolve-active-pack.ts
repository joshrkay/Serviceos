/**
 * §3B helper — build a `verticalPromptResolver` for the calling agent
 * adapters. The returned function takes a tenantId and produces the
 * prompt-shaped section the classifier injects as a system message
 * (see `formatVerticalForCallerPrompt`).
 *
 * Lookup chain:
 *   tenantId
 *   → packActivationRepo.findByTenant → first activation with status 'active'
 *   → canonicalPackRegistry.getByPackId → canonical VerticalPack (metadata blob)
 *   → adapt to the rich VerticalPack shape (terminology + categories live in
 *     `metadata` on the canonical pack; the rich shape used by the
 *     `verticals/registry.ts` consumer surfaces them as top-level fields)
 *   → formatVerticalForCallerPrompt → string | undefined
 *
 * Returns undefined when the tenant has no active pack, the pack is
 * missing, or the pack has no terminology/categories — the classifier
 * falls back to its base prompt rather than failing the turn.
 */

import type { PackActivationRepository } from '../settings/pack-activation';
import type { VerticalPackRegistry } from '../shared/vertical-pack-registry';
import { formatVerticalForCallerPrompt } from './context-assembly';
import type {
  ServiceCategory,
  TerminologyMap,
  VerticalPack,
} from './registry';

export interface ResolveActivePackDeps {
  packActivationRepo: PackActivationRepository;
  canonicalPackRegistry: VerticalPackRegistry;
}

export function buildVerticalPromptResolver(
  deps: ResolveActivePackDeps,
): (tenantId: string) => Promise<string | undefined> {
  return async (tenantId: string): Promise<string | undefined> => {
    const activations = await deps.packActivationRepo.findByTenant(tenantId);
    const active = activations.find((a) => a.status === 'active');
    if (!active) return undefined;

    const canonical = await deps.canonicalPackRegistry.getByPackId(active.packId);
    if (!canonical) return undefined;

    const metadata = (canonical.metadata ?? {}) as Record<string, unknown>;
    const terminology = (metadata.terminology as TerminologyMap | undefined) ?? {};
    const categories = (metadata.categories as ServiceCategory[] | undefined) ?? [];

    const richPack: VerticalPack = {
      ...canonical,
      name: canonical.displayName,
      type: canonical.verticalType,
      isActive: canonical.status === 'active',
      terminology,
      categories,
    };

    const section = formatVerticalForCallerPrompt(richPack);
    return section.length > 0 ? section : undefined;
  };
}

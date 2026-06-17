import { v4 as uuidv4 } from 'uuid';
import { VerticalPackRegistry, VerticalPack } from './vertical-pack-registry';
import { createHvacPack } from '../verticals/packs/hvac';
import { createPlumbingPack } from '../verticals/packs/plumbing';
import { createElectricalPack } from '../verticals/packs/electrical';
import { createPaintingPack } from '../verticals/packs/painting';

/**
 * Adapt a rich pack (from `verticals/packs/{hvac,plumbing,electrical}.ts`) into
 * the canonical shape stored by the registry. The rich pack already
 * carries terminology / categories / intake_questions / objection_scripts
 * in `metadata` (see `createVerticalPack` in `verticals/registry.ts`),
 * which means downstream consumers like `buildVerticalPromptResolver`
 * can read them on lookup.
 *
 * Codex P1 (PR #315) — without this, canonical packs were seeded
 * thin (only `{ canonical: true, seededBy: 'createApp' }` in metadata)
 * and the §3B/3D/3E classifier-context path produced an empty section
 * for every tenant. The resolver now sees the same rich metadata
 * `loadPackConfig` derives at runtime.
 */
type RichCanonicalPack =
  | ReturnType<typeof createHvacPack>
  | ReturnType<typeof createPlumbingPack>
  | ReturnType<typeof createElectricalPack>
  | ReturnType<typeof createPaintingPack>;

function adaptToCanonical(packId: string, rich: RichCanonicalPack): VerticalPack {
  const now = new Date();
  return {
    id: uuidv4(),
    packId,
    version: rich.version,
    verticalType: rich.verticalType,
    status: 'active',
    displayName: rich.displayName,
    description: rich.description,
    // Preserve rich metadata (terminology / categories / intake_questions /
    // objection_scripts) but flag the canonical origin for diagnostics.
    metadata: {
      ...(rich.metadata ?? {}),
      canonical: true,
      seededBy: 'createApp',
    },
    createdAt: now,
    updatedAt: now,
  };
}

export async function seedCanonicalVerticalPacks(registry: VerticalPackRegistry): Promise<void> {
  await Promise.all([
    registry.register(adaptToCanonical('hvac-v1', createHvacPack())).catch((err) => {
      process.stderr.write(`[seed] Failed to register hvac-v1 pack: ${err instanceof Error ? err.message : String(err)}\n`);
    }),
    registry.register(adaptToCanonical('plumbing-v1', createPlumbingPack())).catch((err) => {
      process.stderr.write(`[seed] Failed to register plumbing-v1 pack: ${err instanceof Error ? err.message : String(err)}\n`);
    }),
    registry.register(adaptToCanonical('electrical-v1', createElectricalPack())).catch((err) => {
      process.stderr.write(`[seed] Failed to register electrical-v1 pack: ${err instanceof Error ? err.message : String(err)}\n`);
    }),
    registry.register(adaptToCanonical('painting-v1', createPaintingPack())).catch((err) => {
      process.stderr.write(`[seed] Failed to register painting-v1 pack: ${err instanceof Error ? err.message : String(err)}\n`);
    }),
  ]);
}

import { describe, it, expect } from 'vitest';
import { seedCanonicalVerticalPacks } from '../../src/shared/canonical-vertical-packs';
import { InMemoryVerticalPackRegistry, type VerticalPack } from '../../src/shared/vertical-pack-registry';

function staleCanonicalPack(overrides: Partial<VerticalPack> = {}): VerticalPack {
  const now = new Date('2026-05-15T00:00:00Z');
  return {
    id: 'stale-hvac-pack',
    packId: 'hvac-v1',
    version: '1.0.0',
    verticalType: 'hvac',
    status: 'active',
    displayName: 'HVAC Professional',
    description: 'Stale canonical HVAC pack',
    metadata: {
      canonical: true,
      seededBy: 'createApp',
    },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('seedCanonicalVerticalPacks (§3B/3D/3E P1 fix)', () => {
  it('seeds canonical hvac-v1 with rich metadata (terminology, categories, intake_questions, objection_scripts)', async () => {
    const registry = new InMemoryVerticalPackRegistry();
    seedCanonicalVerticalPacks(registry);
    // Allow the fire-and-forget register() promises to resolve.
    await new Promise((r) => setImmediate(r));

    const hvac = await registry.getByPackId('hvac-v1');
    expect(hvac).not.toBeNull();
    expect(hvac!.verticalType).toBe('hvac');
    expect(hvac!.status).toBe('active');

    const meta = hvac!.metadata as Record<string, unknown>;
    // Codex P1 #2 — without rich metadata the resolver returned an
    // empty section. These four keys are the contract the resolver
    // depends on; if any goes missing, the §3B/3D/3E path silently
    // produces no classifier context.
    expect(meta.terminology).toBeDefined();
    expect(Object.keys(meta.terminology as Record<string, unknown>).length).toBeGreaterThan(0);
    expect(Array.isArray(meta.categories)).toBe(true);
    expect((meta.categories as unknown[]).length).toBeGreaterThan(0);
    expect(Array.isArray(meta.intake_questions)).toBe(true);
    expect((meta.intake_questions as unknown[]).length).toBeGreaterThan(0);
    expect(Array.isArray(meta.objection_scripts)).toBe(true);
    expect((meta.objection_scripts as unknown[]).length).toBeGreaterThan(0);

    // Diagnostic markers preserved.
    expect(meta.canonical).toBe(true);
    expect(meta.seededBy).toBe('createApp');
  });

  it('seeds canonical plumbing-v1 with rich metadata', async () => {
    const registry = new InMemoryVerticalPackRegistry();
    seedCanonicalVerticalPacks(registry);
    await new Promise((r) => setImmediate(r));

    const plumb = await registry.getByPackId('plumbing-v1');
    expect(plumb).not.toBeNull();
    expect(plumb!.verticalType).toBe('plumbing');
    const meta = plumb!.metadata as Record<string, unknown>;
    expect(meta.terminology).toBeDefined();
    expect(meta.objection_scripts).toBeDefined();
  });

  it('the seeded packs are discoverable via findByVertical for the onboarding-alias activation path', async () => {
    // Codex P1 #1 — the resolver falls back to findByVertical when
    // activation.packId is a VerticalType alias (e.g. "hvac"). Smoke
    // test: the seed registers under hvac-v1 but findByVertical("hvac")
    // surfaces it.
    const registry = new InMemoryVerticalPackRegistry();
    seedCanonicalVerticalPacks(registry);
    await new Promise((r) => setImmediate(r));
    const hvacPacks = await registry.findByVertical('hvac');
    expect(hvacPacks.length).toBeGreaterThan(0);
    expect(hvacPacks[0].packId).toBe('hvac-v1');
  });

  it('refreshes an existing canonical hvac-v1 row with current training metadata', async () => {
    const registry = new InMemoryVerticalPackRegistry();
    await registry.register(staleCanonicalPack());

    await seedCanonicalVerticalPacks(registry);

    const hvac = await registry.getByPackId('hvac-v1');
    expect(hvac).not.toBeNull();
    const meta = hvac!.metadata as Record<string, unknown>;
    expect(meta.training_tier).toBe('first_class');
    expect(meta.training_assets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          assetKind: 'emergency_rule',
          title: 'No heat extreme weather escalation',
        }),
      ]),
    );
    expect(meta.canonical).toBe(true);
    expect(meta.seededBy).toBe('createApp');
  });

  it('seeds electrical-v1 with second-class canonical training metadata', async () => {
    const registry = new InMemoryVerticalPackRegistry();

    await seedCanonicalVerticalPacks(registry);

    const electrical = await registry.getByPackId('electrical-v1');
    expect(electrical).not.toBeNull();
    expect(electrical!.verticalType).toBe('electrical');
    const meta = electrical!.metadata as Record<string, unknown>;
    expect(meta.training_tier).toBe('second_class');
    expect(meta.training_assets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          assetKind: 'emergency_rule',
          title: 'Electrical burning smell escalation',
        }),
      ]),
    );
    expect(meta.canonical).toBe(true);
    expect(meta.seededBy).toBe('createApp');
  });

  it('seeds painting-v1 with second-class canonical training metadata', async () => {
    const registry = new InMemoryVerticalPackRegistry();

    await seedCanonicalVerticalPacks(registry);

    const painting = await registry.getByPackId('painting-v1');
    expect(painting).not.toBeNull();
    expect(painting!.verticalType).toBe('painting');
    expect(painting!.status).toBe('active');

    const meta = painting!.metadata as Record<string, unknown>;
    // Same four-key contract the resolver depends on (terminology /
    // categories / intake_questions / objection_scripts).
    expect(meta.terminology).toBeDefined();
    expect(Object.keys(meta.terminology as Record<string, unknown>).length).toBeGreaterThan(0);
    expect(Array.isArray(meta.categories)).toBe(true);
    expect((meta.categories as unknown[]).length).toBeGreaterThanOrEqual(7);
    expect(Array.isArray(meta.intake_questions)).toBe(true);
    expect((meta.intake_questions as unknown[]).length).toBeGreaterThan(0);
    expect(Array.isArray(meta.objection_scripts)).toBe(true);
    expect((meta.objection_scripts as unknown[]).length).toBeGreaterThan(0);

    expect(meta.training_tier).toBe('second_class');
    expect(meta.training_assets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          assetKind: 'intake_question',
          title: 'Pre-1978 lead-paint check',
        }),
      ]),
    );
    expect(meta.canonical).toBe(true);
    expect(meta.seededBy).toBe('createApp');
  });

  it('findByVertical("painting") surfaces the seeded painting-v1 pack', async () => {
    const registry = new InMemoryVerticalPackRegistry();
    seedCanonicalVerticalPacks(registry);
    await new Promise((r) => setImmediate(r));
    const paintingPacks = await registry.findByVertical('painting');
    expect(paintingPacks.length).toBeGreaterThan(0);
    expect(paintingPacks[0].packId).toBe('painting-v1');
  });
});

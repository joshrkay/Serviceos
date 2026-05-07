import { describe, it, expect } from 'vitest';
import { seedCanonicalVerticalPacks } from '../../src/shared/canonical-vertical-packs';
import { InMemoryVerticalPackRegistry } from '../../src/shared/vertical-pack-registry';

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
});

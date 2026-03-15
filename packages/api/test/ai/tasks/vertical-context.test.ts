import { buildVerticalContextBlock, buildTerminologyContextBlock, assembleVerticalContext, formatTerminologyForPrompt } from '../../../src/ai/tasks/vertical-context';
import { LoadedVerticalPack } from '../../../src/verticals/vertical-loader';
import { createVerticalPack } from '../../../src/verticals/vertical-pack';
import { createTerminologyMap } from '../../../src/verticals/terminology-map';
import { createServiceTaxonomy } from '../../../src/verticals/service-taxonomy';
import { hvacTerminologyEntries } from '../../../src/verticals/data/hvac-terminology';
import { hvacCategories } from '../../../src/verticals/data/hvac-taxonomy';

describe('P4-009A — Vertical-aware context assembly', () => {
  function makeLoadedPack(): LoadedVerticalPack {
    const terminology = createTerminologyMap({ verticalSlug: 'hvac', version: '1.0.0', entries: hvacTerminologyEntries });
    const taxonomy = createServiceTaxonomy({ verticalSlug: 'hvac', version: '1.0.0', categories: hvacCategories });
    const pack = createVerticalPack({
      slug: 'hvac', name: 'HVAC', version: '1.0.0', description: 'HVAC vertical pack',
      terminologyMapId: terminology.id, taxonomyId: taxonomy.id,
    });
    return { pack, terminology, taxonomy };
  }

  it('happy path — builds vertical context block', () => {
    const loaded = makeLoadedPack();
    const block = buildVerticalContextBlock(loaded);
    expect(block.type).toBe('vertical_pack');
    expect(block.source).toBe('hvac');
    expect(block.content).toContain('HVAC');
    expect(block.priority).toBe(10);
  });

  it('happy path — builds terminology context block', () => {
    const loaded = makeLoadedPack();
    const block = buildTerminologyContextBlock(loaded.terminology);
    expect(block.type).toBe('terminology');
    expect(block.content).toContain('SEER');
  });

  it('happy path — assembleVerticalContext returns blocks', async () => {
    const loaded = makeLoadedPack();
    const mockLoader = { loadBySlug: async (slug: string) => slug === 'hvac' ? loaded : null };
    const blocks = await assembleVerticalContext('tenant-1', 'hvac', mockLoader);
    expect(blocks).toHaveLength(2);
  });

  it('validation — formatTerminologyForPrompt formats entries', () => {
    const result = formatTerminologyForPrompt([
      { term: 'SEER', aliases: ['seer rating'], definition: 'Efficiency metric', category: 'efficiency' },
    ]);
    expect(result).toContain('SEER');
    expect(result).toContain('seer rating');
  });

  it('mock provider test — assembleVerticalContext returns empty for unknown slug', async () => {
    const mockLoader = { loadBySlug: async () => null };
    const blocks = await assembleVerticalContext('tenant-1', 'unknown', mockLoader);
    expect(blocks).toEqual([]);
  });

  it('malformed AI output handled gracefully — empty terminology entries', () => {
    const result = formatTerminologyForPrompt([]);
    expect(result).toBe('');
  });
});

import {
  buildSourceContext,
  ContextRepositories,
  VerticalConfigResult,
} from '../../src/ai/orchestration/context-builder';

describe('P4-009A — Vertical-aware context assembly', () => {
  it('happy path — context includes HVAC vertical data when active', async () => {
    const repos: ContextRepositories = {
      getActiveVerticalConfigs: async (): Promise<VerticalConfigResult[]> => ([
        {
          type: 'hvac',
          packId: 'hvac-v1',
          terminology: { furnace: { canonical: 'furnace' } },
          categories: [{ id: 'diagnostic', name: 'Diagnostic' }],
        },
      ]),
    };

    const context = await buildSourceContext('t1', undefined, {}, repos);
    expect(context.verticals).toBeDefined();
    expect(context.verticals).toHaveLength(1);
    expect(context.verticals![0].type).toBe('hvac');
    expect(context.verticals![0].packId).toBe('hvac-v1');
    expect(context.verticals![0].terminology).toBeDefined();
    expect(context.verticals![0].categories).toBeDefined();
  });

  it('happy path — context includes plumbing vertical data when active', async () => {
    const repos: ContextRepositories = {
      getActiveVerticalConfigs: async (): Promise<VerticalConfigResult[]> => ([
        {
          type: 'plumbing',
          packId: 'plumbing-v1',
          terminology: { pipe: { canonical: 'pipe' } },
          categories: [{ id: 'drain', name: 'Drain Service' }],
        },
      ]),
    };

    const context = await buildSourceContext('t1', undefined, {}, repos);
    expect(context.verticals).toBeDefined();
    expect(context.verticals).toHaveLength(1);
    expect(context.verticals![0].type).toBe('plumbing');
    expect(context.verticals![0].packId).toBe('plumbing-v1');
  });

  it('happy path — no vertical leaves context unchanged', async () => {
    const repos: ContextRepositories = {};

    const context = await buildSourceContext('t1', undefined, {}, repos);
    expect(context.verticals).toBeUndefined();
  });

  it('happy path — empty vertical config list leaves context unchanged', async () => {
    const repos: ContextRepositories = {
      getActiveVerticalConfigs: async () => [],
    };

    const context = await buildSourceContext('t1', undefined, {}, repos);
    expect(context.verticals).toBeUndefined();
  });

  it('happy path — context includes HVAC + plumbing with deterministic ordering', async () => {
    const repos: ContextRepositories = {
      getActiveVerticalConfigs: async (): Promise<VerticalConfigResult[]> => ([
        {
          type: 'plumbing',
          packId: 'plumbing-v1',
          terminology: { pipe: { canonical: 'pipe' } },
          categories: [{ id: 'drain', name: 'Drain Service' }],
        },
        {
          type: 'hvac',
          packId: 'hvac-v1',
          terminology: { furnace: { canonical: 'furnace' } },
          categories: [{ id: 'diagnostic', name: 'Diagnostic' }],
        },
      ]),
      getTenantInfo: async () => ({ name: 'Test Co', settings: {} }),
    };

    const context = await buildSourceContext('t1', undefined, {}, repos);
    expect(context.tenant).toBeDefined();
    expect(context.verticals).toBeDefined();
    expect(context.verticals).toHaveLength(2);
    expect(context.verticals!.map((v) => v.type)).toEqual(['hvac', 'plumbing']);
  });

  it('malformed AI output handled gracefully — error in vertical config', async () => {
    const repos: ContextRepositories = {
      getActiveVerticalConfigs: async () => {
        throw new Error('Config loading failed');
      },
    };

    const context = await buildSourceContext('t1', undefined, {}, repos);
    // Should not throw, verticals just won't be set
    expect(context.verticals).toBeUndefined();
  });
});

import {
  buildSourceContext,
  ContextRepositories,
  VerticalConfigResult,
} from '../../src/ai/orchestration/context-builder';

describe('P4-009A — Vertical-aware context assembly', () => {
  it('happy path — context includes vertical data when active', async () => {
    const repos: ContextRepositories = {
      getActiveVerticalConfig: async (): Promise<VerticalConfigResult> => ({
        type: 'hvac',
        packId: 'hvac-v1',
        terminology: { furnace: { canonical: 'furnace' } },
        categories: [{ id: 'diagnostic', name: 'Diagnostic' }],
      }),
    };

    const context = await buildSourceContext('t1', undefined, {}, repos);
    expect(context.vertical).toBeDefined();
    expect(context.vertical!.type).toBe('hvac');
    expect(context.vertical!.packId).toBe('hvac-v1');
    expect(context.vertical!.terminology).toBeDefined();
    expect(context.vertical!.categories).toBeDefined();
  });

  it('happy path — no vertical leaves context unchanged', async () => {
    const repos: ContextRepositories = {};

    const context = await buildSourceContext('t1', undefined, {}, repos);
    expect(context.vertical).toBeUndefined();
  });

  it('happy path — vertical config null leaves context unchanged', async () => {
    const repos: ContextRepositories = {
      getActiveVerticalConfig: async () => null,
    };

    const context = await buildSourceContext('t1', undefined, {}, repos);
    expect(context.vertical).toBeUndefined();
  });

  it('mock provider — valid context shape with vertical', async () => {
    const repos: ContextRepositories = {
      getActiveVerticalConfig: async (): Promise<VerticalConfigResult> => ({
        type: 'plumbing',
        packId: 'plumbing-v1',
        terminology: { pipe: { canonical: 'pipe' } },
        categories: [{ id: 'drain', name: 'Drain Service' }],
      }),
      getTenantInfo: async () => ({ name: 'Test Co', settings: {} }),
    };

    const context = await buildSourceContext('t1', undefined, {}, repos);
    expect(context.tenant).toBeDefined();
    expect(context.vertical).toBeDefined();
    expect(context.vertical!.type).toBe('plumbing');
  });

  it('malformed AI output handled gracefully — error in vertical config', async () => {
    const repos: ContextRepositories = {
      getActiveVerticalConfig: async () => {
        throw new Error('Config loading failed');
      },
    };

    const context = await buildSourceContext('t1', undefined, {}, repos);
    // Should not throw, vertical just won't be set
    expect(context.vertical).toBeUndefined();
  });
});

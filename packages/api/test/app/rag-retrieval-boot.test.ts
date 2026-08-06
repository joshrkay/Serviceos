/**
 * Phase 4a-2 boot matrix — the RAG retrieve adapter is DARK BY DEFAULT.
 *
 * createApp() may construct the retrieve adapter only when BOTH
 * `RAG_RETRIEVAL_ENABLED === 'true'` and an embedding provider exist
 * (AI_PROVIDER_API_KEY set). When it is constructed, it must reach the
 * conversations router's aiDeps (the first real consumer: suggest-reply
 * drafts). When it is not, aiDeps must carry NO retrieveAdapter so the
 * suggest-reply path stays byte-identical to the legacy draft path.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { createApp, type AppWithLifecycle } from '../../src/app';
import { resetConfig } from '../../src/shared/config';
import { createRetrieveAdapter } from '../../src/ai/orchestration/retrieve-adapter';
import { createConversationRouter } from '../../src/routes/conversations';

vi.mock('../../src/ai/orchestration/retrieve-adapter', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/ai/orchestration/retrieve-adapter')>();
  return { ...actual, createRetrieveAdapter: vi.fn(actual.createRetrieveAdapter) };
});
vi.mock('../../src/routes/conversations', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/routes/conversations')>();
  return { ...actual, createConversationRouter: vi.fn(actual.createConversationRouter) };
});

const ENV_KEYS = [
  'RAG_RETRIEVAL_ENABLED',
  'AI_PROVIDER_API_KEY',
  'DATABASE_URL',
  'PROCESS_ROLE',
] as const;
type EnvKey = (typeof ENV_KEYS)[number];

describe('createApp() RAG retrieval boot matrix', () => {
  const originalEnv = new Map<EnvKey, string | undefined>(
    ENV_KEYS.map((k) => [k, process.env[k]]),
  );

  beforeAll(() => {
    // Hermetic: no Postgres, web role only (no worker sweeps).
    delete process.env.DATABASE_URL;
    process.env.PROCESS_ROLE = 'web';
  });

  afterAll(() => {
    resetConfig();
    for (const [k, v] of originalEnv) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  async function bootWith(env: {
    RAG_RETRIEVAL_ENABLED?: string;
    AI_PROVIDER_API_KEY?: string;
  }): Promise<{
    adapterConstructed: boolean;
    aiDeps: Parameters<typeof createConversationRouter>[2];
  }> {
    delete process.env.RAG_RETRIEVAL_ENABLED;
    delete process.env.AI_PROVIDER_API_KEY;
    if (env.RAG_RETRIEVAL_ENABLED !== undefined) {
      process.env.RAG_RETRIEVAL_ENABLED = env.RAG_RETRIEVAL_ENABLED;
    }
    if (env.AI_PROVIDER_API_KEY !== undefined) {
      process.env.AI_PROVIDER_API_KEY = env.AI_PROVIDER_API_KEY;
    }
    resetConfig();
    vi.mocked(createRetrieveAdapter).mockClear();
    vi.mocked(createConversationRouter).mockClear();

    let app: AppWithLifecycle | undefined;
    try {
      app = createApp();
      expect(vi.mocked(createConversationRouter)).toHaveBeenCalledTimes(1);
      return {
        adapterConstructed: vi.mocked(createRetrieveAdapter).mock.calls.length > 0,
        aiDeps: vi.mocked(createConversationRouter).mock.calls[0][2],
      };
    } finally {
      await app?.gracefulDrain?.('test-cleanup');
    }
  }

  it('flag unset: no adapter is constructed and none reaches the router', async () => {
    const { adapterConstructed, aiDeps } = await bootWith({
      AI_PROVIDER_API_KEY: 'sk-test-boot-matrix',
    });
    expect(adapterConstructed).toBe(false);
    expect(aiDeps?.retrieveAdapter).toBeUndefined();
  });

  it("flag 'false': no adapter (only the literal 'true' enables it)", async () => {
    const { adapterConstructed, aiDeps } = await bootWith({
      RAG_RETRIEVAL_ENABLED: 'false',
      AI_PROVIDER_API_KEY: 'sk-test-boot-matrix',
    });
    expect(adapterConstructed).toBe(false);
    expect(aiDeps?.retrieveAdapter).toBeUndefined();
  });

  it("flag 'true' but no embedding provider: no adapter", async () => {
    const { adapterConstructed, aiDeps } = await bootWith({
      RAG_RETRIEVAL_ENABLED: 'true',
    });
    expect(adapterConstructed).toBe(false);
    expect(aiDeps?.retrieveAdapter).toBeUndefined();
  });

  it("flag 'true' + embedder: the constructed adapter reaches the conversations router's aiDeps", async () => {
    const { adapterConstructed, aiDeps } = await bootWith({
      RAG_RETRIEVAL_ENABLED: 'true',
      AI_PROVIDER_API_KEY: 'sk-test-boot-matrix',
    });
    expect(adapterConstructed).toBe(true);
    expect(aiDeps?.retrieveAdapter).toBeDefined();
    expect(aiDeps?.retrieveAdapter).toBe(
      vi.mocked(createRetrieveAdapter).mock.results[0]!.value,
    );
  });
});

/**
 * OBS-1 — a non-UUID prompt id never reaches ai_runs.prompt_version_id.
 *
 * The brand-voice composer tags every call with
 * `metadata.promptVersionId = 'brand_voice_v1'`. The gateway copied it straight
 * into the ai_runs row, whose `prompt_version_id` column is UUID, so Postgres
 * rejected the insert ("invalid input syntax for type uuid"), the gateway
 * swallowed it as best-effort logging, and EVERY brand-voice completion —
 * including AI-written customer SMS — left no ai_runs record at all.
 *
 * Guarded at both seams: the repositories bind the column only for a UUID,
 * and the gateway / cache wrapper move a non-UUID ref into
 * input_snapshot.promptRef so the provenance survives.
 */
import { describe, it, expect } from 'vitest';
import { LLMGateway } from '../../../src/ai/gateway/gateway';
import type { LLMProvider, LLMRequest } from '../../../src/ai/gateway/gateway';
import { CachingGatewayWrapper, InMemoryCacheStore } from '../../../src/ai/gateway/cache';
import {
  InMemoryAiRunRepository,
  createAiRun,
  isUuid,
  type AiRun,
  type AiRunRepository,
} from '../../../src/ai/ai-run';

const UUID = '3f1c2b9e-8d7a-4c6b-9e5f-1a2b3c4d5e6f';

const provider: LLMProvider = {
  name: 'stub',
  isAvailable: async () => true,
  complete: async () => ({
    content: 'Hi Jane, we will be there at 2pm.',
    model: 'claude-haiku-4-5-20251001',
    provider: 'stub',
    tokenUsage: { input: 40, output: 12, total: 52 },
    latencyMs: 1,
  }),
};

/** Records exactly what reaches create(), then delegates. */
class CapturingRepo extends InMemoryAiRunRepository {
  created: AiRun[] = [];
  override async create(run: AiRun): Promise<AiRun> {
    this.created.push({ ...run });
    return super.create(run);
  }
}

function brandVoiceRequest(promptVersionId: unknown): LLMRequest {
  return {
    taskType: 'brand_voice_v1',
    tenantId: 'tenant-bv',
    messages: [{ role: 'user', content: 'Draft a reschedule SMS' }],
    metadata: { skill: 'brand_voice', promptVersionId },
  };
}

describe('OBS-1 — isUuid', () => {
  it.each([
    [UUID, true],
    [UUID.toUpperCase(), true],
    ['brand_voice_v1', false],
    ['', false],
    [`${UUID}x`, false],
    [42, false],
    [undefined, false],
  ])('%s -> %s', (value, expected) => {
    expect(isUuid(value)).toBe(expected);
  });
});

describe('OBS-1 — gateway seam', () => {
  it('moves a non-UUID prompt id into input_snapshot.promptRef, never promptVersionId', async () => {
    const repo = new CapturingRepo();
    const gateway = new LLMGateway({ defaultProvider: 'stub' }, new Map([['stub', provider]]), undefined, repo);

    const res = await gateway.complete(brandVoiceRequest('brand_voice_v1'));

    expect(repo.created).toHaveLength(1);
    expect(repo.created[0].promptVersionId).toBeUndefined();
    expect(repo.created[0].inputSnapshot.promptRef).toBe('brand_voice_v1');
    // The row exists and completed — the response links to it.
    expect(res.aiRunId).toBe(repo.created[0].id);
    const run = await repo.findById('tenant-bv', res.aiRunId!);
    expect(run?.status).toBe('completed');
  });

  it('keeps a real UUID prompt version in promptVersionId (no promptRef)', async () => {
    const repo = new CapturingRepo();
    const gateway = new LLMGateway({ defaultProvider: 'stub' }, new Map([['stub', provider]]), undefined, repo);

    await gateway.complete(brandVoiceRequest(UUID));

    expect(repo.created[0].promptVersionId).toBe(UUID);
    expect(repo.created[0].inputSnapshot).not.toHaveProperty('promptRef');
  });
});

describe('OBS-1 — cache-hit seam', () => {
  it('a cache hit also files a non-UUID prompt id as promptRef', async () => {
    const repo = new CapturingRepo();
    const gateway = new LLMGateway({ defaultProvider: 'stub' }, new Map([['stub', provider]]));
    const wrapper = new CachingGatewayWrapper(
      gateway,
      new InMemoryCacheStore(),
      { enabled: true, defaultTtlMs: 60_000, deterministicTaskTypes: ['brand_voice_v1'] },
      'system',
      repo,
    );

    await wrapper.complete(brandVoiceRequest('brand_voice_v1')); // miss
    await wrapper.complete(brandVoiceRequest('brand_voice_v1')); // hit → writes its own row
    await new Promise((r) => setImmediate(r));

    expect(repo.created).toHaveLength(1);
    expect(repo.created[0].createdBy).toBe('gateway-cache');
    expect(repo.created[0].promptVersionId).toBeUndefined();
    expect(repo.created[0].inputSnapshot.promptRef).toBe('brand_voice_v1');
  });
});

describe('OBS-1 — persistence seam (in-memory repo mirrors Pg)', () => {
  it('drops a non-UUID promptVersionId on create instead of storing it', async () => {
    const repo: AiRunRepository = new InMemoryAiRunRepository();
    const run = createAiRun({
      tenantId: 't',
      taskType: 'brand_voice_v1',
      model: 'm',
      promptVersionId: 'brand_voice_v1',
      inputSnapshot: {},
      createdBy: 'test',
    });
    const created = await repo.create(run);
    expect(created.promptVersionId).toBeUndefined();
    expect((await repo.findById('t', run.id))?.promptVersionId).toBeUndefined();
  });
});

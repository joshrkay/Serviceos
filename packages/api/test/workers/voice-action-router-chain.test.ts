import { describe, it, expect, vi } from 'vitest';
import {
  createVoiceActionRouterWorker,
  VoiceActionRouterPayload,
} from '../../src/workers/voice-action-router';
import { InMemoryProposalRepository } from '../../src/proposals/proposal';
import { QueueMessage } from '../../src/queues/queue';
import { createMockLLMGateway } from '../../src/ai/gateway/factory';
import { chainMetaFor } from '../../src/proposals/chain';
import type { Logger } from '../../src/logging/logger';

function silentLogger(): Logger {
  const noop = () => {};
  const base = {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    child: () => base,
  } as unknown as Logger;
  return base;
}

function makeMessage(transcript: string): QueueMessage<VoiceActionRouterPayload> {
  return {
    id: 'msg-1',
    type: 'voice_action_router',
    payload: { tenantId: 'tenant-1', userId: 'user-1', transcript, conversationId: 'conv-1' },
    attempts: 0,
    enqueuedAt: new Date(),
  };
}

describe('voice-action-router — multi-action chaining', () => {
  it('does NOT call the decomposer when the flag is off', async () => {
    const { gateway, provider } = createMockLLMGateway(
      JSON.stringify({ intentType: 'create_invoice', confidence: 0.9 })
    );
    const spy = vi.spyOn(provider, 'complete');
    const repo = new InMemoryProposalRepository();
    const worker = createVoiceActionRouterWorker({
      gateway,
      proposalRepo: repo,
      // multiActionEnabled omitted → flag off
    });

    await worker.handle(makeMessage('create an invoice for Acme'), silentLogger());

    // Exactly one classify call — no decomposition call.
    const decomposeCalls = spy.mock.calls.filter(
      ([req]) => req.taskType === 'decompose_transcript'
    );
    expect(decomposeCalls).toHaveLength(0);
  });

  it('builds a linked chain with ref tokens when the flag is on', async () => {
    const { gateway, provider } = createMockLLMGateway();
    // Dispatch responses by taskType so the estimate task's own LLM call
    // (taskType 'draft_estimate') can't desync a positional sequence.
    // classify_intent is sequenced separately, one per segment in order.
    const decomposition = JSON.stringify({
      segments: [
        { index: 0, text: 'create a customer named Jane Doe', dependsOn: [] },
        { index: 1, text: 'open a job for Jane', dependsOn: [0], dependencyEntityKind: 'customerId' },
        { index: 2, text: 'send Jane an estimate for 300 dollars', dependsOn: [0], dependencyEntityKind: 'customerId' },
      ],
    });
    const classifications = [
      JSON.stringify({ intentType: 'create_customer', confidence: 0.95, extractedEntities: { displayName: 'Jane Doe' } }),
      JSON.stringify({ intentType: 'create_job', confidence: 0.9, extractedEntities: { jobTitle: 'Service' } }),
      JSON.stringify({ intentType: 'draft_estimate', confidence: 0.9, extractedEntities: { customerName: 'Jane Doe' } }),
    ];
    const estimatePayload = JSON.stringify({
      lineItems: [{ description: 'Service', quantity: 1, unitPrice: 30000 }],
      notes: '',
    });
    let classifyCall = 0;
    vi.spyOn(provider, 'complete').mockImplementation(async (req) => {
      let content = '{}';
      if (req.taskType === 'decompose_transcript') content = decomposition;
      else if (req.taskType === 'classify_intent') {
        content = classifications[Math.min(classifyCall++, classifications.length - 1)];
      } else if (req.taskType === 'draft_estimate') content = estimatePayload;
      return {
        content,
        model: 'mock',
        provider: 'mock',
        tokenUsage: { input: 10, output: 10, total: 20 },
        latencyMs: 1,
      };
    });

    const repo = new InMemoryProposalRepository();
    const worker = createVoiceActionRouterWorker({
      gateway,
      proposalRepo: repo,
      multiActionEnabled: async () => true,
    });

    await worker.handle(
      makeMessage('create a customer named Jane Doe, open a job for her, and send her an estimate for 300 dollars'),
      silentLogger()
    );

    const all = await repo.findByTenant('tenant-1');
    expect(all.length).toBe(3);

    // All share one chainId.
    const chainIds = new Set(all.map((p) => p.chainId));
    expect(chainIds.size).toBe(1);

    const byType = (t: string) => all.find((p) => p.proposalType === t);
    const customer = byType('create_customer');
    const job = byType('create_job');
    const estimate = byType('draft_estimate');
    expect(customer).toBeDefined();
    expect(job).toBeDefined();
    expect(estimate).toBeDefined();

    // The dependents carry a symbolic ref token + chain metadata.
    expect(job!.payload.customerId).toBe('$ref:chain[0].customerId');
    expect(estimate!.payload.customerId).toBe('$ref:chain[0].customerId');

    const jobMeta = chainMetaFor(job!);
    expect(jobMeta).toBeDefined();
    expect(jobMeta!.chainRefs[0]).toMatchObject({ parentChainIndex: 0, entityKind: 'customerId' });

    // Dependents are forced to draft (can't race ahead of the parent).
    expect(job!.status).toBe('draft');
    expect(estimate!.status).toBe('draft');
  });

  it('persists a mid-chain clarification atomically with the chain (rolls back together)', async () => {
    const { gateway, provider } = createMockLLMGateway();
    const decomposition = JSON.stringify({
      segments: [
        { index: 0, text: 'create a customer named Jane Doe', dependsOn: [] },
        { index: 1, text: 'mumble mumble', dependsOn: [] },
      ],
    });
    const classifications = [
      JSON.stringify({ intentType: 'create_customer', confidence: 0.95, extractedEntities: { displayName: 'Jane Doe' } }),
      JSON.stringify({ intentType: 'unknown', confidence: 0.1 }),
    ];
    let classifyCall = 0;
    vi.spyOn(provider, 'complete').mockImplementation(async (req) => {
      let content = '{}';
      if (req.taskType === 'decompose_transcript') content = decomposition;
      else if (req.taskType === 'classify_intent') {
        content = classifications[Math.min(classifyCall++, classifications.length - 1)];
      }
      return { content, model: 'mock', provider: 'mock', tokenUsage: { input: 10, output: 10, total: 20 }, latencyMs: 1 };
    });

    // Force the atomic write to fail and assert nothing (not even the
    // clarification) was committed — the pre-fix bug committed the
    // clarification separately, blocking redelivery.
    const repo = new InMemoryProposalRepository();
    const createManySpy = vi
      .spyOn(repo, 'createMany')
      .mockRejectedValueOnce(new Error('db down'));

    const worker = createVoiceActionRouterWorker({
      gateway,
      proposalRepo: repo,
      multiActionEnabled: async () => true,
    });

    await expect(
      worker.handle(makeMessage('create a customer named Jane Doe and mumble'), silentLogger()),
    ).rejects.toThrow();

    expect(createManySpy).toHaveBeenCalledTimes(1);
    // The single createMany call carried BOTH the customer member and the
    // clarification — i.e. the clarification was not committed separately.
    const batch = createManySpy.mock.calls[0][0];
    expect(batch.map((p) => p.proposalType).sort()).toEqual(
      ['create_customer', 'voice_clarification'].sort(),
    );
    // Nothing persisted (the rejected batch rolled back).
    expect(await repo.findByTenant('tenant-1')).toHaveLength(0);
  });
});

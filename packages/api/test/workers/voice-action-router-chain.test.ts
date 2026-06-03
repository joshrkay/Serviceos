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

  it('persists chain members keyless and dedups a sequential redelivery (by recordingId)', async () => {
    const { gateway, provider } = createMockLLMGateway();
    const decomposition = JSON.stringify({
      segments: [
        { index: 0, text: 'create a customer named Jane Doe', dependsOn: [] },
        { index: 1, text: 'open a job for Jane', dependsOn: [0], dependencyEntityKind: 'customerId' },
      ],
    });
    const classifications = [
      JSON.stringify({ intentType: 'create_customer', confidence: 0.95, extractedEntities: { displayName: 'Jane Doe' } }),
      JSON.stringify({ intentType: 'create_job', confidence: 0.9, extractedEntities: { jobTitle: 'Service' } }),
    ];
    let classifyCall = 0;
    const spy = vi.spyOn(provider, 'complete').mockImplementation(async (req) => {
      let content = '{}';
      if (req.taskType === 'decompose_transcript') content = decomposition;
      else if (req.taskType === 'classify_intent') {
        content = classifications[Math.min(classifyCall++, classifications.length - 1)];
      }
      return { content, model: 'mock', provider: 'mock', tokenUsage: { input: 10, output: 10, total: 20 }, latencyMs: 1 };
    });

    const repo = new InMemoryProposalRepository();
    const worker = createVoiceActionRouterWorker({ gateway, proposalRepo: repo, multiActionEnabled: async () => true });

    const msg: QueueMessage<VoiceActionRouterPayload> = {
      id: 'msg-chain-redeliver',
      type: 'voice_action_router',
      payload: {
        tenantId: 'tenant-1',
        userId: 'user-1',
        transcript: 'create a customer named Jane Doe and open a job for her',
        conversationId: 'conv-1',
        recordingId: 'rec-chain-1',
      },
      attempts: 0,
      enqueuedAt: new Date(),
    };

    await worker.handle(msg, silentLogger());

    const afterFirst = await repo.findByTenant('tenant-1');
    expect(afterFirst.length).toBe(2);
    // Chain members must be keyless — they share one recordingId and persist
    // via createMany, so a shared idempotencyKey would collide on the unique index.
    expect(afterFirst.every((p) => p.idempotencyKey === undefined)).toBe(true);
    // ...but each carries recordingId on sourceContext so the pre-check can find them.
    expect(afterFirst.every((p) => (p.sourceContext as Record<string, unknown>)?.recordingId === 'rec-chain-1')).toBe(true);

    const decomposeCallsAfterFirst = spy.mock.calls.filter(([req]) => req.taskType === 'decompose_transcript').length;

    // At-least-once redelivery of the SAME recording must short-circuit in
    // findAlreadyProcessed (no second chain, no re-decomposition).
    await worker.handle(msg, silentLogger());

    const afterSecond = await repo.findByTenant('tenant-1');
    expect(afterSecond.length).toBe(2);
    const decomposeCallsAfterSecond = spy.mock.calls.filter(([req]) => req.taskType === 'decompose_transcript').length;
    expect(decomposeCallsAfterSecond).toBe(decomposeCallsAfterFirst); // skipped before decompose
  });
});

/**
 * #1588 — multi-action decomposition in production.
 *
 * `workers/voice-action-router.ts` could already split one sentence into an
 * ORDERED chain of linked proposals, but `multiActionEnabled` had zero call
 * sites in app.ts, so "add 2 hours labor and a capacitor to the Rivera
 * invoice and send it" silently kept ONE action on every live tenant. The
 * gate is now a tenant flag (`voice_multi_action`) resolved DEFAULT-ON
 * through `createVoiceFlagResolver` — a tenant override `enabled=false` is
 * the opt-out, a platform `_feature_flags` row is the kill switch.
 *
 * Seam: createVoiceActionRouterWorker().handle() with a scripted gateway and
 * the production resolver over empty flag repos (every tenant's shape today).
 */
import { describe, it, expect, vi } from 'vitest';
import {
  createVoiceActionRouterWorker,
  VoiceActionRouterPayload,
} from '../../src/workers/voice-action-router';
import { InMemoryProposalRepository } from '../../src/proposals/proposal';
import { QueueMessage } from '../../src/queues/queue';
import { createMockLLMGateway } from '../../src/ai/gateway/factory';
import { chainMetaFor } from '../../src/proposals/chain';
import { InMemoryFeatureFlagRepository } from '../../src/flags/feature-flags';
import { createVoiceFlagResolver } from '../../src/flags/voice-flags';
import type { Logger } from '../../src/logging/logger';

const TENANT = 'tenant-1588-memo';
const SENTENCE = 'add 2 hours labor and a capacitor to the Rivera invoice and send it';

function silentLogger(): Logger {
  const noop = () => {};
  const base = { debug: noop, info: noop, warn: noop, error: noop, child: () => base } as unknown as Logger;
  return base;
}

function makeMessage(transcript: string): QueueMessage<VoiceActionRouterPayload> {
  return {
    id: 'msg-1588',
    type: 'voice_action_router',
    payload: { tenantId: TENANT, userId: 'user-1', transcript, conversationId: 'conv-1588' },
    attempts: 0,
    enqueuedAt: new Date(),
  };
}

/**
 * The model's answers for the issue's sentence, dispatched by taskType:
 * the decomposer splits it in two (the send depends on the edited invoice),
 * the classifier names each half, and the invoice-edit task drafts the two
 * line items.
 */
function scriptedGateway() {
  const { gateway, provider } = createMockLLMGateway();
  const decomposition = JSON.stringify({
    segments: [
      { index: 0, text: 'add 2 hours labor and a capacitor to the Rivera invoice', dependsOn: [] },
      { index: 1, text: 'send the Rivera invoice', dependsOn: [0], dependencyEntityKind: 'invoiceId' },
    ],
  });
  const classifications = [
    JSON.stringify({ intentType: 'update_invoice', confidence: 0.93, extractedEntities: { customerName: 'Rivera' } }),
    JSON.stringify({ intentType: 'send_invoice', confidence: 0.95, extractedEntities: { customerName: 'Rivera' } }),
  ];
  const invoiceEdit = JSON.stringify({
    invoiceReference: 'Rivera',
    editActions: [
      { type: 'add_line_item', lineItem: { description: 'Labor', quantity: 2, unitPrice: 12500, category: 'labor' } },
      { type: 'add_line_item', lineItem: { description: 'Capacitor', quantity: 1, unitPrice: 8900, category: 'material' } },
    ],
    confidence_score: 0.9,
  });
  let classifyCall = 0;
  const spy = vi.spyOn(provider, 'complete').mockImplementation(async (req) => {
    let content = '{}';
    if (req.taskType === 'decompose_transcript') content = decomposition;
    else if (req.taskType === 'classify_intent') {
      content = classifications[Math.min(classifyCall++, classifications.length - 1)];
    } else if (req.taskType === 'update_invoice') content = invoiceEdit;
    return { content, model: 'mock', provider: 'mock', tokenUsage: { input: 10, output: 10, total: 20 }, latencyMs: 1 };
  });
  return { gateway, spy };
}

describe('#1588 — multi-action chaining is on by default for the recorded memo', () => {
  it('a two-action sentence on a tenant with no flag rows yields two linked proposals', async () => {
    const { gateway } = scriptedGateway();
    const repo = new InMemoryProposalRepository();
    const voiceFlags = createVoiceFlagResolver({
      tenantFeatureFlags: null,
      featureFlagRepo: new InMemoryFeatureFlagRepository(),
    });
    const worker = createVoiceActionRouterWorker({
      gateway,
      proposalRepo: repo,
      multiActionEnabled: voiceFlags.multiActionEnabled,
    });

    await worker.handle(makeMessage(SENTENCE), silentLogger());

    const all = await repo.findByTenant(TENANT);
    expect(all.map((p) => p.proposalType).sort()).toEqual(['send_invoice', 'update_invoice']);

    const edit = all.find((p) => p.proposalType === 'update_invoice')!;
    const send = all.find((p) => p.proposalType === 'send_invoice')!;
    // Linked: one chain, the edit first, the send waiting on the edited invoice.
    expect(edit.chainId).toBeDefined();
    expect(send.chainId).toBe(edit.chainId);
    expect(chainMetaFor(edit)?.chainIndex).toBe(0);
    expect(send.payload.invoiceId).toBe('$ref:chain[0].invoiceId');
    expect(chainMetaFor(send)?.chainRefs[0]).toMatchObject({
      parentChainIndex: 0,
      entityKind: 'invoiceId',
      payloadPath: 'invoiceId',
    });
    // A dependent never runs ahead of its parent: it lands as a draft.
    expect(send.status).toBe('draft');
  });

  it('a platform `voice_multi_action` row with enabled=false is the kill switch: single action, decomposer never called', async () => {
    const { gateway, spy } = scriptedGateway();
    const repo = new InMemoryProposalRepository();
    const platformFlags = new InMemoryFeatureFlagRepository();
    await platformFlags.upsert({ name: 'voice_multi_action', enabled: false });
    const voiceFlags = createVoiceFlagResolver({ tenantFeatureFlags: null, featureFlagRepo: platformFlags });
    const worker = createVoiceActionRouterWorker({
      gateway,
      proposalRepo: repo,
      multiActionEnabled: voiceFlags.multiActionEnabled,
    });

    await worker.handle(makeMessage(SENTENCE), silentLogger());

    const all = await repo.findByTenant(TENANT);
    expect(all.map((p) => p.proposalType)).toEqual(['update_invoice']);
    expect(all[0].chainId).toBeUndefined();
    expect(spy.mock.calls.filter(([req]) => req.taskType === 'decompose_transcript')).toHaveLength(0);
  });
});

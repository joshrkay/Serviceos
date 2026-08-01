import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  createVoiceActionRouterWorker,
  VoiceActionRouterPayload,
} from '../../src/workers/voice-action-router';
import { InMemoryProposalRepository } from '../../src/proposals/proposal';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import {
  setSupervisorPresenceLoader,
  _resetSupervisorPresenceCache,
} from '../../src/ai/supervisor-presence';
import { configureSupervisorReviewGate } from '../../src/ai/supervisor/review-gate';
import { payloadWithSupervisorMarker } from '../../src/proposals/supervisor/marker';
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

// ─────────────────────────────────────────────────────────────────────────────
// RV-221 — unsupervised chain routing: ONE summarized SMS per chain,
// anchored on the head member.
// ─────────────────────────────────────────────────────────────────────────────

describe('voice-action-router — RV-221 chain SMS routing', () => {
  afterEach(() => {
    _resetSupervisorPresenceCache();
    setSupervisorPresenceLoader(null);
    configureSupervisorReviewGate(null);
  });

  function chainProviderImpl(
    opts: { lowConfidenceJob?: boolean; moneyHead?: boolean } = {},
  ) {
    // `lowConfidenceJob`: the second segment becomes a draft_estimate whose
    // drafting response carries confidence_score 0.3 → the estimate task
    // stamps payload._meta.overallConfidence 'low' (the RV-074 blocking
    // predicate) — the chain's BLOCKING member.
    // `moneyHead`: the FIRST segment is record_payment (money class) — the
    // Track E non-Y-approvable chain head.
    const secondSegment = opts.lowConfidenceJob
      ? { index: 1, text: 'draft Jane an estimate', dependsOn: [0], dependencyEntityKind: 'customerId' }
      : { index: 1, text: 'open a job for Jane', dependsOn: [0], dependencyEntityKind: 'customerId' };
    const decomposition = JSON.stringify({
      segments: opts.moneyHead
        ? [
            { index: 0, text: 'record a 200 dollar payment from Jane', dependsOn: [] },
            { index: 1, text: 'add a note that Jane paid', dependsOn: [] },
          ]
        : [{ index: 0, text: 'create a customer named Jane Doe', dependsOn: [] }, secondSegment],
    });
    const classifications = opts.moneyHead
      ? [
          JSON.stringify({ intentType: 'record_payment', confidence: 0.95, extractedEntities: { customerName: 'Jane Doe', amount: 20000 } }),
          JSON.stringify({ intentType: 'add_note', confidence: 0.9, extractedEntities: { customerName: 'Jane Doe' } }),
        ]
      : [
          JSON.stringify({ intentType: 'create_customer', confidence: 0.95, extractedEntities: { displayName: 'Jane Doe' } }),
          opts.lowConfidenceJob
            ? JSON.stringify({ intentType: 'draft_estimate', confidence: 0.9, extractedEntities: { customerName: 'Jane Doe' } })
            : JSON.stringify({ intentType: 'create_job', confidence: 0.9, extractedEntities: { jobTitle: 'Service' } }),
        ];
    const lowConfidenceEstimate = JSON.stringify({
      lineItems: [{ description: 'Service', quantity: 1, unitPrice: 30000 }],
      notes: '',
      confidence_score: 0.3, // getConfidenceLevel(0.3) === 'low'
    });
    let classifyCall = 0;
    return async (req: { taskType?: string }) => {
      let content = '{}';
      if (req.taskType === 'decompose_transcript') content = decomposition;
      else if (req.taskType === 'classify_intent') {
        content = classifications[Math.min(classifyCall++, classifications.length - 1)];
      } else if (req.taskType === 'draft_estimate') content = lowConfidenceEstimate;
      return { content, model: 'mock', provider: 'mock', tokenUsage: { input: 10, output: 10, total: 20 }, latencyMs: 1 };
    };
  }

  function makeRoutedWorker(
    repo: InMemoryProposalRepository,
    auditRepo: InMemoryAuditRepository,
    sendSms: ReturnType<typeof vi.fn>,
    recordSmsEvent: ReturnType<typeof vi.fn>,
    gateway: Parameters<typeof createVoiceActionRouterWorker>[0]['gateway'],
  ) {
    return createVoiceActionRouterWorker({
      gateway,
      proposalRepo: repo,
      multiActionEnabled: async () => true,
      unsupervisedRouting: {
        auditRepo,
        sendSms: sendSms as unknown as (to: string, body: string) => Promise<void>,
        secret: 'test-secret',
        buildApproveUrl: (token) => `https://api.example.com/approve?token=${token}`,
        resolveOwnerPhone: async () => '+15125550100',
        resolveRouting: async () => 'queue_and_sms',
        recordSmsEvent: recordSmsEvent as unknown as (args: {
          tenantId: string;
          proposalId: string;
          body: string;
          kind: string;
        }) => Promise<void>,
      },
    });
  }

  it('unsupervised: sends EXACTLY ONE summary SMS anchored on the chain head', async () => {
    setSupervisorPresenceLoader(async () => false);
    const { gateway, provider } = createMockLLMGateway();
    vi.spyOn(provider, 'complete').mockImplementation(chainProviderImpl() as never);

    const repo = new InMemoryProposalRepository();
    const auditRepo = new InMemoryAuditRepository();
    const sendSms = vi.fn(async () => {});
    const recordSmsEvent = vi.fn(async () => {});
    const worker = makeRoutedWorker(repo, auditRepo, sendSms, recordSmsEvent, gateway);

    await worker.handle(
      makeMessage('create a customer named Jane Doe and open a job for her'),
      silentLogger(),
    );

    const all = await repo.findByTenant('tenant-1');
    expect(all).toHaveLength(2);
    const head = all.find((p) => p.proposalType === 'create_customer')!;

    // ONE SMS for the whole chain — the summary form, with the one-tap link.
    expect(sendSms).toHaveBeenCalledTimes(1);
    const [to, body] = sendSms.mock.calls[0] as unknown as [string, string];
    expect(to).toBe('+15125550100');
    expect(body).toContain('2 linked actions:');
    expect(body).toContain('1)');
    expect(body).toContain('2)');
    // Track E truthful copy: Y approves the head only.
    expect(body).toContain('Reply Y to approve the setup steps; starred items follow separately.');
    expect(body).toContain('https://api.example.com/approve?token=');

    // The outbound render anchors on the HEAD member, kind proposal_rendered —
    // an inbound Y approves the head; dependents follow chain resolution.
    expect(recordSmsEvent).toHaveBeenCalledTimes(1);
    expect(recordSmsEvent.mock.calls[0][0]).toMatchObject({
      tenantId: 'tenant-1',
      proposalId: head.id,
      kind: 'proposal_rendered',
    });

    // Routing audit lands on the head proposal.
    const routed = auditRepo
      .getAll()
      .filter((e) => e.eventType === 'unsupervised_proposal_routed');
    expect(routed).toHaveLength(1);
    expect(routed[0].entityId).toBe(head.id);
  });

  it('Track E: a MONEY chain head routes as the review form — no token, anchored review_required_rendered', async () => {
    setSupervisorPresenceLoader(async () => false);
    const { gateway, provider } = createMockLLMGateway();
    vi.spyOn(provider, 'complete').mockImplementation(chainProviderImpl({ moneyHead: true }) as never);

    const repo = new InMemoryProposalRepository();
    const auditRepo = new InMemoryAuditRepository();
    const sendSms = vi.fn(async () => {});
    const recordSmsEvent = vi.fn(async () => {});
    const worker = makeRoutedWorker(repo, auditRepo, sendSms, recordSmsEvent, gateway);

    await worker.handle(
      makeMessage('record a 200 dollar payment from Jane and add a note that she paid'),
      silentLogger(),
    );

    const all = await repo.findByTenant('tenant-1');
    expect(all).toHaveLength(2);
    const head = all.find((p) => p.proposalType === 'record_payment')!;
    expect(head).toBeDefined();

    // ONE SMS — but the review form: no Reply-Y prompt, NO one-tap token.
    expect(sendSms).toHaveBeenCalledTimes(1);
    const [, body] = sendSms.mock.calls[0] as unknown as [string, string];
    expect(body).toContain('2 linked actions:');
    expect(body).toContain('Needs review in app before approval — reply N to reject.');
    expect(body).not.toContain('Reply Y to approve');
    expect(body).not.toContain('https://api.example.com/approve?token=');

    // Anchored on the head as review_required_rendered, so the N the
    // message solicits targets the money head.
    expect(recordSmsEvent).toHaveBeenCalledTimes(1);
    expect(recordSmsEvent.mock.calls[0][0]).toMatchObject({
      tenantId: 'tenant-1',
      proposalId: head.id,
      kind: 'review_required_rendered',
    });

    // Audit records the suppressed affordance and why.
    const routed = auditRepo
      .getAll()
      .filter((e) => e.eventType === 'unsupervised_proposal_routed');
    expect(routed).toHaveLength(1);
    expect(routed[0].metadata).toMatchObject({
      approveLinkSuppressed: true,
      suppressReason: 'action_class',
    });
  });

  it('Track E: a LOW-confidence member threads the BLOCKING payload — review form, no token (lowConfidenceJob)', async () => {
    setSupervisorPresenceLoader(async () => false);
    const { gateway, provider } = createMockLLMGateway();
    vi.spyOn(provider, 'complete').mockImplementation(
      chainProviderImpl({ lowConfidenceJob: true }) as never,
    );

    const repo = new InMemoryProposalRepository();
    const auditRepo = new InMemoryAuditRepository();
    const sendSms = vi.fn(async () => {});
    const recordSmsEvent = vi.fn(async () => {});
    const worker = makeRoutedWorker(repo, auditRepo, sendSms, recordSmsEvent, gateway);

    await worker.handle(
      makeMessage('create a customer named Jane Doe and draft her an estimate'),
      silentLogger(),
    );

    const all = await repo.findByTenant('tenant-1');
    expect(all).toHaveLength(2);
    const head = all.find((p) => p.proposalType === 'create_customer')!;
    const estimate = all.find((p) => p.proposalType === 'draft_estimate')!;
    // Sanity: the estimate member really carries the blocking level.
    expect((estimate.payload._meta as Record<string, unknown>).overallConfidence).toBe('low');

    // The send site threads the BLOCKING member's payload, so the head's
    // (capture, non-blocking) payload cannot un-suppress the token: one
    // SMS, review form, no token minted.
    expect(sendSms).toHaveBeenCalledTimes(1);
    const [, body] = sendSms.mock.calls[0] as unknown as [string, string];
    expect(body).toContain('2 linked actions:');
    expect(body).toContain('Needs review in app before approval — reply N to reject.');
    expect(body).not.toContain('https://api.example.com/approve?token=');

    // Anchored review_required_rendered on the HEAD member.
    expect(recordSmsEvent).toHaveBeenCalledTimes(1);
    expect(recordSmsEvent.mock.calls[0][0]).toMatchObject({
      tenantId: 'tenant-1',
      proposalId: head.id,
      kind: 'review_required_rendered',
    });

    const routed = auditRepo
      .getAll()
      .filter((e) => e.eventType === 'unsupervised_proposal_routed');
    expect(routed).toHaveLength(1);
    expect(routed[0].metadata).toMatchObject({
      approveLinkSuppressed: true,
      suppressReason: 'low_confidence',
    });
  });

  it('supervised: no chain SMS is sent', async () => {
    setSupervisorPresenceLoader(async () => true);
    const { gateway, provider } = createMockLLMGateway();
    vi.spyOn(provider, 'complete').mockImplementation(chainProviderImpl() as never);

    const repo = new InMemoryProposalRepository();
    const auditRepo = new InMemoryAuditRepository();
    const sendSms = vi.fn(async () => {});
    const recordSmsEvent = vi.fn(async () => {});
    const worker = makeRoutedWorker(repo, auditRepo, sendSms, recordSmsEvent, gateway);

    await worker.handle(
      makeMessage('create a customer named Jane Doe and open a job for her'),
      silentLogger(),
    );

    expect(await repo.findByTenant('tenant-1')).toHaveLength(2);
    expect(sendSms).not.toHaveBeenCalled();
    expect(recordSmsEvent).not.toHaveBeenCalled();
  });

  it('N-004: a non-holding supervisor review on the capture-class chain head reaches the routed chain SMS (parity with the single-action path)', async () => {
    // Parity regression for the multi-action chain path. The gate attaches an
    // N-002 supervisor marker to the head payload and persists it, but the
    // router historically read only `.hold` from the gate result and rendered
    // the chain from the STALE `built[]` head — so the freshly-attached
    // supervisor verdict never reached the owner (unlike the single-action
    // path, which adopts the gate's returned proposal). The fix mirrors that
    // path: the head slot in `ordered` is the gate-reviewed proposal.
    //
    // renderChainSms surfaces the reviewed head via the blocking-confidence
    // path (it carries no per-member "Check:" line like renderProposalSms), so
    // we model a FLAGGED (non-holding) review that marks the capture-class head
    // with a blocking `_meta.overallConfidence`. With the fix, the reviewed
    // head is the chain's blocking member → the whole SMS flips to the review
    // form (no one-tap token, anchored review_required_rendered). Under the
    // stale-payload bug the head stays the original capture, non-blocking
    // create_customer, so the chain would send the approvable form WITH a token
    // — the assertions below would fail.
    setSupervisorPresenceLoader(async () => false);
    const supervisorReason = 'pricing 40% above catalog';
    configureSupervisorReviewGate({
      review: async ({ proposal }) => {
        const marked = payloadWithSupervisorMarker(
          { ...proposal.payload, _meta: { overallConfidence: 'low' } },
          [supervisorReason],
        );
        return { hold: false, proposal: { ...proposal, payload: marked } };
      },
    });

    const { gateway, provider } = createMockLLMGateway();
    // Default chain: create_customer (capture head) + create_job — NEITHER is
    // blocking on its own, so the only source of a blocking member is the
    // gate-reviewed head. That isolates the parity behavior.
    vi.spyOn(provider, 'complete').mockImplementation(chainProviderImpl() as never);

    const repo = new InMemoryProposalRepository();
    const auditRepo = new InMemoryAuditRepository();
    const sendSms = vi.fn(async () => {});
    const recordSmsEvent = vi.fn(async () => {});
    const worker = makeRoutedWorker(repo, auditRepo, sendSms, recordSmsEvent, gateway);

    await worker.handle(
      makeMessage('create a customer named Jane Doe and open a job for her'),
      silentLogger(),
    );

    const all = await repo.findByTenant('tenant-1');
    expect(all).toHaveLength(2);
    const head = all.find((p) => p.proposalType === 'create_customer')!;

    // ONE SMS — the review form, because the reviewed head is now the chain's
    // blocking member. No Reply-Y, no one-tap token.
    expect(sendSms).toHaveBeenCalledTimes(1);
    const [, body] = sendSms.mock.calls[0] as unknown as [string, string];
    expect(body).toContain('2 linked actions:');
    expect(body).toContain('Needs review in app before approval — reply N to reject.');
    expect(body).not.toContain('Reply Y to approve');
    expect(body).not.toContain('https://api.example.com/approve?token=');

    // Anchored review_required_rendered on the head — the reviewed (blocking)
    // head payload drove the suppression, not the stale capture head.
    expect(recordSmsEvent).toHaveBeenCalledTimes(1);
    expect(recordSmsEvent.mock.calls[0][0]).toMatchObject({
      tenantId: 'tenant-1',
      proposalId: head.id,
      kind: 'review_required_rendered',
    });

    const routed = auditRepo
      .getAll()
      .filter((e) => e.eventType === 'unsupervised_proposal_routed');
    expect(routed).toHaveLength(1);
    expect(routed[0].metadata).toMatchObject({
      approveLinkSuppressed: true,
      suppressReason: 'low_confidence',
    });
  });
});

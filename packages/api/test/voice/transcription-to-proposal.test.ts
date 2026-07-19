/**
 * Integration test — transcription completes → router enqueued →
 * classifier runs → proposal created.
 *
 * This test exercises the full Phase-1 chain using real in-memory
 * implementations of every moving part except the LLM. The LLM is a
 * MockLLMProvider that returns canned JSON for each call. Every other
 * seam (queue, voice repo, transcription worker, router worker,
 * proposal repo) is the actual production code.
 *
 * Validates:
 *   1) The transcription worker's onTranscribed hook enqueues a
 *      voice_action_router message on success.
 *   2) The queue dispatcher routes the router message to the right
 *      worker.
 *   3) The intent classifier + task handler chain produces a proposal
 *      that lands in the proposal repo for the correct tenant.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  InMemoryQueue,
  QueueMessage,
  processMessage,
  WorkerHandler,
} from '../../src/queues/queue';
import { InMemoryVoiceRepository } from '../../src/voice/voice-service';
import { InMemoryProposalRepository } from '../../src/proposals/proposal';
import { createTranscriptionWorker, TranscriptionJobPayload } from '../../src/workers/transcription';
import {
  createVoiceActionRouterWorker,
  VoiceActionRouterPayload,
} from '../../src/workers/voice-action-router';
import { createMockLLMGateway } from '../../src/ai/gateway/factory';
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

describe('integration — voice transcription → proposal', () => {
  let queue: InMemoryQueue;
  let voiceRepo: InMemoryVoiceRepository;
  let proposalRepo: InMemoryProposalRepository;

  beforeEach(() => {
    queue = new InMemoryQueue({ maxRetries: 3 });
    voiceRepo = new InMemoryVoiceRepository();
    proposalRepo = new InMemoryProposalRepository();
  });

  it('takes a voice recording and produces a draft_invoice proposal', async () => {
    const tenantId = 'tenant-integration';
    const userId = 'user-integration';
    const recordingId = 'rec-1';
    const jobId = '3b6cbf1a-bd8a-45f7-8b84-ce6b43a231d1';

    // Seed the recording so voice repo can update it later.
    await voiceRepo.create({
      id: recordingId,
      tenantId,
      status: 'pending',
      durationSeconds: 4,
      createdBy: userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Mock LLM responds:
    //   1st call → classifier JSON
    //   2nd call → invoice task JSON
    // MockLLMProvider uses a single `defaultResponse`, so we stub the
    // provider via its `setResponse` API to return different payloads
    // per call.
    const { gateway, provider } = createMockLLMGateway(
      JSON.stringify({ intentType: 'create_invoice', confidence: 0.92 })
    );
    // After the first call, switch the response to the invoice payload.
    // MockLLMProvider.complete increments an internal counter; we pre-seed
    // responses via setResponse per sequential call below.
    const responses = [
      JSON.stringify({
        intentType: 'create_invoice',
        confidence: 0.92,
        extractedEntities: { customerName: 'Acme Plumbing', amount: 45000 },
      }),
      JSON.stringify({
        customerId: 'cust-1',
        jobId,
        lineItems: [{ description: 'Emergency repair', quantity: 1, unitPrice: 45000 }],
        customerMessage: 'Thanks for your business',
        confidence_score: 0.92,
      }),
    ];
    let call = 0;
    vi.spyOn(provider, 'complete').mockImplementation(async () => ({
      content: responses[Math.min(call++, responses.length - 1)],
      model: 'mock',
      provider: 'mock',
      tokenUsage: { input: 10, output: 10, total: 20 },
      latencyMs: 1,
    }));

    // Wire the transcription worker with an onTranscribed hook that
    // enqueues the router job — same shape as app.ts wiring.
    const transcriptionWorker = createTranscriptionWorker(
      voiceRepo,
      {
        async transcribe() {
          return {
            transcript: 'Create an invoice for Acme Plumbing for 450 dollars',
            metadata: { provider: 'mock' },
          };
        },
      },
      {
        onTranscribed: async (event) => {
          await queue.send(
            'voice_action_router',
            {
              tenantId: event.tenantId,
              userId: event.userId ?? 'system',
              transcript: event.transcript,
              conversationId: event.conversationId,
              recordingId: event.recordingId,
              ...(event.jobId ? { jobId: event.jobId } : {}),
            } satisfies VoiceActionRouterPayload,
            `${event.tenantId}:${event.recordingId}:voice_action_router`
          );
        },
      }
    );

    const routerWorker = createVoiceActionRouterWorker({ gateway, proposalRepo });

    // Build the same dispatcher app.ts uses.
    const registry = new Map<string, WorkerHandler<unknown>>();
    registry.set(transcriptionWorker.type, transcriptionWorker as WorkerHandler<unknown>);
    registry.set(routerWorker.type, routerWorker as WorkerHandler<unknown>);

    // Step 1: enqueue a transcription job the way the voice route does.
    await queue.send('transcription', {
      tenantId,
      recordingId,
      audioUrl: 'https://example.com/audio.webm',
      userId,
      jobId,
    } satisfies TranscriptionJobPayload);

    // Step 2: drain the queue. Each iteration handles whatever message
    // happens to be first. The transcription worker's hook will enqueue
    // a second message, which the next iteration processes.
    const maxSteps = 10;
    for (let i = 0; i < maxSteps; i++) {
      const msg = (await queue.receive()) as QueueMessage<unknown> | null;
      if (!msg) break;
      const handler = registry.get(msg.type);
      expect(handler).toBeDefined();
      const result = await processMessage(msg, handler!, silentLogger());
      expect(result.success).toBe(true);
      await queue.delete(msg.id);
    }

    // Step 3: the proposal landed.
    const proposals = await proposalRepo.findByTenant(tenantId);
    expect(proposals).toHaveLength(1);
    expect(proposals[0].proposalType).toBe('draft_invoice');
    expect(proposals[0].createdBy).toBe(userId);
    expect(proposals[0].summary).toContain('Acme Plumbing');
    expect(proposals[0].payload.jobId).toBe(jobId);

    // Step 4: the voice recording transitioned to completed.
    const updatedRec = await voiceRepo.findById(tenantId, recordingId);
    expect(updatedRec?.status).toBe('completed');
    expect(updatedRec?.transcript).toContain('Acme Plumbing');
  });

  // Previously this test asserted NO proposal was created when the
  // classifier returned 'unknown'. That silent drop hid the failure
  // from the operator — they would record, see nothing happen, and
  // have no idea whether the transcript was heard at all. The
  // router now emits a voice_clarification proposal instead, which
  // surfaces as "Didn't catch that: '<transcript>'" in the review
  // feed. The test asserts that exactly one clarification proposal
  // is produced and that it references the original transcript.
  it('emits a voice_clarification proposal when transcript classifies as unknown', async () => {
    const tenantId = 'tenant-unknown';
    const userId = 'user-unknown';
    const recordingId = 'rec-unknown';

    await voiceRepo.create({
      id: recordingId,
      tenantId,
      status: 'pending',
      durationSeconds: 2,
      createdBy: userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const { gateway } = createMockLLMGateway(
      JSON.stringify({ intentType: 'unknown', confidence: 0.95 })
    );

    const transcriptionWorker = createTranscriptionWorker(
      voiceRepo,
      {
        async transcribe() {
          return { transcript: 'uhh please do the thing', metadata: {} };
        },
      },
      {
        onTranscribed: async (event) => {
          await queue.send(
            'voice_action_router',
            {
              tenantId: event.tenantId,
              userId: event.userId ?? 'system',
              transcript: event.transcript,
              recordingId: event.recordingId,
            } satisfies VoiceActionRouterPayload,
            `${event.tenantId}:${event.recordingId}:voice_action_router`
          );
        },
      }
    );

    const routerWorker = createVoiceActionRouterWorker({ gateway, proposalRepo });
    const registry = new Map<string, WorkerHandler<unknown>>();
    registry.set(transcriptionWorker.type, transcriptionWorker as WorkerHandler<unknown>);
    registry.set(routerWorker.type, routerWorker as WorkerHandler<unknown>);

    await queue.send('transcription', {
      tenantId,
      recordingId,
      audioUrl: 'https://example.com/mumbling.webm',
      userId,
    } satisfies TranscriptionJobPayload);

    for (let i = 0; i < 10; i++) {
      const msg = (await queue.receive()) as QueueMessage<unknown> | null;
      if (!msg) break;
      const handler = registry.get(msg.type)!;
      await processMessage(msg, handler, silentLogger());
      await queue.delete(msg.id);
    }

    const proposals = await proposalRepo.findByTenant(tenantId);
    expect(proposals).toHaveLength(1);
    const clar = proposals[0];
    expect(clar.proposalType).toBe('voice_clarification');
    expect(clar.status).toBe('draft');
    const payload = clar.payload as Record<string, unknown>;
    expect(payload.reason).toBe('unknown_intent');
    expect(payload.transcript).toBe('uhh please do the thing');
    expect(payload.recordingId).toBe(recordingId);
  });
});

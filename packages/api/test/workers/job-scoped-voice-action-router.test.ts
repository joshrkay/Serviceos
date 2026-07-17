import { describe, expect, it, vi } from 'vitest';
import { createMockLLMGateway } from '../../src/ai/gateway/factory';
import type { EntityResolver } from '../../src/ai/resolution/entity-resolver';
import type { Logger } from '../../src/logging/logger';
import { InMemoryProposalRepository, missingFieldsFor } from '../../src/proposals/proposal';
import type { QueueMessage } from '../../src/queues/queue';
import {
  createVoiceActionRouterWorker,
  type VoiceActionRouterPayload,
} from '../../src/workers/voice-action-router';

const VERIFIED_JOB_ID = '3b6cbf1a-bd8a-45f7-8b84-ce6b43a231d1';
const CONFLICTING_JOB_ID = '6cf14855-80fd-4c01-86e7-a542d72cbdb0';

function silentLogger(): Logger {
  const noop = () => {};
  const logger = {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    child: () => logger,
  } as unknown as Logger;
  return logger;
}

function message(transcript: string): QueueMessage<VoiceActionRouterPayload> {
  return {
    id: 'message-1',
    type: 'voice_action_router',
    payload: {
      tenantId: 'tenant-1',
      userId: 'technician-1',
      transcript,
      recordingId: 'recording-1',
      jobId: VERIFIED_JOB_ID,
    },
    attempts: 0,
    maxAttempts: 3,
    idempotencyKey: 'recording-1:voice-action-router',
    createdAt: new Date().toISOString(),
  };
}

function conflictingResolver() {
  const resolve = vi.fn<EntityResolver['resolve']>(async () => ({
    kind: 'resolved',
    candidate: {
      id: CONFLICTING_JOB_ID,
      kind: 'job',
      label: 'A different job',
      score: 1,
    },
  }));
  return { resolve } satisfies EntityResolver;
}

describe('voice-action-router — verified job context', () => {
  it('gives the handler the verified job id and ignores a conflicting classified reference', async () => {
    const { gateway } = createMockLLMGateway(JSON.stringify({
      intentType: 'log_time_entry',
      confidence: 0.98,
      extractedEntities: {
        jobReference: 'the other job',
        timeEntryType: 'job',
      },
    }));
    const proposalRepo = new InMemoryProposalRepository();
    const entityResolver = conflictingResolver();
    const worker = createVoiceActionRouterWorker({ gateway, proposalRepo, entityResolver });

    await worker.handle(message('Clock me in'), silentLogger());

    expect(entityResolver.resolve).not.toHaveBeenCalled();
    const proposals = await proposalRepo.findByTenant('tenant-1');
    expect(proposals).toHaveLength(1);
    expect(proposals[0].payload).toMatchObject({
      entryType: 'job',
      jobId: VERIFIED_JOB_ID,
      jobReference: 'the other job',
    });
    expect(missingFieldsFor(proposals[0])).not.toContain('jobId');
  });

  it('preserves the same verified job id across every multi-action segment', async () => {
    const { gateway, provider } = createMockLLMGateway();
    const classifications = [
      JSON.stringify({
        intentType: 'log_time_entry',
        confidence: 0.98,
        extractedEntities: { jobReference: 'wrong first job', timeEntryType: 'job' },
      }),
      JSON.stringify({
        intentType: 'log_time_entry',
        confidence: 0.97,
        extractedEntities: { jobReference: 'wrong second job', timeEntryType: 'job' },
      }),
    ];
    let classificationIndex = 0;
    vi.spyOn(provider, 'complete').mockImplementation(async (request) => ({
      content: request.taskType === 'decompose_transcript'
        ? JSON.stringify({
            segments: [
              { index: 0, text: 'clock me in', dependsOn: [] },
              { index: 1, text: 'log more job time', dependsOn: [] },
            ],
          })
        : classifications[Math.min(classificationIndex++, classifications.length - 1)],
      model: 'mock',
      provider: 'mock',
      tokenUsage: { input: 10, output: 10, total: 20 },
      latencyMs: 1,
    }));
    const proposalRepo = new InMemoryProposalRepository();
    const entityResolver = conflictingResolver();
    const worker = createVoiceActionRouterWorker({
      gateway,
      proposalRepo,
      entityResolver,
      multiActionEnabled: async () => true,
    });

    await worker.handle(message('Clock me in and log more job time'), silentLogger());

    expect(entityResolver.resolve).not.toHaveBeenCalled();
    const proposals = await proposalRepo.findByTenant('tenant-1');
    expect(proposals).toHaveLength(2);
    expect(proposals.every((proposal) => proposal.payload.jobId === VERIFIED_JOB_ID)).toBe(true);
    expect(proposals.every((proposal) => !missingFieldsFor(proposal).includes('jobId'))).toBe(true);
  });
});

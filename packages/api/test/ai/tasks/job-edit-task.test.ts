/**
 * UpdateJobTaskHandler unit tests (B7 — feat: voice-transcript-and-agent-paths).
 *
 * AI task that takes a voice/assistant transcript describing a safe job
 * field edit ("mark the Henderson job in progress") and produces an
 * `update_job` proposal. Mirrors EstimateEditTaskHandler /
 * InvoiceEditTaskHandler's reference-resolution + gating pattern.
 */
import { describe, it, expect, vi } from 'vitest';
import { UpdateJobTaskHandler } from '../../../src/ai/tasks/job-edit-task';
import { LLMGateway, LLMResponse } from '../../../src/ai/gateway/gateway';
import { InMemoryJobRepository, type Job } from '../../../src/jobs/job';
import { approveProposal } from '../../../src/proposals/actions';
import { InMemoryProposalRepository } from '../../../src/proposals/proposal';
import { updateJobPayloadSchema } from '../../../src/proposals/contracts';

function mockGateway(jsonContent: string): LLMGateway {
  return {
    complete: vi.fn(async () => ({
      content: jsonContent,
      model: 'mock',
      provider: 'mock',
      tokenUsage: { input: 100, output: 60, total: 160 },
      latencyMs: 44,
    } satisfies LLMResponse)),
  } as unknown as LLMGateway;
}

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-1',
    tenantId: 't-1',
    customerId: 'cust-1',
    locationId: 'loc-1',
    jobNumber: 'JOB-0001',
    summary: 'Water heater replacement',
    status: 'scheduled',
    priority: 'normal',
    createdBy: 'u-1',
    createdAt: new Date('2026-07-01T00:00:00Z'),
    updatedAt: new Date('2026-07-01T00:00:00Z'),
    ...overrides,
  };
}

describe('UpdateJobTaskHandler', () => {
  const tenantId = 't-1';
  const userId = 'u-1';

  it('produces an update_job proposal with the extracted field delta', async () => {
    const gateway = mockGateway(
      JSON.stringify({
        jobReference: 'JOB-0001',
        status: 'in_progress',
        confidence_score: 0.9,
      }),
    );
    const handler = new UpdateJobTaskHandler(gateway);
    const result = await handler.handle({
      tenantId,
      userId,
      message: 'Mark JOB-0001 in progress',
    });

    expect(result.taskType).toBe('update_job');
    expect(result.proposal.proposalType).toBe('update_job');
    const payload = result.proposal.payload as Record<string, unknown>;
    expect(payload.jobReference).toBe('JOB-0001');
    expect(payload.status).toBe('in_progress');
  });

  it('extracts priority, title, and description together', async () => {
    const gateway = mockGateway(
      JSON.stringify({
        jobReference: 'the Henderson job',
        priority: 'urgent',
        title: 'Water heater — 2nd unit',
        description: 'Customer reports no hot water on the east side',
        confidence_score: 0.88,
      }),
    );
    const handler = new UpdateJobTaskHandler(gateway);
    const result = await handler.handle({
      tenantId,
      userId,
      message: 'Bump the Henderson job to urgent, rename it, and update the description',
    });
    const payload = result.proposal.payload as Record<string, unknown>;
    expect(payload.priority).toBe('urgent');
    expect(payload.title).toBe('Water heater — 2nd unit');
    expect(payload.description).toBe('Customer reports no hot water on the east side');
  });

  it('normalizes a spaced status phrase to the underscore enum value', async () => {
    const gateway = mockGateway(
      JSON.stringify({
        jobReference: 'JOB-0001',
        status: 'in progress',
        confidence_score: 0.85,
      }),
    );
    const handler = new UpdateJobTaskHandler(gateway);
    const result = await handler.handle({ tenantId, userId, message: 'mark it in progress' });
    const payload = result.proposal.payload as Record<string, unknown>;
    expect(payload.status).toBe('in_progress');
  });

  it('drops an invalid status/priority enum value rather than passing it through', async () => {
    const gateway = mockGateway(
      JSON.stringify({
        jobReference: 'JOB-0001',
        status: 'super_urgent', // not a real JobStatus value
        priority: 'medium', // not a real JobPriority value (that's the create_job schema's, not the domain's)
        confidence_score: 0.7,
      }),
    );
    const handler = new UpdateJobTaskHandler(gateway);
    const result = await handler.handle({ tenantId, userId, message: 'do something to the job' });
    const payload = result.proposal.payload as Record<string, unknown>;
    expect(payload.status).toBeUndefined();
    expect(payload.priority).toBeUndefined();
  });

  it('falls back to an empty payload when LLM output is unparseable', async () => {
    const gateway = mockGateway('not json');
    const handler = new UpdateJobTaskHandler(gateway);
    const result = await handler.handle({ tenantId, userId, message: 'tweak the job somehow' });
    const payload = result.proposal.payload as Record<string, unknown>;
    expect(payload.status).toBeUndefined();
    expect(payload.priority).toBeUndefined();
    expect(payload.title).toBeUndefined();
    expect(payload.description).toBeUndefined();
  });

  it('threads conversationId into sourceContext alongside the jobId gate', async () => {
    const gateway = mockGateway(
      JSON.stringify({ jobReference: 'JOB-0001', status: 'completed', confidence_score: 0.9 }),
    );
    const handler = new UpdateJobTaskHandler(gateway);
    const result = await handler.handle({
      tenantId,
      userId,
      message: 'mark the job complete',
      conversationId: 'conv-7',
    });
    expect(result.proposal.sourceContext).toEqual({
      conversationId: 'conv-7',
      missingFields: ['jobId'],
    });
  });

  it('sends update_job as the LLM task type', async () => {
    const gateway = mockGateway(
      JSON.stringify({ jobReference: 'JOB-0001', status: 'completed', confidence_score: 0.9 }),
    );
    const handler = new UpdateJobTaskHandler(gateway);
    await handler.handle({ tenantId, userId, message: 'mark the job complete' });
    expect(gateway.complete).toHaveBeenCalledWith(
      expect.objectContaining({ taskType: 'update_job', tenantId }),
    );
  });

  describe('jobId resolution / missingFields gating', () => {
    function editGateway(jobReference = 'JOB-0001'): LLMGateway {
      return mockGateway(
        JSON.stringify({ jobReference, status: 'in_progress', confidence_score: 0.9 }),
      );
    }

    it('an unresolvable free-text reference (no jobRepo wired) gates missingFields and blocks approval', async () => {
      const proposalRepo = new InMemoryProposalRepository();
      const handler = new UpdateJobTaskHandler(editGateway());
      const result = await handler.handle({
        tenantId,
        userId,
        message: 'Mark the Henderson job in progress',
      });

      const payload = result.proposal.payload as Record<string, unknown>;
      expect(payload.jobId).toBeUndefined();
      expect(payload.jobReference).toBe('JOB-0001');
      expect(result.proposal.sourceContext).toMatchObject({ missingFields: ['jobId'] });

      await proposalRepo.create(result.proposal);
      await expect(
        approveProposal(proposalRepo, tenantId, result.proposal.id, userId, 'owner'),
      ).rejects.toThrow(/unfilled required fields/);
    });

    it('a reference that resolves to exactly one job via jobRepo search is stamped onto payload.jobId, but STAYS gated', async () => {
      const jobRepo = new InMemoryJobRepository();
      const job = await jobRepo.create(makeJob());

      const proposalRepo = new InMemoryProposalRepository();
      const handler = new UpdateJobTaskHandler(editGateway(), jobRepo);
      const result = await handler.handle({
        tenantId,
        userId,
        message: 'Mark JOB-0001 in progress',
      });

      const payload = result.proposal.payload as Record<string, unknown>;
      expect(payload.jobId).toBe(job.id);
      expect(payload.jobReference).toBe('JOB-0001');
      expect(result.proposal.sourceContext).toMatchObject({ missingFields: ['jobId'] });

      await proposalRepo.create(result.proposal);
      await expect(
        approveProposal(proposalRepo, tenantId, result.proposal.id, userId, 'owner'),
      ).rejects.toThrow(/unfilled required fields/);
    });

    it('an ambiguous reference (>1 match via jobRepo search) gates missingFields, does not set jobId, and records candidates', async () => {
      const jobRepo = new InMemoryJobRepository();
      // Same job number on two rows is the simplest way to force >1 search
      // hits for this in-memory repo's ILIKE-style match.
      await jobRepo.create(makeJob({ id: 'job-1', jobNumber: 'JOB-0001' }));
      await jobRepo.create(makeJob({ id: 'job-2', jobNumber: 'JOB-0001' }));

      const handler = new UpdateJobTaskHandler(editGateway(), jobRepo);
      const result = await handler.handle({
        tenantId,
        userId,
        message: 'Mark JOB-0001 in progress',
      });

      const payload = result.proposal.payload as Record<string, unknown>;
      expect(payload.jobId).toBeUndefined();
      expect(result.proposal.sourceContext).toMatchObject({ missingFields: ['jobId'] });

      const sc = result.proposal.sourceContext as Record<string, unknown>;
      expect(sc.entityKind).toBe('job');
      expect(Array.isArray(sc.entityCandidates)).toBe(true);
      expect((sc.entityCandidates as unknown[]).length).toBe(2);
    });

    // Verify-or-gate (2026-07 review): a UUID jobReference is an ASSUMPTION
    // about LLM output (buildPayload copies it verbatim), so it is only
    // trusted after jobRepo confirms it via findById.
    it('a repo-VERIFIED UUID reference lands on payload.jobId, ungates, and rides the verifiedIds allowlist', async () => {
      const uuidRef = '00000000-0000-4000-8000-000000000001';
      const jobRepo = new InMemoryJobRepository();
      await jobRepo.create(makeJob({ id: uuidRef }));

      const proposalRepo = new InMemoryProposalRepository();
      const handler = new UpdateJobTaskHandler(editGateway(uuidRef), jobRepo);
      const result = await handler.handle({
        tenantId,
        userId,
        message: `Mark job ${uuidRef} in progress`,
      });

      const payload = result.proposal.payload as Record<string, unknown>;
      expect(payload.jobId).toBe(uuidRef);
      const sc = result.proposal.sourceContext as Record<string, unknown>;
      expect(sc).not.toHaveProperty('missingFields');
      expect(sc.verifiedIds).toEqual({ jobId: uuidRef });

      await proposalRepo.create(result.proposal);
    });

    it('a HALLUCINATED UUID reference that misses the repo is GATED (not trusted blind)', async () => {
      const uuidRef = '00000000-0000-4000-8000-000000000001';
      const jobRepo = new InMemoryJobRepository();
      await jobRepo.create(makeJob({ id: 'job-real', jobNumber: 'JOB-9999' }));

      const handler = new UpdateJobTaskHandler(editGateway(uuidRef), jobRepo);
      const result = await handler.handle({
        tenantId,
        userId,
        message: 'Mark that job in progress',
      });

      const payload = result.proposal.payload as Record<string, unknown>;
      expect(payload.jobId).toBeUndefined();
      expect(result.proposal.sourceContext).toMatchObject({ missingFields: ['jobId'] });
      expect(result.proposal.sourceContext ?? {}).not.toHaveProperty('verifiedIds');
    });

    it('a UUID reference with NO jobRepo wired fails closed (gated)', async () => {
      const uuidRef = '00000000-0000-4000-8000-000000000001';
      const handler = new UpdateJobTaskHandler(editGateway(uuidRef));
      const result = await handler.handle({
        tenantId,
        userId,
        message: `Mark job ${uuidRef} in progress`,
      });

      const payload = result.proposal.payload as Record<string, unknown>;
      expect(payload.jobId).toBeUndefined();
      expect(result.proposal.sourceContext).toMatchObject({ missingFields: ['jobId'] });
    });

    it('a reference that matches zero jobs gates missingFields and does not set jobId', async () => {
      const jobRepo = new InMemoryJobRepository();
      await jobRepo.create(makeJob({ id: 'job-9', jobNumber: 'JOB-9999' }));

      const handler = new UpdateJobTaskHandler(editGateway(), jobRepo);
      const result = await handler.handle({
        tenantId,
        userId,
        message: 'Mark JOB-0001 in progress',
      });

      const payload = result.proposal.payload as Record<string, unknown>;
      expect(payload.jobId).toBeUndefined();
      expect(result.proposal.sourceContext).toMatchObject({ missingFields: ['jobId'] });
    });
  });

  // B7.7 — the drafting leg. `update_job` is in JOB_REF_INTENTS, so the
  // router's entity resolver puts a jobId on `existingEntities` BEFORE this
  // handler runs. It used to reach the handler only as a "Classifier hints"
  // string inside the LLM prompt, which meant the gate could only lift when
  // the model chose to echo a UUID back — a drafting leg that depended on the
  // model repeating an id rather than on resolution.
  describe('router-resolved jobId (existingEntities.jobId)', () => {
    const RESOLVED = '00000000-0000-4000-8000-0000000000aa';
    const HALLUCINATED = '00000000-0000-4000-8000-0000000000ff';

    /** Drafting reply that names the job in free text ONLY — no id at all. */
    function spokenGateway(): LLMGateway {
      return mockGateway(
        JSON.stringify({
          jobReference: 'the Garcia job',
          status: 'completed',
          confidence_score: 0.92,
        }),
      );
    }

    it('lifts the gate from the RESOLVER id even though the model emitted no id at all', async () => {
      const jobRepo = new InMemoryJobRepository();
      await jobRepo.create(makeJob({ id: RESOLVED, summary: 'AC repair' }));

      const proposalRepo = new InMemoryProposalRepository();
      const handler = new UpdateJobTaskHandler(spokenGateway(), jobRepo);
      const result = await handler.handle({
        tenantId,
        userId,
        message: 'Mark the Garcia job complete',
        existingEntities: { jobReference: 'the Garcia job', jobId: RESOLVED },
      });

      const payload = result.proposal.payload as Record<string, unknown>;
      expect(payload.jobId).toBe(RESOLVED);
      expect(payload.status).toBe('completed');
      const sc = result.proposal.sourceContext as Record<string, unknown>;
      expect(sc).not.toHaveProperty('missingFields');
      expect(sc.verifiedIds).toEqual({ jobId: RESOLVED });

      // Nothing blocks approval — the gate genuinely lifted. With a
      // supervisor on the wall this capture-class autonomous edit at 0.92
      // clears decideInitialStatus outright, which a `missingFields` gate
      // makes impossible (it forces 'draft' before any other rule runs).
      expect(result.proposal.status).toBe('approved');

      // The same handler with the id withheld is the contrast: gated, and
      // approveProposal refuses it.
      const gated = await new UpdateJobTaskHandler(spokenGateway(), jobRepo).handle({
        tenantId,
        userId,
        message: 'Mark the Garcia job complete',
        existingEntities: { jobReference: 'the Garcia job' },
      });
      expect(gated.proposal.status).toBe('draft');
      await proposalRepo.create(gated.proposal);
      await expect(
        approveProposal(proposalRepo, tenantId, gated.proposal.id, userId, 'owner'),
      ).rejects.toThrow(/unfilled required fields/);
    });

    // Rule 3 of docs/solutions/test-failures/a-fixture-arranged-to-pass-proves-nothing.md:
    // assert a value the test could not have handed to the code. The model's
    // id is deliberately WRONG, so "payload carries the resolver's id" can
    // only pass if resolution beat the model.
    it('the RESOLVER id wins over a hallucinated jobId the model emitted', async () => {
      const jobRepo = new InMemoryJobRepository();
      await jobRepo.create(makeJob({ id: RESOLVED, summary: 'AC repair' }));

      const handler = new UpdateJobTaskHandler(
        mockGateway(
          JSON.stringify({
            jobReference: 'the Garcia job',
            jobId: HALLUCINATED,
            status: 'completed',
            confidence_score: 0.92,
          }),
        ),
        jobRepo,
      );
      const result = await handler.handle({
        tenantId,
        userId,
        message: 'Mark the Garcia job complete',
        existingEntities: { jobReference: 'the Garcia job', jobId: RESOLVED },
      });

      const payload = result.proposal.payload as Record<string, unknown>;
      expect(payload.jobId).toBe(RESOLVED);
      expect(payload.jobId).not.toBe(HALLUCINATED);
      expect(result.proposal.sourceContext).toMatchObject({
        verifiedIds: { jobId: RESOLVED },
      });
    });

    it('a router id that the repo cannot confirm fails CLOSED — and takes the model id down with it', async () => {
      const jobRepo = new InMemoryJobRepository();
      // The resolved id belongs to no row this tenant can see (deleted,
      // cross-tenant, or a stale conversation anchor).
      await jobRepo.create(makeJob({ id: HALLUCINATED, summary: 'AC repair' }));

      const handler = new UpdateJobTaskHandler(
        mockGateway(
          JSON.stringify({
            jobReference: 'the Garcia job',
            jobId: HALLUCINATED, // a real row — but NOT what resolution said
            status: 'completed',
            confidence_score: 0.92,
          }),
        ),
        jobRepo,
      );
      const result = await handler.handle({
        tenantId,
        userId,
        message: 'Mark the Garcia job complete',
        existingEntities: { jobReference: 'the Garcia job', jobId: RESOLVED },
      });

      const payload = result.proposal.payload as Record<string, unknown>;
      expect(payload.jobId).toBeUndefined();
      expect(result.proposal.sourceContext).toMatchObject({ missingFields: ['jobId'] });
      expect(result.proposal.sourceContext ?? {}).not.toHaveProperty('verifiedIds');
    });

    it('a non-UUID value in the resolved slot is ignored (never used as an id)', async () => {
      const jobRepo = new InMemoryJobRepository();
      await jobRepo.create(makeJob({ id: RESOLVED, summary: 'AC repair' }));

      const handler = new UpdateJobTaskHandler(spokenGateway(), jobRepo);
      const result = await handler.handle({
        tenantId,
        userId,
        message: 'Mark the Garcia job complete',
        existingEntities: { jobReference: 'the Garcia job', jobId: 'the Garcia job' },
      });

      const payload = result.proposal.payload as Record<string, unknown>;
      expect(payload.jobId).toBeUndefined();
      expect(result.proposal.sourceContext).toMatchObject({ missingFields: ['jobId'] });
    });

    it('an AMBIGUOUS reference (router resolved nothing) still gates and offers candidates', async () => {
      const jobRepo = new InMemoryJobRepository();
      await jobRepo.create(makeJob({ id: 'job-a', jobNumber: 'JOB-0001' }));
      await jobRepo.create(makeJob({ id: 'job-b', jobNumber: 'JOB-0001' }));

      const handler = new UpdateJobTaskHandler(
        mockGateway(
          JSON.stringify({
            jobReference: 'JOB-0001',
            status: 'completed',
            confidence_score: 0.9,
          }),
        ),
        jobRepo,
      );
      // The router short-circuits an ambiguous reference to a clarification,
      // so no jobId ever reaches existingEntities.
      const result = await handler.handle({
        tenantId,
        userId,
        message: 'Mark the Garcia job complete',
        existingEntities: { jobReference: 'JOB-0001' },
      });

      const payload = result.proposal.payload as Record<string, unknown>;
      expect(payload.jobId).toBeUndefined();
      expect(result.proposal.sourceContext).toMatchObject({ missingFields: ['jobId'] });
    });

    it('no jobRepo wired: a router-resolved id is still not trusted (nothing verifies it)', async () => {
      const handler = new UpdateJobTaskHandler(spokenGateway());
      const result = await handler.handle({
        tenantId,
        userId,
        message: 'Mark the Garcia job complete',
        existingEntities: { jobReference: 'the Garcia job', jobId: RESOLVED },
      });

      const payload = result.proposal.payload as Record<string, unknown>;
      expect(payload.jobId).toBeUndefined();
      expect(result.proposal.sourceContext).toMatchObject({ missingFields: ['jobId'] });
    });
  });

  describe('contract validation (invalid status enum)', () => {
    it('rejects an invalid status enum value on the finished payload', () => {
      const parsed = updateJobPayloadSchema.safeParse({
        jobId: '00000000-0000-4000-8000-000000000001',
        status: 'super_urgent',
      });
      expect(parsed.success).toBe(false);
    });

    it('accepts a valid status enum value', () => {
      const parsed = updateJobPayloadSchema.safeParse({
        jobId: '00000000-0000-4000-8000-000000000001',
        status: 'in_progress',
      });
      expect(parsed.success).toBe(true);
    });

    it('requires at least one editable field', () => {
      const parsed = updateJobPayloadSchema.safeParse({
        jobId: '00000000-0000-4000-8000-000000000001',
      });
      expect(parsed.success).toBe(false);
    });

    it('requires jobId', () => {
      const parsed = updateJobPayloadSchema.safeParse({ status: 'completed' });
      expect(parsed.success).toBe(false);
    });
  });
});

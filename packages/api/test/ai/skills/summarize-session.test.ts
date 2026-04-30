/**
 * summarize_session skill tests.
 *
 * Covers:
 *  1. Returns summary from LLM response
 *  2. qualityScore = 0.75 when proposal created + intent detected + not escalated
 *  3. qualityScore = 0.5 when only proposal created
 *  4. qualityScore = 0.25 when only intent detected, no proposal
 *  5. qualityScore = undefined when transcript is empty
 *  6. Falls back to duration-based summary when LLM throws
 *  7. Does NOT throw when pool is undefined (no DB write)
 *  8. Unparseable LLM JSON → fallback summary
 *  9. Mock pool write: INSERT called with correct columns when pool provided
 */

import { describe, it, expect, vi } from 'vitest';
import { summarizeSession, SummarizeSessionInput } from '../../../src/ai/skills/summarize-session';
import { LLMGateway, LLMResponse } from '../../../src/ai/gateway/gateway';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockGateway(summary: string = 'The caller asked to book an AC inspection.'): LLMGateway {
  return {
    complete: vi.fn(async () => ({
      content: JSON.stringify({ summary }),
      model: 'mock-haiku',
      provider: 'mock',
      tokenUsage: { input: 40, output: 25, total: 65 },
      latencyMs: 10,
    } satisfies LLMResponse)),
  } as unknown as LLMGateway;
}

function throwingGateway(): LLMGateway {
  return {
    complete: vi.fn(async () => {
      throw new Error('LLM provider unavailable');
    }),
  } as unknown as LLMGateway;
}

function unparsableGateway(): LLMGateway {
  return {
    complete: vi.fn(async () => ({
      content: 'not valid json at all',
      model: 'mock-haiku',
      provider: 'mock',
      tokenUsage: { input: 10, output: 5, total: 15 },
      latencyMs: 5,
    } satisfies LLMResponse)),
  } as unknown as LLMGateway;
}

/** Create a minimal mock pg Pool. Returns the given callSummaryId from INSERT. */
function mockPool(callSummaryId: string = 'summary-uuid-001') {
  const mockQuery = vi.fn().mockImplementation((sql: string) => {
    if (typeof sql === 'string' && sql.includes('INSERT INTO call_summaries')) {
      return Promise.resolve({ rows: [{ id: callSummaryId }] });
    }
    // setTenantContext / other queries
    return Promise.resolve({ rows: [] });
  });

  const mockClient = {
    query: mockQuery,
    release: vi.fn(),
  };

  const pool = {
    connect: vi.fn(async () => mockClient),
  };

  return { pool, mockClient, mockQuery };
}

const BASE_TRANSCRIPT = [
  'Caller: Hi, I need to schedule an AC inspection.',
  'Agent: I can help with that. What day works for you?',
  'Caller: Friday afternoon.',
  'Agent: Great, I have booked that for you.',
];

// Use a real UUID so setTenantContext UUID validation passes in DB write tests.
const TEST_TENANT_ID = 'a1b2c3d4-0000-0000-0000-000000000001';

function baseInput(overrides: Partial<SummarizeSessionInput> = {}): SummarizeSessionInput {
  return {
    tenantId: TEST_TENANT_ID,
    sessionId: 'session-001',
    transcript: BASE_TRANSCRIPT,
    proposalIds: ['proposal-111'],
    intentDetected: 'create_appointment',
    durationMs: 45_000,
    escalated: false,
    gateway: mockGateway(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. Returns summary from LLM response
// ---------------------------------------------------------------------------

describe('summarizeSession — LLM summary', () => {
  it('returns the summary string from the LLM JSON response', async () => {
    const expectedSummary = 'The caller asked to book an AC inspection.';
    const result = await summarizeSession(baseInput({ gateway: mockGateway(expectedSummary) }));
    expect(result.summary).toBe(expectedSummary);
  });

  it('passes the transcript and metadata to the gateway', async () => {
    const gateway = mockGateway();
    await summarizeSession(baseInput({ gateway }));

    expect(gateway.complete).toHaveBeenCalledWith(
      expect.objectContaining({
        taskType: 'summarize',
        responseFormat: 'json',
        temperature: 0,
      })
    );
  });

  it('includes tenantId in metadata', async () => {
    const gateway = mockGateway();
    await summarizeSession(baseInput({ tenantId: 'tenant-xyz', gateway }));

    expect(gateway.complete).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ tenantId: 'tenant-xyz' }),
      })
    );
  });
});

// ---------------------------------------------------------------------------
// 2. qualityScore = 0.75 when proposal created + intent detected (escalated = no +0.25)
// ---------------------------------------------------------------------------

describe('summarizeSession — quality score rubric', () => {
  // Spec test 2: proposal + intent + escalated (so no +0.25 for resolution) = 0.5+0.25 = 0.75
  it('qualityScore = 0.75 when proposal created + intent detected + escalated', async () => {
    const result = await summarizeSession(baseInput({
      proposalIds: ['proposal-1'],
      intentDetected: 'create_appointment',
      escalated: true,
    }));
    // +0.5 proposal, +0.25 intent, +0.0 escalated = 0.75
    expect(result.qualityScore).toBeCloseTo(0.75);
  });

  // Spec test 3: only proposal, no intent, escalated = 0.5
  it('qualityScore = 0.5 when only proposal created (escalated, no intent)', async () => {
    const result = await summarizeSession(baseInput({
      proposalIds: ['proposal-1'],
      intentDetected: undefined,
      escalated: true,
    }));
    // +0.5 proposal, +0.0 no intent, +0.0 escalated = 0.5
    expect(result.qualityScore).toBeCloseTo(0.5);
  });

  // Spec test 4: only intent detected, no proposal, escalated = 0.25
  it('qualityScore = 0.25 when only intent detected, no proposal, and escalated', async () => {
    const result = await summarizeSession(baseInput({
      proposalIds: [],
      intentDetected: 'create_appointment',
      escalated: true,
    }));
    // +0.0 no proposal, +0.25 intent, +0.0 escalated = 0.25
    expect(result.qualityScore).toBeCloseTo(0.25);
  });

  // Spec test 5: transcript is empty → qualityScore undefined
  it('qualityScore is undefined when transcript is empty', async () => {
    const result = await summarizeSession(baseInput({
      transcript: [],
      proposalIds: ['proposal-1'],
      intentDetected: 'create_appointment',
    }));
    expect(result.qualityScore).toBeUndefined();
  });

  it('qualityScore = 1.0 when all three criteria satisfied (proposal + intent + not escalated)', async () => {
    const result = await summarizeSession(baseInput({
      proposalIds: ['p1'],
      intentDetected: 'create_appointment',
      escalated: false,
    }));
    // +0.5 + 0.25 + 0.25 = 1.0
    expect(result.qualityScore).toBeCloseTo(1.0);
    expect(result.qualityScore).toBeLessThanOrEqual(1.0);
  });

  it('"unknown" intent does not count as detected intent', async () => {
    const result = await summarizeSession(baseInput({
      proposalIds: [],
      intentDetected: 'unknown',
      escalated: true,
    }));
    // +0.0 no proposal, +0.0 unknown intent, +0.0 escalated = 0.0
    expect(result.qualityScore).toBeCloseTo(0.0);
  });
});

// ---------------------------------------------------------------------------
// 6. Falls back to duration-based summary when LLM throws
// ---------------------------------------------------------------------------

describe('summarizeSession — graceful degradation', () => {
  it('returns duration-based fallback summary when LLM throws', async () => {
    const result = await summarizeSession(baseInput({
      gateway: throwingGateway(),
      durationMs: 60_000,
      proposalIds: ['p1', 'p2'],
    }));
    expect(result.summary).toBe('Call lasted 60s. 2 proposal(s) created.');
  });

  // 7. Does NOT throw when pool is undefined
  it('does not throw when pool is undefined (no DB write)', async () => {
    await expect(
      summarizeSession(baseInput({ pool: undefined }))
    ).resolves.toBeDefined();
  });

  // 8. Unparseable LLM JSON → fallback summary
  it('unparseable LLM JSON → fallback summary', async () => {
    const result = await summarizeSession(baseInput({
      gateway: unparsableGateway(),
      durationMs: 30_000,
      proposalIds: [],
    }));
    expect(result.summary).toBe('Call lasted 30s. 0 proposal(s) created.');
  });

  it('LLM JSON missing summary field → fallback summary', async () => {
    const gateway: LLMGateway = {
      complete: vi.fn(async () => ({
        content: JSON.stringify({ qualityScore: 0.8 }), // no summary key
        model: 'mock-haiku',
        provider: 'mock',
        tokenUsage: { input: 10, output: 5, total: 15 },
        latencyMs: 5,
      } satisfies LLMResponse)),
    } as unknown as LLMGateway;

    const result = await summarizeSession(baseInput({
      gateway,
      durationMs: 20_000,
      proposalIds: [],
    }));
    expect(result.summary).toBe('Call lasted 20s. 0 proposal(s) created.');
  });
});

// ---------------------------------------------------------------------------
// 9. Mock pool write: INSERT called with correct columns when pool provided
// ---------------------------------------------------------------------------

describe('summarizeSession — DB write', () => {
  it('calls INSERT with correct columns when pool is provided', async () => {
    const { pool, mockQuery } = mockPool('new-summary-id');
    const expectedSummary = 'The caller asked to book an AC inspection.';

    const result = await summarizeSession(baseInput({
      tenantId: TEST_TENANT_ID,
      gateway: mockGateway(expectedSummary),
      pool: pool as unknown as import('pg').Pool,
      proposalIds: ['proposal-111'],
      intentDetected: 'create_appointment',
      escalated: false,
    }));

    // Should have returned the callSummaryId from the INSERT
    expect(result.callSummaryId).toBe('new-summary-id');

    // Find the INSERT call
    const insertCall = mockQuery.mock.calls.find(
      (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('INSERT INTO call_summaries')
    );
    expect(insertCall).toBeDefined();

    const [sql, params] = insertCall as [string, unknown[]];
    expect(sql).toContain('tenant_id');
    expect(sql).toContain('summary');
    expect(sql).toContain('detected_intent');
    expect(sql).toContain('proposal_ids');
    expect(sql).toContain('quality_score');
    expect(sql).toContain('RETURNING id');

    // params: [$1=tenantId, $2=summary, $3=intentDetected, $4=proposalIds, $5=qualityScore]
    expect(params[0]).toBe(TEST_TENANT_ID);
    expect(params[1]).toBe(expectedSummary);
    expect(params[2]).toBe('create_appointment');
    expect(params[3]).toEqual(['proposal-111']);
    // qualityScore: 0.5 proposal + 0.25 intent + 0.25 not escalated = 1.0, capped at 1.0
    expect(params[4]).toBeCloseTo(1.0);
  });

  it('releases the client after writing', async () => {
    const { pool, mockClient } = mockPool();

    await summarizeSession(baseInput({
      tenantId: TEST_TENANT_ID,
      pool: pool as unknown as import('pg').Pool,
    }));

    expect(mockClient.release).toHaveBeenCalled();
  });

  it('does not set callSummaryId when pool is not provided', async () => {
    const result = await summarizeSession(baseInput({ pool: undefined }));
    expect(result.callSummaryId).toBeUndefined();
  });

  it('still returns summary even when pool INSERT fails', async () => {
    const failingPool = {
      connect: vi.fn(async () => {
        throw new Error('DB connection refused');
      }),
    };

    const result = await summarizeSession(baseInput({
      tenantId: TEST_TENANT_ID,
      pool: failingPool as unknown as import('pg').Pool,
    }));

    // Summary should still be returned
    expect(result.summary).toBeDefined();
    expect(result.callSummaryId).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Result shape
// ---------------------------------------------------------------------------

describe('summarizeSession — result shape', () => {
  it('always returns proposalIds in result', async () => {
    const result = await summarizeSession(baseInput({ proposalIds: ['p1', 'p2'] }));
    expect(result.proposalIds).toEqual(['p1', 'p2']);
  });

  it('returns intentDetected when provided in input', async () => {
    const result = await summarizeSession(baseInput({ intentDetected: 'create_appointment' }));
    expect(result.intentDetected).toBe('create_appointment');
  });

  it('intentDetected is absent from result when not provided in input', async () => {
    const result = await summarizeSession(baseInput({ intentDetected: undefined }));
    expect(result.intentDetected).toBeUndefined();
  });
});

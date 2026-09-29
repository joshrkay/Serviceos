import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  approveAndAwaitExecution,
  ensureTenantTimezone,
  voiceInput,
} from '../../../../e2e/qa-matrix/helpers/voice-flow';
import type { RowHarness } from '../../../../e2e/qa-matrix/helpers/matrix-test';

/**
 * QA matrix 2026-09-26 — the shared voice/assistant flow helpers are the seam
 * every AI row goes through. A fake harness records the API calls the helper
 * makes and answers them from a script, the way the dev API did in the run.
 */

type Scripted = { status: number; body: unknown };
type Call = { method: string; path: string; body?: unknown; label: string };

function fakeHarness(script: (call: Call) => Scripted): { h: RowHarness; calls: Call[]; notes: string[] } {
  const calls: Call[] = [];
  const notes: string[] = [];
  const h = {
    api: {
      async call(opts: Call) {
        calls.push(opts);
        const { status, body } = script(opts);
        return {
          request: { method: opts.method, url: opts.path, headers: {}, body: opts.body },
          response: { status, ok: status < 400, body, durationMs: 1, timestamp: '' },
          artifactPath: '',
        };
      },
    },
    evidence: { note: (m: string) => notes.push(m) },
  } as unknown as RowHarness;
  return { h, calls, notes };
}

beforeEach(() => {
  process.env.E2E_API_URL = 'http://api.test';
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('approveAndAwaitExecution', () => {
  it('returns at once with the rejection when the approve call is refused (no 30s poll)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { h } = fakeHarness((c) =>
      c.path.endsWith('/approve')
        ? {
            status: 400,
            body: {
              error: 'VALIDATION_ERROR',
              message: 'Cannot approve proposal with unfilled required fields: scheduledStart, scheduledEnd',
              details: { missingFields: ['scheduledStart', 'scheduledEnd'] },
            },
          }
        : { status: 200, body: { status: 'ready_for_review' } },
    );

    const started = Date.now();
    const outcome = await approveAndAwaitExecution(h, 'tok', 'p-1', '02');

    expect(Date.now() - started).toBeLessThan(1000);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(outcome.status).toBe('approve_rejected');
    expect(outcome.rejection).toEqual({
      httpStatus: 400,
      message: 'Cannot approve proposal with unfilled required fields: scheduledStart, scheduledEnd',
      missingFields: ['scheduledStart', 'scheduledEnd'],
    });
  });
});

describe('voiceInput', () => {
  // The exact disambiguation turn the dev API returned for VOX-05 on
  // 2026-09-26 (fixture customer + the VOX-13 ambiguous pair all at 1.0).
  const ambiguousTurn = {
    state: 'entity_resolution',
    proposalIds: [],
    sideEffects: [
      {
        type: 'tts_play',
        payload: {
          text: 'entity_disambiguate',
          template: 'disambiguate',
          candidates: [
            { id: 'cust-amb-1', name: 'qa-matrix-A-ambiguous-1', score: 1, hint: '555-0200' },
            { id: 'cust-amb-2', name: 'qa-matrix-A-ambiguous-2', score: 1, hint: '555-0200' },
            { id: 'cust-main', name: 'qa-matrix-A-customer', score: 1, hint: '555-0100' },
          ],
        },
      },
    ],
  };

  it('answers a disambiguation question with the expected candidate, then confirms the intent', async () => {
    const { h, calls } = fakeHarness((c) => {
      const text = (c.body as { text?: string }).text;
      if (text === 'qa-matrix-A-customer') return { status: 200, body: { state: 'intent_confirm', proposalIds: [] } };
      if (text === "Yes, that's correct.") return { status: 200, body: { state: 'closing', proposalIds: ['p-9'] } };
      return { status: 200, body: ambiguousTurn };
    });

    const ids = await voiceInput(h, 'tok', 's-1', 'Draft an estimate for the QA Matrix job', '05', {
      pickCandidateIds: ['cust-main'],
    });

    expect(ids).toEqual(['p-9']);
    expect(calls.map((c) => (c.body as { text: string }).text)).toEqual([
      'Draft an estimate for the QA Matrix job',
      'qa-matrix-A-customer',
      "Yes, that's correct.",
    ]);
  });

  // #1492 (VOX-07) — customer-then-job disambiguation asks twice: which
  // customer, then which of that customer's jobs.
  const jobPickerTurn = {
    state: 'entity_resolution',
    proposalIds: [],
    sideEffects: [
      {
        type: 'tts_play',
        payload: {
          template: 'disambiguate',
          candidates: [
            { id: 'job-other', name: 'Maintenance visit', score: 1 },
            { id: 'job-main', name: 'QA Matrix job for run-1', score: 1 },
          ],
        },
      },
    ],
  };

  it('answers successive resolution rounds (which customer, then which job) and reaches the proposal', async () => {
    const { h, calls } = fakeHarness((c) => {
      const text = (c.body as { text?: string }).text;
      if (text === 'qa-matrix-A-customer') return { status: 200, body: jobPickerTurn };
      if (text === 'QA Matrix job for run-1') return { status: 200, body: { state: 'intent_confirm', proposalIds: [] } };
      if (text === "Yes, that's correct.") return { status: 200, body: { state: 'closing', proposalIds: ['p-7'] } };
      return { status: 200, body: ambiguousTurn };
    });

    const ids = await voiceInput(h, 'tok', 's-1', 'Create an invoice for the QA Matrix job', '07', {
      pickCandidateIds: ['cust-main', 'job-main'],
    });

    expect(ids).toEqual(['p-7']);
    expect(calls.map((c) => (c.body as { text: string }).text)).toEqual([
      'Create an invoice for the QA Matrix job',
      'qa-matrix-A-customer',
      'QA Matrix job for run-1',
      "Yes, that's correct.",
    ]);
  });

  it('stops after three resolution rounds when the product keeps asking', async () => {
    const { h, calls } = fakeHarness(() => ({ status: 200, body: ambiguousTurn }));

    const ids = await voiceInput(h, 'tok', 's-1', 'Create an invoice for the QA Matrix job', '07', {
      pickCandidateIds: ['cust-main'],
    });

    expect(ids).toEqual([]);
    expect(calls).toHaveLength(4); // the utterance + three answers
  });

  it('never answers a question whose candidates hold none of the records the row means', async () => {
    const { h, calls } = fakeHarness((c) =>
      (c.body as { text?: string }).text === 'qa-matrix-A-customer'
        ? { status: 200, body: jobPickerTurn }
        : { status: 200, body: ambiguousTurn },
    );

    const ids = await voiceInput(h, 'tok', 's-1', 'Create an invoice for the QA Matrix job', '07', {
      pickCandidateIds: ['cust-main', 'job-not-offered'],
    });

    expect(ids).toEqual([]);
    expect(calls.map((c) => (c.body as { text: string }).text)).toEqual([
      'Create an invoice for the QA Matrix job',
      'qa-matrix-A-customer',
    ]);
  });
});

describe('ensureTenantTimezone', () => {
  it('sets the matrix zone when the tenant has never chosen one (dev tenant A on 2026-09-26)', async () => {
    const { h, calls } = fakeHarness((c) =>
      c.method === 'GET'
        ? { status: 200, body: { tenantId: 't-a', businessName: 'My Business', timezone: null } }
        : { status: 200, body: { tenantId: 't-a', timezone: 'America/New_York' } },
    );

    const zone = await ensureTenantTimezone(h, 'tok', '02');

    expect(zone).toBe('America/New_York');
    expect(calls.map((c) => [c.method, c.path, c.body])).toEqual([
      ['GET', '/api/settings', undefined],
      ['PUT', '/api/settings', { timezone: 'America/New_York' }],
    ]);
  });

  it("never overwrites a zone the tenant already chose", async () => {
    const { h, calls } = fakeHarness(() => ({ status: 200, body: { tenantId: 't-b', timezone: 'America/Phoenix' } }));

    const zone = await ensureTenantTimezone(h, 'tok', '03');

    expect(zone).toBe('America/Phoenix');
    expect(calls.map((c) => c.method)).toEqual(['GET']);
  });
});

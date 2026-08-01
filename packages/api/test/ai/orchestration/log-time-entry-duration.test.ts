/**
 * Retroactive time capture — "put me down for two hours on this one".
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Confirmed live against Development: "Put down that this was two hours not
 * one hour for this one" produced an `add_note` proposal with payload
 * `{"body":"this was two hours not one hour","targetKind":"job"}` — no time
 * entry, and the technician's billable hours surviving only as prose inside a
 * note nobody bills from. A second phrasing, "This took two hours, did not
 * take one hour", produced a `voice_clarification` at confidence 0.3.
 *
 * Two independent defects:
 *   1. `log_time_entry` was defined in the classifier prompt as "start
 *      tracking time (clock in)" with only clock-in examples, so retroactive
 *      fixed-duration phrasing was never taught.
 *   2. There was NO duration entity anywhere in the taxonomy — the only
 *      log_time_entry field was `timeEntryType`. Even a correct
 *      classification would have had its "two hours" silently stripped by the
 *      strict extraction whitelist in parseClassifierJson.
 *
 * (2) is deterministic and pinned end-to-end below: classifier JSON →
 * ExtractedEntities → proposal payload → the created time entry. (1) is LLM
 * behaviour, so it is pinned the only way a prompt can be — by asserting the
 * teaching text and examples are present in SYSTEM_PROMPT.
 *
 * NO LIVE LLM CALLS — the gateway is a stub returning the canonical response
 * the model would emit (the established pattern from
 * intent-classifier.launch-fixtures.test.ts).
 */
import { describe, it, expect, vi } from 'vitest';
import { classifyIntent, SYSTEM_PROMPT } from '../../../src/ai/orchestration/intent-classifier';
import { LLMGateway, LLMResponse } from '../../../src/ai/gateway/gateway';
import {
  LogTimeEntryTaskHandler,
  AddNoteTaskHandler,
} from '../../../src/ai/tasks/voice-extended-tasks';
import { TaskContext } from '../../../src/ai/tasks/task-handlers';
import { LogTimeEntryExecutionHandler } from '../../../src/proposals/execution/full-app-voice-handlers';
import { logTimeEntryPayloadSchema } from '../../../src/proposals/contracts';
import { InMemoryTimeEntryRepository } from '../../../src/time-tracking/time-entry';
import { TimeEntryService } from '../../../src/time-tracking/time-entry-service';

const TENANT = 't-voicefix';
const USER = 'u-tech';

function mockGateway(jsonContent: string): LLMGateway {
  return {
    complete: vi.fn(
      async () =>
        ({
          content: jsonContent,
          model: 'mock-model',
          provider: 'mock',
          tokenUsage: { input: 100, output: 50, total: 150 },
          latencyMs: 42,
        }) satisfies LLMResponse,
    ),
  } as unknown as LLMGateway;
}

function ctx(overrides: Partial<TaskContext>): TaskContext {
  return { tenantId: TENANT, userId: USER, message: 'test transcript', ...overrides };
}

describe('log_time_entry — the classifier prompt teaches retroactive duration', () => {
  // The failing utterances, verbatim, plus the phrasings the owner reported.
  const taughtPhrasings = [
    'Put me down for two hours on this one',
    'Put down that this was two hours',
    'Put down that this was two hours not one hour for this one',
    'Log two hours on the Miller job',
    'This took two hours',
    'This took two hours, did not take one hour',
  ];

  for (const phrase of taughtPhrasings) {
    it(`teaches "${phrase}" as a log_time_entry example`, () => {
      expect(SYSTEM_PROMPT).toContain(phrase);
    });
  }

  it('still teaches the clock-in phrasings — no regression on the original meaning', () => {
    for (const phrase of [
      'Clock me in on the Miller job',
      'Start my drive time',
      'Log time on the Rodriguez install',
    ]) {
      expect(SYSTEM_PROMPT).toContain(phrase);
    }
  });

  it('declares durationMinutes in the JSON output schema, in MINUTES', () => {
    expect(SYSTEM_PROMPT).toContain('"durationMinutes"');
    // The unit is load-bearing: time_entries.duration_minutes is an INTEGER
    // minutes column, so the prompt must not leave hours-vs-minutes open.
    expect(SYSTEM_PROMPT).toContain('"two hours" is 120');
  });

  it('teaches the correction case — "two hours not one hour" keeps only two hours', () => {
    expect(SYSTEM_PROMPT).toContain('two hours not one hour');
    expect(SYSTEM_PROMPT).toContain('never 60 and never both');
  });

  it('draws the add_note boundary explicitly so observations are not stolen', () => {
    expect(SYSTEM_PROMPT).toContain('Add a note that I found flue liner corrosion');
    expect(SYSTEM_PROMPT).toContain('is log_time_entry, not add_note');
  });
});

describe('log_time_entry — durationMinutes survives the extraction whitelist', () => {
  // parseClassifierJson copies a fixed whitelist of keys onto
  // ExtractedEntities and silently drops everything else. This is where
  // "two hours" died even when the model got the intent right.
  async function classify(entities: Record<string, unknown>) {
    return classifyIntent(
      'Put down that this was two hours not one hour for this one',
      { tenantId: TENANT },
      mockGateway(
        JSON.stringify({
          intentType: 'log_time_entry',
          confidence: 0.93,
          reasoning: 'retroactive duration',
          extractedEntities: entities,
        }),
      ),
    );
  }

  it('carries durationMinutes through to extractedEntities', async () => {
    const out = await classify({ durationMinutes: 120, timeEntryType: 'job' });
    expect(out.intentType).toBe('log_time_entry');
    expect(out.extractedEntities?.durationMinutes).toBe(120);
    expect(out.extractedEntities?.timeEntryType).toBe('job');
  });

  it('rounds a fractional duration and rejects zero/negative/non-numeric', async () => {
    expect((await classify({ durationMinutes: 89.6 })).extractedEntities?.durationMinutes).toBe(90);
    expect((await classify({ durationMinutes: 0 })).extractedEntities?.durationMinutes).toBeUndefined();
    expect((await classify({ durationMinutes: -30 })).extractedEntities?.durationMinutes).toBeUndefined();
    expect(
      (await classify({ durationMinutes: 'two hours' })).extractedEntities?.durationMinutes,
    ).toBeUndefined();
  });

  it('a plain clock-in carries no duration', async () => {
    const out = await classify({ timeEntryType: 'drive' });
    expect(out.extractedEntities?.durationMinutes).toBeUndefined();
  });
});

describe('LogTimeEntryTaskHandler — the duration reaches the payload', () => {
  const JOB_ID = '33333333-3333-4333-8333-333333333333';

  it('"Put down that this was two hours not one hour for this one" → 120 minutes on the payload', async () => {
    const res = await new LogTimeEntryTaskHandler().handle(
      ctx({
        message: 'Put down that this was two hours not one hour for this one',
        existingEntities: { durationMinutes: 120, jobReference: 'this one', jobId: JOB_ID },
      }),
    );
    expect(res.proposal.proposalType).toBe('log_time_entry');
    expect(res.proposal.payload.durationMinutes).toBe(120);
    // The correction resolved to the LATER value only — one hour never lands,
    // and the two are never summed into 180.
    expect(res.proposal.payload.durationMinutes).not.toBe(60);
    expect(res.proposal.payload.durationMinutes).not.toBe(180);
    expect(res.proposal.summary).toBe('Logging 2 hours on this one — right?');
    // Capture-class with no trust tier — a human still taps approve.
    expect(res.proposal.status).toBe('draft');
  });

  it('"This took two hours, did not take one hour" → 120 minutes on the payload', async () => {
    const res = await new LogTimeEntryTaskHandler().handle(
      ctx({
        message: 'This took two hours, did not take one hour',
        existingEntities: { durationMinutes: 120, jobId: JOB_ID },
      }),
    );
    expect(res.proposal.payload.durationMinutes).toBe(120);
    expect(res.proposal.summary).toBe('Logging 2 hours on this job — right?');
  });

  it('a non-job entry reads back its own kind and still carries the duration', async () => {
    const res = await new LogTimeEntryTaskHandler().handle(
      ctx({ existingEntities: { timeEntryType: 'drive', durationMinutes: 90 } }),
    );
    expect(res.proposal.payload.durationMinutes).toBe(90);
    expect(res.proposal.summary).toBe('Logging 1 hour 30 minutes of drive time — right?');
  });

  it('REGRESSION — a clock-in carries no durationMinutes and its readback is unchanged', async () => {
    const res = await new LogTimeEntryTaskHandler().handle(
      ctx({
        message: 'Clock me in on the Miller job',
        existingEntities: { jobReference: 'the Miller job', jobId: JOB_ID },
      }),
    );
    expect(res.proposal.payload.durationMinutes).toBeUndefined();
    expect(res.proposal.payload.entryType).toBe('job');
    expect(res.proposal.summary).toBe('Clocking you in on the Miller job — right?');
  });

  it('the payload contract accepts the duration and rejects a fractional one', () => {
    expect(
      logTimeEntryPayloadSchema.safeParse({ entryType: 'job', durationMinutes: 120 }).success,
    ).toBe(true);
    expect(
      logTimeEntryPayloadSchema.safeParse({ entryType: 'job', durationMinutes: 12.5 }).success,
    ).toBe(false);
    // Absent is still valid — that is the clock-in shape.
    expect(logTimeEntryPayloadSchema.safeParse({ entryType: 'job' }).success).toBe(true);
  });
});

describe('log_time_entry execution — the duration lands on the created time entry', () => {
  it('records a CLOSED two-hour entry rather than opening a shift', async () => {
    const repo = new InMemoryTimeEntryRepository();
    const service = new TimeEntryService(repo);
    const handler = new LogTimeEntryExecutionHandler(service);

    const { proposal } = await new LogTimeEntryTaskHandler().handle(
      ctx({
        message: 'Put me down for two hours on this one',
        existingEntities: {
          durationMinutes: 120,
          jobReference: 'this one',
          jobId: '33333333-3333-4333-8333-333333333333',
        },
      }),
    );

    const result = await handler.execute(proposal, { tenantId: TENANT, executedBy: USER });
    expect(result.success).toBe(true);

    const [entry] = repo.getAll();
    expect(entry.durationMinutes).toBe(120);
    expect(entry.clockedOutAt).toBeDefined();
    expect(entry.jobId).toBe('33333333-3333-4333-8333-333333333333');
    // The window is exactly the stated duration, in the minutes unit the
    // time_entries table stores.
    expect(entry.clockedOutAt!.getTime() - entry.clockedInAt.getTime()).toBe(120 * 60_000);
    // Born closed — so it never trips the one-open-entry-per-user index and
    // the weekly rollup can sum it immediately.
    expect(await repo.findActiveByUser(TENANT, USER)).toBeNull();
  });

  it('does NOT disturb a shift the technician still has running', async () => {
    const repo = new InMemoryTimeEntryRepository();
    const service = new TimeEntryService(repo);
    const handler = new LogTimeEntryExecutionHandler(service);

    const open = await service.clockIn(TENANT, USER, { entryType: 'job' });

    const { proposal } = await new LogTimeEntryTaskHandler().handle(
      ctx({ existingEntities: { timeEntryType: 'admin', durationMinutes: 45 } }),
    );
    const result = await handler.execute(proposal, { tenantId: TENANT, executedBy: USER });

    expect(result.success).toBe(true);
    const stillOpen = await repo.findActiveByUser(TENANT, USER);
    expect(stillOpen?.id).toBe(open.id);
    expect(repo.getAll().find((e) => e.id !== open.id)?.durationMinutes).toBe(45);
  });

  it('REGRESSION — a clock-in proposal still opens an entry with no duration', async () => {
    const repo = new InMemoryTimeEntryRepository();
    const service = new TimeEntryService(repo);
    const handler = new LogTimeEntryExecutionHandler(service);

    const { proposal } = await new LogTimeEntryTaskHandler().handle(
      ctx({
        message: 'Clock me in on the Miller job',
        existingEntities: { jobId: '44444444-4444-4444-8444-444444444444' },
      }),
    );
    const result = await handler.execute(proposal, { tenantId: TENANT, executedBy: USER });

    expect(result.success).toBe(true);
    const active = await repo.findActiveByUser(TENANT, USER);
    expect(active).not.toBeNull();
    expect(active?.durationMinutes).toBeUndefined();
    expect(active?.clockedOutAt).toBeUndefined();
  });
});

describe('add_note is not stolen by the widened log_time_entry definition', () => {
  it('"Add a note that I found flue liner corrosion" still drafts an add_note proposal', async () => {
    // An observation with no worked duration: the prompt's distinction line
    // keeps it on add_note, and the note path is untouched by this change.
    const res = await new AddNoteTaskHandler().handle(
      ctx({
        message: 'Add a note that I found flue liner corrosion',
        existingEntities: {
          noteBody: 'found flue liner corrosion',
          noteTargetKind: 'job',
          jobReference: 'this one',
        },
      }),
    );
    expect(res.proposal.proposalType).toBe('add_note');
    expect(res.proposal.payload.body).toBe('found flue liner corrosion');
    expect(res.proposal.payload.targetKind).toBe('job');
    // No time entity leaks onto a note.
    expect(res.proposal.payload.durationMinutes).toBeUndefined();
  });

  it('an add_note classification never carries a duration into extractedEntities', async () => {
    const out = await classifyIntent(
      'Add a note that I found flue liner corrosion',
      { tenantId: TENANT },
      mockGateway(
        JSON.stringify({
          intentType: 'add_note',
          confidence: 0.94,
          reasoning: 'observation, no worked time',
          extractedEntities: { noteBody: 'found flue liner corrosion', noteTargetKind: 'job' },
        }),
      ),
    );
    expect(out.intentType).toBe('add_note');
    expect(out.extractedEntities?.durationMinutes).toBeUndefined();
    expect(out.extractedEntities?.noteBody).toBe('found flue liner corrosion');
  });
});

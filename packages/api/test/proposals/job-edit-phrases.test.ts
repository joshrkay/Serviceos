/**
 * `parseJobEditFields` — the deterministic live-turn parse that keeps an
 * `update_job` voice card from being minted with nothing to change.
 *
 * Two properties matter more than coverage of any one phrase:
 *   - every value it emits is a member of the CANONICAL shared enums
 *     (`jobStatusSchema` / `jobPrioritySchema`), so an approved proposal can
 *     never carry a status the jobs table's CHECK constraint rejects;
 *   - anything it is unsure of parses to `{}`, so the caller gates rather
 *     than defaults. "Never guess" is the whole point of the module.
 */
import { describe, it, expect } from 'vitest';
import { jobStatusSchema, jobPrioritySchema } from '@ai-service-os/shared';
import {
  parseJobEditFields,
  normalizeJobStatus,
  normalizeJobPriority,
} from '../../src/proposals/job-edit-phrases';

describe('parseJobEditFields — spoken status', () => {
  it.each([
    ["Set Johnson's water heater job to in progress", 'in_progress'],
    ['Start the Henderson job', 'in_progress'],
    ['The Patel job is started', 'in_progress'],
    ['Mark the Garcia job complete', 'completed'],
    ['The Khan install is done', 'completed'],
    ['We finished the Smith job', 'completed'],
    ['Cancel the Lee job', 'canceled'],
    ['That job was cancelled', 'canceled'],
    ['Put the Garcia job on hold', 'scheduled'],
    ['Pause the Khan job', 'scheduled'],
    ['The Smith job is dispatched', 'dispatched'],
    ['Mark the Lee job scheduled', 'scheduled'],
    ['The Patel job has not started', 'new'],
  ])('%s → %s', (text, status) => {
    expect(parseJobEditFields(text).status).toBe(status);
  });

  it('every emitted status is a jobStatusSchema member', () => {
    const phrases = [
      'to in progress',
      'is done',
      'on hold',
      'cancel it',
      'dispatched',
      'not started',
      'invoiced',
      'closed',
    ];
    for (const phrase of phrases) {
      const { status } = parseJobEditFields(phrase);
      if (status !== undefined) expect(jobStatusSchema.safeParse(status).success).toBe(true);
    }
  });

  it('"not started" is never read as "started" (longest idea wins)', () => {
    expect(parseJobEditFields('The job has not started yet').status).toBe('new');
  });

  it('"reschedule" is not a status word', () => {
    expect(parseJobEditFields('Reschedule the Garcia job').status).toBeUndefined();
  });
});

describe('parseJobEditFields — spoken priority', () => {
  it.each([
    ['Mark the Henderson job as urgent priority', 'urgent'],
    ['Set the Garcia job to high priority', 'high'],
    ['Change the Khan job priority to low', 'low'],
    ['Set the Lee job to medium priority', 'normal'],
    ['Set the Lee job to normal priority', 'normal'],
  ])('%s → %s', (text, priority) => {
    expect(parseJobEditFields(text).priority).toBe(priority);
  });

  it('every emitted priority is a jobPrioritySchema member', () => {
    for (const phrase of ['urgent priority', 'high priority', 'medium priority', 'low priority']) {
      const { priority } = parseJobEditFields(phrase);
      expect(priority).toBeDefined();
      expect(jobPrioritySchema.safeParse(priority).success).toBe(true);
    }
  });

  it('an urgency word inside a job DESCRIPTION is not a priority change', () => {
    // No "priority" anywhere: this names the job, it does not re-rank it.
    expect(parseJobEditFields('Set the urgent leak job to in progress')).toEqual({
      status: 'in_progress',
    });
  });
});

describe('parseJobEditFields — refuses to guess', () => {
  it.each([undefined, '', '   ', 'Do something about the Johnson job', 'yes'])(
    '%s → {}',
    (text) => {
      expect(parseJobEditFields(text)).toEqual({});
    },
  );

  it('never invents a title (a wrong rename is silent data corruption, not a gate)', () => {
    const parsed = parseJobEditFields('Rename the Smith job to water heater replacement');
    expect(parsed).not.toHaveProperty('title');
  });
});

describe('the normalizers shared with UpdateJobTaskHandler', () => {
  it('accepts the spoken spelling of a canonical status', () => {
    expect(normalizeJobStatus('In Progress')).toBe('in_progress');
    expect(normalizeJobStatus('  completed ')).toBe('completed');
  });

  it('rejects a value outside the enum rather than snapping to the nearest', () => {
    expect(normalizeJobStatus('on_hold')).toBeUndefined();
    expect(normalizeJobStatus('finished')).toBeUndefined();
    expect(normalizeJobPriority('medium')).toBeUndefined();
    expect(normalizeJobStatus(42)).toBeUndefined();
    expect(normalizeJobPriority(null)).toBeUndefined();
  });

  it('covers every member of both shared enums', () => {
    for (const status of jobStatusSchema.options) {
      expect(normalizeJobStatus(status)).toBe(status);
    }
    for (const priority of jobPrioritySchema.options) {
      expect(normalizeJobPriority(priority)).toBe(priority);
    }
  });
});

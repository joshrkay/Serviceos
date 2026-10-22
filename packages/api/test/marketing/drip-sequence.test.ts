import { describe, it, expect } from 'vitest';
import {
  addMinutes,
  advanceAfterStep,
  createDripSequenceSchema,
  DEFAULT_TARGET_DAYS,
  exitReasonForBlock,
  firstRunAt,
  renderStepBody,
  type DripStep,
} from '../../src/marketing/drip/sequence';

const sms = (delayMinutes: number): DripStep => ({ channel: 'sms', delayMinutes, body: 'Hi' });

describe('drip sequence contract', () => {
  it('accepts sms, email and call steps', () => {
    const parsed = createDripSequenceSchema.parse({
      name: 'Win back',
      targetKind: 'lapsed_customers',
      steps: [
        { channel: 'sms', delayMinutes: 0, body: 'Hi {{firstName}}' },
        { channel: 'email', delayMinutes: 1440, subject: 'Checking in', body: 'Hello' },
        { channel: 'call', delayMinutes: 2880, agentPhone: '+15551234567' },
      ],
    });
    expect(parsed.steps).toHaveLength(3);
  });

  it('rejects an empty sequence, bad phone, unknown channel and too many steps', () => {
    const base = { name: 'x', targetKind: 'lapsed_customers' as const };
    expect(() => createDripSequenceSchema.parse({ ...base, steps: [] })).toThrow();
    expect(() =>
      createDripSequenceSchema.parse({ ...base, steps: [{ channel: 'call', delayMinutes: 0, agentPhone: '555' }] }),
    ).toThrow();
    expect(() =>
      createDripSequenceSchema.parse({ ...base, steps: [{ channel: 'fax', delayMinutes: 0, body: 'x' }] }),
    ).toThrow();
    expect(() =>
      createDripSequenceSchema.parse({ ...base, steps: Array.from({ length: 9 }, () => sms(0)) }),
    ).toThrow();
  });

  it('rejects a negative or over-long delay and an unknown target kind', () => {
    expect(() =>
      createDripSequenceSchema.parse({ name: 'x', targetKind: 'lapsed_customers', steps: [sms(-1)] }),
    ).toThrow();
    expect(() =>
      createDripSequenceSchema.parse({ name: 'x', targetKind: 'lapsed_customers', steps: [sms(60 * 24 * 31)] }),
    ).toThrow();
    expect(() => createDripSequenceSchema.parse({ name: 'x', targetKind: 'everyone', steps: [sms(0)] })).toThrow();
  });

  it('accepts membership renewals, defaulting to 30 days before the membership ends (#1735)', () => {
    const parsed = createDripSequenceSchema.parse({ name: 'Renew', targetKind: 'membership_renewals', steps: [sms(0)] });
    expect(parsed.targetKind).toBe('membership_renewals');
    expect(DEFAULT_TARGET_DAYS.membership_renewals).toBe(30);
  });
});

describe('drip scheduling', () => {
  const now = new Date('2026-10-22T12:00:00Z');

  it('schedules the first step after its own delay', () => {
    expect(firstRunAt([sms(30)], now)).toEqual(addMinutes(now, 30));
  });

  it('advances to the next step using that step delay, and finishes after the last', () => {
    const steps = [sms(0), sms(60), sms(120)];
    expect(advanceAfterStep(steps, 0, now)).toEqual({ done: false, currentStep: 1, nextRunAt: addMinutes(now, 60) });
    expect(advanceAfterStep(steps, 2, now)).toEqual({ done: true });
  });
});

describe('drip helpers', () => {
  it('renders the first name, falling back to display name then "there"', () => {
    expect(renderStepBody('Hi {{firstName}}!', { firstName: 'Pat' })).toBe('Hi Pat!');
    expect(renderStepBody('Hi {{ firstName }}', { firstName: '', displayName: 'Pat Q' })).toBe('Hi Pat');
    expect(renderStepBody('Hi {{firstName}}', {})).toBe('Hi there');
  });

  it('maps only opt-out style blocks to an exit', () => {
    expect(exitReasonForBlock('dnc')).toBe('opted_out');
    expect(exitReasonForBlock('revoked')).toBe('opted_out');
    expect(exitReasonForBlock('no_consent')).toBeNull();
    expect(exitReasonForBlock('channel_disabled')).toBeNull();
  });
});

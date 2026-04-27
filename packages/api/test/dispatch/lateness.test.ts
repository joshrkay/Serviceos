import { describe, expect, it } from 'vitest';
import { computeDispatchLateness } from '../../src/dispatch/lateness';

const baseNow = new Date('2026-03-14T14:00:00.000Z');
const serviceLocation = { latitude: 40.7128, longitude: -74.006 };

describe('dispatch lateness intelligence', () => {
  it('ignores GPS jitter false positives using ping count and dwell threshold', () => {
    const result = computeDispatchLateness({
      scheduledStart: new Date('2026-03-14T13:00:00.000Z'),
      scheduledEnd: new Date('2026-03-14T14:00:00.000Z'),
      technicianId: 'tech-1',
      serviceLocation,
      now: baseNow,
      pings: [
        { occurredAt: new Date('2026-03-14T13:58:00.000Z'), latitude: 40.712805, longitude: -74.006005 },
        { occurredAt: new Date('2026-03-14T13:59:00.000Z'), latitude: 40.7139, longitude: -74.0072 },
        { occurredAt: new Date('2026-03-14T14:00:00.000Z'), latitude: 40.7142, longitude: -74.0075 },
      ],
    }, {
      geofenceRadiusMeters: 150,
      minimumPingCount: 2,
      minimumDwellMinutes: 3,
    });

    expect(result.progressState).toBe('in_transit');
    expect(result.elapsedOnSiteMinutes).toBe(0);
    expect(result.latenessState).toBe('on_track');
  });

  it('falls back to unknown when no recent signal exists', () => {
    const result = computeDispatchLateness({
      scheduledStart: new Date('2026-03-14T13:00:00.000Z'),
      scheduledEnd: new Date('2026-03-14T14:00:00.000Z'),
      technicianId: 'tech-1',
      serviceLocation,
      now: baseNow,
      pings: [
        { occurredAt: new Date('2026-03-14T13:30:00.000Z'), latitude: 40.7128, longitude: -74.006 },
        { occurredAt: new Date('2026-03-14T13:31:00.000Z'), latitude: 40.7128, longitude: -74.006 },
      ],
    }, {
      noSignalUnknownAfterMinutes: 10,
    });

    expect(result.progressState).toBe('unknown');
  });

  it('transitions across risk threshold and prompt-required threshold deterministically', () => {
    const pings = [
      { occurredAt: new Date('2026-03-14T13:10:00.000Z'), latitude: 40.7128, longitude: -74.006 },
      { occurredAt: new Date('2026-03-14T13:20:00.000Z'), latitude: 40.7128, longitude: -74.006 },
      { occurredAt: new Date('2026-03-14T13:30:00.000Z'), latitude: 40.7128, longitude: -74.006 },
      { occurredAt: new Date('2026-03-14T13:40:00.000Z'), latitude: 40.7128, longitude: -74.006 },
      { occurredAt: new Date('2026-03-14T13:50:00.000Z'), latitude: 40.7128, longitude: -74.006 },
      { occurredAt: new Date('2026-03-14T14:19:00.000Z'), latitude: 40.7128, longitude: -74.006 },
    ];

    const atRisk = computeDispatchLateness({
      scheduledStart: new Date('2026-03-14T13:00:00.000Z'),
      scheduledEnd: new Date('2026-03-14T14:00:00.000Z'),
      technicianId: 'tech-1',
      serviceLocation,
      pings,
      now: new Date('2026-03-14T13:55:00.000Z'),
      expectedDurationBaselineMinutes: 60,
    }, {
      preThresholdRatio: 0.75,
      latenessGraceMinutes: 5,
    });

    expect(atRisk.progressState).toBe('at_site');
    expect(atRisk.latenessState).toBe('at_risk');

    const promptRequired = computeDispatchLateness({
      scheduledStart: new Date('2026-03-14T13:00:00.000Z'),
      scheduledEnd: new Date('2026-03-14T14:00:00.000Z'),
      technicianId: 'tech-1',
      serviceLocation,
      pings,
      now: new Date('2026-03-14T14:20:00.000Z'),
      expectedDurationBaselineMinutes: 60,
    }, {
      preThresholdRatio: 0.75,
      latenessGraceMinutes: 5,
    });

    expect(promptRequired.latenessState).toBe('late_prompt_required');
    expect(promptRequired.promptRequired).toBe(true);
  });

  it('moves to late_confirmed when technician supplies a delay bucket', () => {
    const result = computeDispatchLateness({
      scheduledStart: new Date('2026-03-14T13:00:00.000Z'),
      scheduledEnd: new Date('2026-03-14T14:00:00.000Z'),
      technicianId: 'tech-1',
      serviceLocation,
      now: new Date('2026-03-14T14:25:00.000Z'),
      selectedDelayBucket: 20,
      pings: [
        { occurredAt: new Date('2026-03-14T13:10:00.000Z'), latitude: 40.7128, longitude: -74.006 },
        { occurredAt: new Date('2026-03-14T13:15:00.000Z'), latitude: 40.7128, longitude: -74.006 },
      ],
    });

    expect(result.latenessState).toBe('late_confirmed');
    expect(result.selectedDelayBucket).toBe(20);
  });

  it('suppresses repeated prompts when cooldown is active', () => {
    const result = computeDispatchLateness({
      scheduledStart: new Date('2026-03-14T13:00:00.000Z'),
      scheduledEnd: new Date('2026-03-14T14:00:00.000Z'),
      technicianId: 'tech-1',
      serviceLocation,
      now: new Date('2026-03-14T14:20:00.000Z'),
      lastPromptAt: new Date('2026-03-14T14:10:00.000Z'),
      expectedDurationBaselineMinutes: 60,
      pings: [
        { occurredAt: new Date('2026-03-14T13:10:00.000Z'), latitude: 40.7128, longitude: -74.006 },
        { occurredAt: new Date('2026-03-14T13:20:00.000Z'), latitude: 40.7128, longitude: -74.006 },
        { occurredAt: new Date('2026-03-14T13:30:00.000Z'), latitude: 40.7128, longitude: -74.006 },
        { occurredAt: new Date('2026-03-14T14:19:00.000Z'), latitude: 40.7128, longitude: -74.006 },
      ],
    }, {
      promptCooldownMinutes: 15,
      latenessGraceMinutes: 5,
    });

    expect(result.latenessState).toBe('at_risk');
    expect(result.promptRequired).toBe(false);
    expect(result.promptSuppressedByCooldown).toBe(true);
  });
});

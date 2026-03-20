import { describe, it, expect, beforeEach } from 'vitest';
import { createMockLLMGateway } from '../../../../src/ai/gateway/factory';
import { ScheduleExtractor } from '../../../../src/ai/tasks/onboarding/schedule-extractor';
import { ExtractionContext } from '../../../../src/ai/tasks/onboarding/types';
import { MockLLMProvider } from '../../../../src/ai/providers/mock';
import { LLMGateway } from '../../../../src/ai/gateway/gateway';
import * as fs from 'fs';
import * as path from 'path';

const fixturesDir = path.join(__dirname, '../../../fixtures/onboarding');

function loadFixture(name: string): string {
  return fs.readFileSync(path.join(fixturesDir, name), 'utf-8');
}

function makeContext(transcript: string): ExtractionContext {
  return { tenantId: 'tenant-001', transcript, userId: 'user-001' };
}

describe('P4-EXT-005 — Schedule and SLA extraction from voice transcript', () => {
  let gateway: LLMGateway;
  let provider: MockLLMProvider;
  let extractor: ScheduleExtractor;

  beforeEach(() => {
    const mock = createMockLLMGateway();
    gateway = mock.gateway;
    provider = mock.provider;
    extractor = new ScheduleExtractor(gateway);
  });

  // T3-008: Schedule extraction — "We run 8 to 5 Monday through Friday, Saturdays in summer"
  it('T3-008 — extracts working hours and seasonal patterns', async () => {
    provider.setDefaultResponse(JSON.stringify({
      working_hours: [
        {
          days: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
          start_time: '08:00',
          end_time: '17:00',
        },
        {
          days: ['saturday'],
          start_time: '08:00',
          end_time: '17:00',
          seasonal: 'summer',
        },
      ],
      sla: {
        type: 'emergency',
        hours_target: 4,
        is_guarantee: false,
        source_text: 'Emergency calls we try to get to within 4 hours',
      },
      confidence_score: 0.88,
    }));

    const result = await extractor.extract(makeContext(loadFixture('fixture-01-hvac-happy-path.txt')));

    expect(result.data.workingHours).toHaveLength(2);
    const weekday = result.data.workingHours.find((wh) => wh.days.includes('monday'));
    expect(weekday).toBeDefined();
    expect(weekday!.startTime).toBe('08:00');
    expect(weekday!.endTime).toBe('17:00');

    const saturday = result.data.workingHours.find((wh) => wh.days.includes('saturday'));
    expect(saturday).toBeDefined();
    expect(saturday!.seasonal).toBe('summer');
  });

  // T3-009: SLA extraction — "Emergency calls within 4 hours"
  it('T3-009 — extracts SLA as best-effort (not guarantee)', async () => {
    provider.setDefaultResponse(JSON.stringify({
      working_hours: [
        {
          days: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
          start_time: '08:00',
          end_time: '17:00',
        },
      ],
      sla: {
        type: 'emergency',
        hours_target: 4,
        is_guarantee: false,
        source_text: 'we try to get to within 4 hours',
      },
      confidence_score: 0.85,
    }));

    const result = await extractor.extract(makeContext(loadFixture('fixture-01-hvac-happy-path.txt')));

    expect(result.data.sla).toBeDefined();
    expect(result.data.sla!.type).toBe('emergency');
    expect(result.data.sla!.hoursTarget).toBe(4);
    expect(result.data.sla!.isGuarantee).toBe(false);
  });

  it('extracts Monday through Saturday schedule', async () => {
    provider.setDefaultResponse(JSON.stringify({
      working_hours: [
        {
          days: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'],
          start_time: '07:00',
          end_time: '16:00',
        },
      ],
      sla: null,
      confidence_score: 0.9,
    }));

    const result = await extractor.extract(makeContext(loadFixture('fixture-02-plumbing.txt')));

    expect(result.data.workingHours).toHaveLength(1);
    expect(result.data.workingHours[0].days).toHaveLength(6);
    expect(result.data.workingHours[0].startTime).toBe('07:00');
  });

  it('requests clarification when no schedule extracted', async () => {
    provider.setDefaultResponse(JSON.stringify({
      working_hours: [],
      sla: null,
      confidence_score: 0.2,
    }));

    const result = await extractor.extract(makeContext(loadFixture('fixture-04-vague-incomplete.txt')));

    expect(result.needsClarification).toBe(true);
    expect(result.clarificationQuestions!.length).toBeGreaterThan(0);
  });

  it('filters out entries with invalid days', async () => {
    provider.setDefaultResponse(JSON.stringify({
      working_hours: [
        { days: ['monday', 'tuesday'], start_time: '08:00', end_time: '17:00' },
        { days: ['funday'], start_time: '08:00', end_time: '12:00' },
      ],
      sla: null,
      confidence_score: 0.7,
    }));

    const result = await extractor.extract(makeContext('We work Mon-Tue'));

    // Second entry should be filtered out since 'funday' is not a valid day
    expect(result.data.workingHours).toHaveLength(1);
  });
});

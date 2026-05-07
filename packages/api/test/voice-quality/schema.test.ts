/**
 * VQ-001 — Voice Quality script schema + rubric versioning.
 *
 * Covers:
 *   - VoiceQualityScriptSchema parses valid scripts and rejects malformed ones
 *   - rubric.v1.json loads with exactly 12 criteria and validates against
 *     RubricSchema (gradedBy enum enforced)
 *   - Sanity-check on criterion #1 (noPiiLeak / floor / mechanical)
 */
import { describe, it, expect } from 'vitest';
import {
  VoiceQualityScriptSchema,
  RubricSchema,
} from '../../src/ai/voice-quality/schema';
import { loadRubric } from '../../src/ai/voice-quality/rubric/rubric-loader';

describe('VQ-001 — VoiceQualityScriptSchema', () => {
  const validScript = {
    id: 'happy-lookup-appointments',
    bucket: '01-happy-lookups',
    fixtures: {
      tenant: { id: 'tenant-1', timezone: 'America/Los_Angeles' },
      customers: [{ id: 'cust-1', phone: '+15551234567' }],
    },
    callerId: '+15551234567',
    turns: [
      {
        caller: "When's my next appointment?",
        expected: {
          intent: 'lookup_appointments',
          spokenAnswerMatches: 'next appointment',
        },
      },
    ],
    grading: {
      appliesFloor: [1, 2, 3, 4, 5, 6, 7, 8],
      appliesDisposition: [9, 10, 11, 12],
    },
  };

  it('VQ-001 — parses a valid script and applies defaults', () => {
    const parsed = VoiceQualityScriptSchema.parse(validScript);
    expect(parsed.id).toBe('happy-lookup-appointments');
    expect(parsed.callerIdBlocked).toBe(false);
    expect(parsed.layer2Eligible).toBe(false);
    expect(parsed.turns[0].hangupAfter).toBe(false);
  });

  it('VQ-001 — rejects script missing required `id`', () => {
    const { id: _omit, ...rest } = validScript;
    expect(() => VoiceQualityScriptSchema.parse(rest)).toThrow();
  });

  it('VQ-001 — rejects script with `id` that violates kebab-case regex', () => {
    expect(() =>
      VoiceQualityScriptSchema.parse({ ...validScript, id: 'BadID_With_Underscores' }),
    ).toThrow();
  });

  it('VQ-001 — rejects script with invalid `bucket` enum', () => {
    expect(() =>
      VoiceQualityScriptSchema.parse({ ...validScript, bucket: '99-not-a-bucket' }),
    ).toThrow();
  });

  it('VQ-001 — rejects floor criterion outside 1..8', () => {
    expect(() =>
      VoiceQualityScriptSchema.parse({
        ...validScript,
        grading: { appliesFloor: [9], appliesDisposition: [9] },
      }),
    ).toThrow();
  });

  it('VQ-001 — rejects disposition criterion outside 9..12', () => {
    expect(() =>
      VoiceQualityScriptSchema.parse({
        ...validScript,
        grading: { appliesFloor: [1], appliesDisposition: [1] },
      }),
    ).toThrow();
  });

  it('VQ-001 — accepts callerId of null (caller-id-blocked path)', () => {
    const parsed = VoiceQualityScriptSchema.parse({
      ...validScript,
      callerId: null,
      callerIdBlocked: true,
    });
    expect(parsed.callerId).toBeNull();
    expect(parsed.callerIdBlocked).toBe(true);
  });
});

describe('VQ-001 — Rubric loader + schema', () => {
  it('VQ-001 — loadRubric("v1") returns exactly 12 criteria', () => {
    const rubric = loadRubric('v1');
    expect(rubric.version).toBe('v1');
    expect(rubric.criteria).toHaveLength(12);
  });

  it('VQ-001 — criterion #1 is noPiiLeak / floor / mechanical', () => {
    const rubric = loadRubric('v1');
    const c1 = rubric.criteria.find((c) => c.id === 1);
    expect(c1).toBeDefined();
    expect(c1?.name).toBe('noPiiLeak');
    expect(c1?.layer).toBe('floor');
    expect(c1?.gradedBy).toBe('mechanical');
    expect(c1?.description).toMatch(/PII|phone|balance/i);
  });

  it('VQ-001 — floor criteria are ids 1..8 and disposition criteria are 9..12', () => {
    const rubric = loadRubric('v1');
    const floors = rubric.criteria.filter((c) => c.layer === 'floor').map((c) => c.id).sort((a, b) => a - b);
    const dispos = rubric.criteria.filter((c) => c.layer === 'disposition').map((c) => c.id).sort((a, b) => a - b);
    expect(floors).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(dispos).toEqual([9, 10, 11, 12]);
  });

  it('VQ-001 — RubricSchema rejects an unknown gradedBy value', () => {
    expect(() =>
      RubricSchema.parse({
        version: 'v1',
        criteria: [
          {
            id: 1,
            name: 'noPiiLeak',
            layer: 'floor',
            gradedBy: 'telepathy',
            description: 'nope',
          },
        ],
      }),
    ).toThrow();
  });

  it('VQ-001 — RubricSchema rejects an unknown layer value', () => {
    expect(() =>
      RubricSchema.parse({
        version: 'v1',
        criteria: [
          {
            id: 1,
            name: 'noPiiLeak',
            layer: 'mezzanine',
            gradedBy: 'mechanical',
            description: 'nope',
          },
        ],
      }),
    ).toThrow();
  });
});

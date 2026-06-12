/**
 * Rivet P2 F-1 — `_meta` marker/annotation helpers.
 *
 * Critical property: every payload these helpers emit must still pass
 * `validateProposalPayload` (the `_meta` envelope requires
 * overallConfidence and non-empty marker paths) — otherwise a
 * supervisor-touched proposal would become uneditable in the review UI.
 */
import { describe, it, expect } from 'vitest';
import {
  SUPERVISOR_MARKER_PATH,
  hasSupervisorAnnotation,
  payloadWithSupervisorAnnotation,
  payloadWithSupervisorMarker,
} from '../../../src/proposals/supervisor/marker';
import { validateProposalPayload } from '../../../src/proposals/contracts';

describe('payloadWithSupervisorMarker', () => {
  it('appends a supervisor marker and synthesizes overallConfidence=medium when _meta is absent (neutral synthesis — never score-derived)', () => {
    const payload = { name: 'Ada Lovelace' };
    // confidenceScore intentionally passed but must NOT influence the synthesized value.
    const next = payloadWithSupervisorMarker(payload, ['daily cap exceeded'], 0.93);
    const meta = next._meta as Record<string, unknown>;
    // Architect ruling: always 'medium' on synthesis, never score-derived ('high').
    expect(meta.overallConfidence).toBe('medium');
    expect(meta.markers).toEqual([
      { path: SUPERVISOR_MARKER_PATH, reason: 'supervisor: daily cap exceeded' },
    ]);
    // Non-mutating.
    expect(payload).toEqual({ name: 'Ada Lovelace' });
  });

  it('defaults overallConfidence to medium when there is no confidence score', () => {
    const next = payloadWithSupervisorMarker({ name: 'x' }, ['r']);
    expect((next._meta as Record<string, unknown>).overallConfidence).toBe('medium');
  });

  it('preserves existing _meta fields and existing markers', () => {
    const payload = {
      name: 'x',
      _meta: {
        overallConfidence: 'low',
        markers: [{ path: 'name', reason: 'fuzzy match' }],
        fieldConfidence: { name: 'low' },
      },
    };
    const next = payloadWithSupervisorMarker(payload, ['a', 'b'], 0.99);
    const meta = next._meta as Record<string, unknown>;
    // Existing (valid) level wins — the supervisor never rewrites confidence.
    expect(meta.overallConfidence).toBe('low');
    expect(meta.fieldConfidence).toEqual({ name: 'low' });
    expect(meta.markers).toEqual([
      { path: 'name', reason: 'fuzzy match' },
      { path: SUPERVISOR_MARKER_PATH, reason: 'supervisor: a; b' },
    ]);
  });

  it('emits a payload that still passes validateProposalPayload', () => {
    const next = payloadWithSupervisorMarker({ name: 'Ada' }, ['blocked type'], 0.4);
    const result = validateProposalPayload('create_customer', next);
    expect(result).toEqual({ valid: true });
  });
});

describe('payloadWithSupervisorAnnotation / hasSupervisorAnnotation', () => {
  const annotation = {
    riskSummary: 'Large invoice for a brand-new customer.',
    flags: ['new_customer', 'high_amount'],
    annotatedAt: '2026-06-11T12:00:00.000Z',
  };

  it('writes the annotation under _meta and round-trips the presence check', () => {
    const payload = { name: 'Ada' };
    expect(hasSupervisorAnnotation(payload)).toBe(false);
    const next = payloadWithSupervisorAnnotation(payload, annotation, 0.7);
    expect(hasSupervisorAnnotation(next)).toBe(true);
    expect((next._meta as Record<string, unknown>).supervisorAnnotation).toEqual(annotation);
  });

  it('annotated payloads still pass validateProposalPayload (unknown _meta key strips, never rejects)', () => {
    const next = payloadWithSupervisorAnnotation({ name: 'Ada' }, annotation);
    expect(validateProposalPayload('create_customer', next)).toEqual({ valid: true });
  });

  it('hasSupervisorAnnotation tolerates malformed _meta shapes', () => {
    expect(hasSupervisorAnnotation({ _meta: null })).toBe(false);
    expect(hasSupervisorAnnotation({ _meta: 'nope' })).toBe(false);
    expect(hasSupervisorAnnotation({ _meta: [] })).toBe(false);
    expect(hasSupervisorAnnotation({})).toBe(false);
  });
});

import {
  assessConfidence,
  getConfidenceLevel,
  formatConfidenceForDisplay,
  validateConfidenceScore,
} from '../../src/ai/guardrails/confidence';
import type { ConfidenceMetadata } from '../../src/ai/guardrails/confidence';

describe('P2-012 — Confidence storage and display', () => {
  it('happy path — assesses confidence from AI output', () => {
    const aiOutput = {
      confidence_score: 0.85,
      explanation: 'Customer details clearly stated',
      payload: { name: 'John Doe' },
      model: 'gpt-4',
      field1: 'value1',
    };

    const metadata = assessConfidence(aiOutput);

    expect(metadata.score).toBe(0.85);
    expect(metadata.factors).toContain('model_provided_confidence');
    expect(metadata.factors).toContain('explanation_present');
    expect(metadata.factors).toContain('payload_present');
    expect(metadata.factors).toContain('high_field_coverage');
    expect(metadata.model).toBe('gpt-4');
    expect(metadata.assessedAt).toBeInstanceOf(Date);
  });

  it('happy path — defaults to 0.5 when no confidence in output', () => {
    const aiOutput = {
      someField: 'someValue',
    };

    const metadata = assessConfidence(aiOutput);

    expect(metadata.score).toBe(0.5);
    expect(metadata.factors).not.toContain('model_provided_confidence');
    expect(metadata.model).toBeUndefined();
  });

  it('happy path — formats high confidence for display', () => {
    const metadata: ConfidenceMetadata = {
      score: 0.92,
      factors: ['model_provided_confidence', 'high_field_coverage'],
      model: 'gpt-4',
      assessedAt: new Date(),
    };

    const display = formatConfidenceForDisplay(metadata);

    expect(display.level).toBe('high');
    expect(display.label).toBe('High Confidence');
    expect(display.description).toContain('92%');
    expect(display.description).toContain('highly confident');
    expect(display.description).toContain('model_provided_confidence');
  });

  it('happy path — formats low confidence for display', () => {
    const metadata: ConfidenceMetadata = {
      score: 0.25,
      factors: ['low_field_coverage'],
      assessedAt: new Date(),
    };

    const display = formatConfidenceForDisplay(metadata);

    expect(display.level).toBe('very_low');
    expect(display.label).toBe('Very Low Confidence');
    expect(display.description).toContain('25%');
    expect(display.description).toContain('very low confidence');
    expect(display.description).toContain('low_field_coverage');
  });

  it('validation — rejects score outside 0-1 range', () => {
    expect(validateConfidenceScore(-0.1)).toBe(false);
    expect(validateConfidenceScore(1.1)).toBe(false);
    expect(validateConfidenceScore(NaN)).toBe(false);
    expect(validateConfidenceScore(0)).toBe(true);
    expect(validateConfidenceScore(1)).toBe(true);
    expect(validateConfidenceScore(0.5)).toBe(true);
  });

  it('happy path — confidence levels map correctly', () => {
    expect(getConfidenceLevel(1.0)).toBe('high');
    expect(getConfidenceLevel(0.8)).toBe('high');
    expect(getConfidenceLevel(0.79)).toBe('medium');
    expect(getConfidenceLevel(0.5)).toBe('medium');
    expect(getConfidenceLevel(0.49)).toBe('low');
    expect(getConfidenceLevel(0.3)).toBe('low');
    expect(getConfidenceLevel(0.29)).toBe('very_low');
    expect(getConfidenceLevel(0)).toBe('very_low');
  });

  it('invalid transition — confidence never triggers auto-execute (advisory only)', () => {
    // Confidence metadata is purely informational.
    // Verify that assessConfidence and formatConfidenceForDisplay produce data only
    // and contain no side effects, state mutations, or execution triggers.
    const highConfidenceOutput = {
      confidence_score: 0.99,
      explanation: 'Perfect match',
      payload: { data: 'complete' },
      model: 'gpt-4',
      extra: 'field',
    };

    const metadata = assessConfidence(highConfidenceOutput);
    const display = formatConfidenceForDisplay(metadata);

    // These functions only return data — no auto-approval or auto-execution properties
    expect(metadata).not.toHaveProperty('approved');
    expect(metadata).not.toHaveProperty('executed');
    expect(metadata).not.toHaveProperty('autoApprove');
    expect(metadata).not.toHaveProperty('autoExecute');
    expect(display).not.toHaveProperty('approved');
    expect(display).not.toHaveProperty('executed');
    expect(display).not.toHaveProperty('autoApprove');
    expect(display).not.toHaveProperty('autoExecute');

    // Return value is strictly: score, factors, model, assessedAt
    expect(Object.keys(metadata).sort()).toEqual(['assessedAt', 'factors', 'model', 'score']);
    // Display return value is strictly: level, label, description
    expect(Object.keys(display).sort()).toEqual(['description', 'label', 'level']);
  });

  it('idempotency — same input produces same confidence', () => {
    const aiOutput = {
      confidence_score: 0.75,
      explanation: 'Partial match',
      payload: { name: 'Test' },
    };

    const metadata1 = assessConfidence(aiOutput);
    const metadata2 = assessConfidence(aiOutput);

    expect(metadata1.score).toBe(metadata2.score);
    expect(metadata1.factors).toEqual(metadata2.factors);
    expect(metadata1.model).toBe(metadata2.model);

    const display1 = formatConfidenceForDisplay(metadata1);
    const display2 = formatConfidenceForDisplay(metadata2);

    expect(display1.level).toBe(display2.level);
    expect(display1.label).toBe(display2.label);
  });
});

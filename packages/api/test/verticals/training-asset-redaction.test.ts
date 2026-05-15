import { describe, expect, it } from 'vitest';
import { TrainingAssetRedactionService } from '../../src/verticals/training-asset-redaction';

describe('TrainingAssetRedactionService', () => {
  it('returns scrubbed text and audit-safe redaction metadata', () => {
    const service = new TrainingAssetRedactionService();

    const result = service.redact({
      text: 'My name is Sarah Jones, call me at 415-555-0123 about 10 Main St.',
      knownEntities: {
        names: ['Sarah Jones'],
      },
    });

    expect(result.scrubbedText).toContain('[CALLER_NAME]');
    expect(result.scrubbedText).toContain('[PHONE]');
    expect(result.scrubbedText).toContain('[ADDRESS]');
    expect(result.summary.redactionCount).toBeGreaterThanOrEqual(3);
    expect(result.summary.redactionKinds).toContain('known_name');
    expect(result.auditRedactions[0]).not.toHaveProperty('matched');
  });

  it('marks residual PII as quarantine-required without throwing', () => {
    const service = new TrainingAssetRedactionService();

    const result = service.redact({
      text: 'Customer account 123456789 needs no heat dispatch.',
    });

    expect(result.status).toBe('quarantined');
    expect(result.summary.hasResidualPii).toBe(true);
    expect(result.summary.residualSignals).toContain('digit_run_ge_7');
  });
});

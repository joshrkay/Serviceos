import { describe, it, expect } from 'vitest';
import {
  composeContextPreface,
  MAX_PREFACE_CHARS,
} from '../../../src/voice/triage/context-preface';
import type { VulnerabilitySignal } from '@ai-service-os/shared';

const medSig: VulnerabilitySignal = { kind: 'medical', evidence: 'caller mentioned oxygen', weight: 1 };
const ageSig: VulnerabilitySignal = { kind: 'age', evidence: 'age >65 on record', weight: 1 };
const weatherSig: VulnerabilitySignal = { kind: 'weather', evidence: 'extreme heat 104°F in last 24h', weight: 1 };

describe('P8-016 triage context preface (deterministic template)', () => {
  it('matches the required template shape', () => {
    const p = composeContextPreface({
      signals: [medSig, ageSig],
      reason: 'no AC in extreme heat',
      customer: { firstName: 'Maria', customerSinceYear: 2024 },
    });
    expect(p).toContain('Vulnerability:');
    expect(p).toContain('Reason: no AC in extreme heat');
    expect(p).toContain('Customer Maria, customer since 2024');
    expect(p.endsWith('Putting them through.')).toBe(true);
  });

  it('excludes PII — no full address, phone, email, or DOB', () => {
    const p = composeContextPreface({
      signals: [medSig, ageSig, weatherSig],
      reason: 'no AC in extreme heat',
      customer: { firstName: 'Maria', customerSinceYear: 2024 },
    });
    expect(p).not.toMatch(/\d{1,5}\s+\w+\s+(street|st|avenue|ave|road|rd|lane|ln|drive|dr)/i);
    expect(p).not.toMatch(/@/); // no email
    expect(p).not.toMatch(/\d{3}[-.]\d{3}[-.]\d{4}/); // no phone
    expect(p).not.toMatch(/\b\d{4}-\d{2}-\d{2}\b/); // no ISO DOB
  });

  it('does not assert a clinical claim (no medical authority)', () => {
    const p = composeContextPreface({
      signals: [medSig],
      reason: 'medical priority',
      customer: { firstName: 'Sam' },
    });
    expect(p).not.toMatch(/you have a medical emergency|diagnos/i);
  });

  it('handles an unknown caller without leaking identity', () => {
    const p = composeContextPreface({ signals: [weatherSig], reason: 'extreme cold' });
    expect(p).toContain('Customer unknown caller');
  });

  it('stays within the 5s character budget even with long input', () => {
    const p = composeContextPreface({
      signals: [medSig, ageSig, weatherSig],
      reason: 'x'.repeat(500),
      customer: { firstName: 'Maria', customerSinceYear: 2024 },
    });
    expect(p.length).toBeLessThanOrEqual(MAX_PREFACE_CHARS);
    expect(p.endsWith('Putting them through.')).toBe(true);
  });
});

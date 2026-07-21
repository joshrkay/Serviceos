import { describe, expect, it } from 'vitest';
import { normalizeEntityAlias } from '../../../src/learning/entity-aliases/entity-alias';

describe('normalizeEntityAlias', () => {
  it('normalizes case and whitespace without changing the tenant-facing reference meaning', () => {
    expect(normalizeEntityAlias('  The   Khan  Account ')).toBe('the khan account');
  });

  it('rejects empty and control-character aliases', () => {
    expect(() => normalizeEntityAlias('   ')).toThrow(/alias/i);
    expect(() => normalizeEntityAlias('Khan\u0000')).toThrow(/alias/i);
  });
});

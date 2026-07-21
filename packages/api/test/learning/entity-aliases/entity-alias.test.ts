import { describe, expect, it } from 'vitest';
import {
  InMemoryEntityAliasRepository,
  normalizeEntityAlias,
} from '../../../src/learning/entity-aliases/entity-alias';

describe('normalizeEntityAlias', () => {
  it('normalizes case and whitespace without changing the tenant-facing reference meaning', () => {
    expect(normalizeEntityAlias('  The   Khan  Account ')).toBe('the khan account');
  });

  it('rejects empty and control-character aliases', () => {
    expect(() => normalizeEntityAlias('   ')).toThrow(/alias/i);
    expect(() => normalizeEntityAlias('Khan\u0000')).toThrow(/alias/i);
  });

  it('keeps active aliases tenant scoped and deactivatable', async () => {
    const repo = new InMemoryEntityAliasRepository();
    await repo.activate({
      tenantId: 'tenant-a',
      entityKind: 'customer',
      entityId: 'customer-a',
      alias: 'Khan',
      source: 'entity_picker',
      sourceProposalId: 'proposal-a',
      createdBy: 'owner-a',
    });

    expect(await repo.findActive('tenant-a', 'customer', '  khan ')).toMatchObject({
      entityId: 'customer-a',
    });
    expect(await repo.findActive('tenant-b', 'customer', 'Khan')).toBeNull();

    await repo.deactivate('tenant-a', 'customer', 'Khan', 'owner-a');
    expect(await repo.findActive('tenant-a', 'customer', 'Khan')).toBeNull();
  });
});

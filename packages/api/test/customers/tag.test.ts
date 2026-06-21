import { describe, it, expect, beforeEach } from 'vitest';
import {
  InMemoryTagRepository,
  addCustomerTag,
  removeCustomerTag,
  listCustomerTags,
  normalizeTag,
  validateTag,
} from '../../src/customers/tag';
import { InMemoryAuditRepository } from '../../src/audit/audit';

const TENANT = '11111111-1111-1111-1111-111111111111';
const OTHER_TENANT = '99999999-9999-9999-9999-999999999999';
const C1 = '22222222-2222-2222-2222-222222222222';
const C2 = '33333333-3333-3333-3333-333333333333';
const ACTOR = 'user-1';

describe('customer tags (U2) — pure domain', () => {
  let repo: InMemoryTagRepository;
  let audit: InMemoryAuditRepository;

  beforeEach(() => {
    repo = new InMemoryTagRepository();
    audit = new InMemoryAuditRepository();
  });

  it('normalizes tags (trim + collapse whitespace)', () => {
    expect(normalizeTag('  VIP  ')).toBe('VIP');
    expect(normalizeTag('net   30')).toBe('net 30');
  });

  it('validates tags', () => {
    expect(validateTag('   ')).toContain('tag is required');
    expect(validateTag('x'.repeat(51))).toContain('tag must be 50 characters or fewer');
    expect(validateTag('vip')).toHaveLength(0);
  });

  it('adds a tag and emits an audit event', async () => {
    await addCustomerTag(TENANT, C1, '  vip ', repo, ACTOR, audit);
    expect(await listCustomerTags(TENANT, C1, repo)).toEqual(['vip']);
    const events = await audit.findByEntity(TENANT, 'customer', C1);
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('customer.tagged');
    expect(events[0].metadata).toMatchObject({ tag: 'vip' });
  });

  it('add is idempotent and does not double-audit', async () => {
    await addCustomerTag(TENANT, C1, 'vip', repo, ACTOR, audit);
    await addCustomerTag(TENANT, C1, 'vip', repo, ACTOR, audit);
    expect(await listCustomerTags(TENANT, C1, repo)).toEqual(['vip']);
    expect(await audit.findByEntity(TENANT, 'customer', C1)).toHaveLength(1);
  });

  it('removes a tag', async () => {
    await addCustomerTag(TENANT, C1, 'vip', repo);
    await addCustomerTag(TENANT, C1, 'net 30', repo);
    await removeCustomerTag(TENANT, C1, 'vip', repo, ACTOR, audit);
    expect(await listCustomerTags(TENANT, C1, repo)).toEqual(['net 30']);
  });

  it('lists customer ids by tag (drives the list filter)', async () => {
    await addCustomerTag(TENANT, C1, 'vip', repo);
    await addCustomerTag(TENANT, C2, 'vip', repo);
    await addCustomerTag(TENANT, C2, 'snowbird', repo);
    const vips = (await repo.listCustomerIdsByTag(TENANT, 'vip')).sort();
    expect(vips).toEqual([C1, C2].sort());
    expect(await repo.listCustomerIdsByTag(TENANT, 'snowbird')).toEqual([C2]);
  });

  it('does not leak tags across tenants', async () => {
    await addCustomerTag(TENANT, C1, 'vip', repo);
    expect(await listCustomerTags(OTHER_TENANT, C1, repo)).toEqual([]);
    expect(await repo.listCustomerIdsByTag(OTHER_TENANT, 'vip')).toEqual([]);
    expect(await repo.listDistinctTags(OTHER_TENANT)).toEqual([]);
  });
});

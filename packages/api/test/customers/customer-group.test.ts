import { describe, it, expect, beforeEach } from 'vitest';
import {
  InMemoryCustomerGroupRepository,
  addCustomerToGroup,
  archiveCustomerGroup,
  createCustomerGroup,
  removeCustomerFromGroup,
  updateCustomerGroup,
  validateCustomerGroupInput,
} from '../../src/customers/customer-group';
import { InMemoryAuditRepository } from '../../src/audit/audit';

const TENANT = '11111111-1111-1111-1111-111111111111';
const C1 = 'cccccccc-0000-0000-0000-000000000001';
const C2 = 'cccccccc-0000-0000-0000-000000000002';
const ACTOR = 'user-1';

describe('customer groups (U8) — pure domain', () => {
  let repo: InMemoryCustomerGroupRepository;
  let audit: InMemoryAuditRepository;

  beforeEach(() => {
    repo = new InMemoryCustomerGroupRepository();
    audit = new InMemoryAuditRepository();
  });

  it('validates name and color', () => {
    expect(validateCustomerGroupInput({ name: '' })).toContain('name is required');
    expect(validateCustomerGroupInput({ name: 'VIP', color: 'blue' })).toContain(
      'color must be a hex value like #3b82f6',
    );
    expect(validateCustomerGroupInput({ name: 'VIP', color: '#3b82f6' })).toHaveLength(0);
  });

  it('creates a group, emits audit, and rejects a duplicate name', async () => {
    const g = await createCustomerGroup(
      { tenantId: TENANT, name: 'Service plan members', color: '#3b82f6', createdBy: ACTOR },
      repo,
      audit,
    );
    expect(g.name).toBe('Service plan members');
    const events = await audit.findByEntity(TENANT, 'customer_group', g.id);
    expect(events[0].eventType).toBe('customer_group.created');

    await expect(
      createCustomerGroup({ tenantId: TENANT, name: 'service plan members', createdBy: ACTOR }, repo),
    ).rejects.toThrow(/already exists/);
  });

  it('adds and removes members idempotently with counts', async () => {
    const g = await createCustomerGroup({ tenantId: TENANT, name: 'VIP', createdBy: ACTOR }, repo);
    expect(await addCustomerToGroup(TENANT, g.id, C1, repo, ACTOR, audit)).toBe(true);
    expect(await addCustomerToGroup(TENANT, g.id, C1, repo)).toBe(false); // idempotent
    await addCustomerToGroup(TENANT, g.id, C2, repo);

    expect((await repo.listMemberIds(TENANT, g.id)).sort()).toEqual([C1, C2].sort());
    const groups = await repo.listGroups(TENANT);
    expect(groups.find((x) => x.id === g.id)?.memberCount).toBe(2);

    await removeCustomerFromGroup(TENANT, g.id, C1, repo, ACTOR, audit);
    expect(await repo.listMemberIds(TENANT, g.id)).toEqual([C2]);
  });

  it('lists groups for a customer (active only)', async () => {
    const a = await createCustomerGroup({ tenantId: TENANT, name: 'A', createdBy: ACTOR }, repo);
    const b = await createCustomerGroup({ tenantId: TENANT, name: 'B', createdBy: ACTOR }, repo);
    await addCustomerToGroup(TENANT, a.id, C1, repo);
    await addCustomerToGroup(TENANT, b.id, C1, repo);
    expect((await repo.listGroupsForCustomer(TENANT, C1)).map((g) => g.name)).toEqual(['A', 'B']);

    await archiveCustomerGroup(TENANT, b.id, repo, ACTOR, audit);
    expect((await repo.listGroupsForCustomer(TENANT, C1)).map((g) => g.name)).toEqual(['A']);
  });

  it('blocks adding to an archived group', async () => {
    const g = await createCustomerGroup({ tenantId: TENANT, name: 'Old', createdBy: ACTOR }, repo);
    await archiveCustomerGroup(TENANT, g.id, repo, ACTOR);
    await expect(addCustomerToGroup(TENANT, g.id, C1, repo)).rejects.toThrow(/archived/);
  });

  it('renames a group and rejects a colliding rename', async () => {
    const a = await createCustomerGroup({ tenantId: TENANT, name: 'A', createdBy: ACTOR }, repo);
    await createCustomerGroup({ tenantId: TENANT, name: 'B', createdBy: ACTOR }, repo);
    const renamed = await updateCustomerGroup(TENANT, a.id, { name: 'A1' }, repo, ACTOR, audit);
    expect(renamed.name).toBe('A1');
    await expect(updateCustomerGroup(TENANT, a.id, { name: 'B' }, repo)).rejects.toThrow(/already exists/);
  });

  it('isolates groups + membership by tenant', async () => {
    const g = await createCustomerGroup({ tenantId: TENANT, name: 'A', createdBy: ACTOR }, repo);
    await addCustomerToGroup(TENANT, g.id, C1, repo);
    const other = '99999999-9999-9999-9999-999999999999';
    expect(await repo.findGroupById(other, g.id)).toBeNull();
    expect(await repo.listGroups(other)).toHaveLength(0);
    expect(await repo.listMemberIds(other, g.id)).toEqual([]);
  });
});

import { describe, it, expect, beforeEach } from 'vitest';
import {
  InMemoryContactRepository,
  createContact,
  listContacts,
  updateContact,
  archiveContact,
  validateContactInput,
} from '../../src/customers/contact';
import { InMemoryAuditRepository } from '../../src/audit/audit';

const TENANT = '11111111-1111-1111-1111-111111111111';
const CUSTOMER = '22222222-2222-2222-2222-222222222222';
const ACTOR = 'user-1';

describe('customer contacts (U1) — pure domain', () => {
  let repo: InMemoryContactRepository;
  let audit: InMemoryAuditRepository;

  beforeEach(() => {
    repo = new InMemoryContactRepository();
    audit = new InMemoryAuditRepository();
  });

  it('creates a contact and emits an audit event', async () => {
    const contact = await createContact(
      {
        tenantId: TENANT,
        customerId: CUSTOMER,
        name: 'Dana Decider',
        role: 'primary',
        phone: '555-123-4567',
        email: 'dana@example.com',
        isPrimary: true,
        createdBy: ACTOR,
      },
      repo,
      audit
    );

    expect(contact.id).toBeTruthy();
    expect(contact.role).toBe('primary');
    expect(contact.isPrimary).toBe(true);

    const events = await audit.findByEntity(TENANT, 'customer_contact', contact.id);
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('customer_contact.created');
    expect(events[0].metadata).toMatchObject({ customerId: CUSTOMER, role: 'primary' });
  });

  it('rejects a contact with no name', async () => {
    await expect(
      createContact(
        { tenantId: TENANT, customerId: CUSTOMER, name: '   ', createdBy: ACTOR },
        repo
      )
    ).rejects.toThrow(/name is required/);
  });

  it('validates phone, email and role format', () => {
    expect(validateContactInput({ name: 'X', phone: '123' })).toContain('Invalid phone format');
    expect(validateContactInput({ name: 'X', email: 'not-an-email' })).toContain(
      'Invalid email format'
    );
    expect(validateContactInput({ name: 'X', role: 'manager' })).toContain('Invalid role');
    expect(validateContactInput({ name: 'X', phone: '555-123-4567' })).toHaveLength(0);
  });

  it('enforces one primary contact per customer (a new primary demotes the old)', async () => {
    const first = await createContact(
      { tenantId: TENANT, customerId: CUSTOMER, name: 'First', isPrimary: true, createdBy: ACTOR },
      repo
    );
    await createContact(
      { tenantId: TENANT, customerId: CUSTOMER, name: 'Second', isPrimary: true, createdBy: ACTOR },
      repo
    );

    const list = await listContacts(TENANT, CUSTOMER, repo);
    const primaries = list.filter((c) => c.isPrimary);
    expect(primaries).toHaveLength(1);
    expect(primaries[0].name).toBe('Second');

    const reloadedFirst = await repo.findById(TENANT, first.id);
    expect(reloadedFirst!.isPrimary).toBe(false);
  });

  it('promoting an existing contact to primary via update demotes the prior primary', async () => {
    const a = await createContact(
      { tenantId: TENANT, customerId: CUSTOMER, name: 'A', isPrimary: true, createdBy: ACTOR },
      repo
    );
    const b = await createContact(
      { tenantId: TENANT, customerId: CUSTOMER, name: 'B', role: 'billing', createdBy: ACTOR },
      repo
    );

    await updateContact(TENANT, b.id, { isPrimary: true }, repo, ACTOR, audit);

    expect((await repo.findById(TENANT, a.id))!.isPrimary).toBe(false);
    expect((await repo.findById(TENANT, b.id))!.isPrimary).toBe(true);
  });

  it('archives a contact: excluded from the active list and no longer primary', async () => {
    const c = await createContact(
      { tenantId: TENANT, customerId: CUSTOMER, name: 'Temp', isPrimary: true, createdBy: ACTOR },
      repo
    );

    const archived = await archiveContact(TENANT, c.id, repo, ACTOR, audit);
    expect(archived!.isArchived).toBe(true);
    expect(archived!.isPrimary).toBe(false);

    const active = await listContacts(TENANT, CUSTOMER, repo);
    expect(active.find((x) => x.id === c.id)).toBeUndefined();

    const withArchived = await listContacts(TENANT, CUSTOMER, repo, true);
    expect(withArchived.find((x) => x.id === c.id)).toBeTruthy();
  });

  it('lists contacts primary-first, then by role', async () => {
    await createContact(
      { tenantId: TENANT, customerId: CUSTOMER, name: 'Site Sam', role: 'site', createdBy: ACTOR },
      repo
    );
    await createContact(
      { tenantId: TENANT, customerId: CUSTOMER, name: 'Bill Bob', role: 'billing', createdBy: ACTOR },
      repo
    );
    const primary = await createContact(
      {
        tenantId: TENANT,
        customerId: CUSTOMER,
        name: 'Pat Primary',
        role: 'primary',
        isPrimary: true,
        createdBy: ACTOR,
      },
      repo
    );

    const list = await listContacts(TENANT, CUSTOMER, repo);
    expect(list[0].id).toBe(primary.id);
    expect(list.map((c) => c.role)).toEqual(['primary', 'billing', 'site']);
  });

  it('returns null when updating a contact in another tenant', async () => {
    const c = await createContact(
      { tenantId: TENANT, customerId: CUSTOMER, name: 'X', createdBy: ACTOR },
      repo
    );
    const result = await updateContact(
      '99999999-9999-9999-9999-999999999999',
      c.id,
      { name: 'Hacked' },
      repo
    );
    expect(result).toBeNull();
  });
});

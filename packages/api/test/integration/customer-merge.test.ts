import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgCustomerMergeRepository } from '../../src/customers/pg-merge';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { PgLocationRepository } from '../../src/locations/pg-location';
import { PgContactRepository } from '../../src/customers/pg-contact';
import { PgTagRepository } from '../../src/customers/pg-tag';
import { PgNoteRepository } from '../../src/notes/pg-note';
import { createContact } from '../../src/customers/contact';
import { mergeCustomers } from '../../src/customers/merge';
import type { Customer } from '../../src/customers/customer';

/**
 * Story 4.6 — customer merge against REAL Postgres. A mocked Pool can't
 * prove cross-table re-parenting, the conflict-aware tag/cfv moves, the
 * contact demotion, the entity-ref note move, or that the FK + RLS hold —
 * so this runs the full transaction end to end.
 */
function baseCustomer(tenantId: string, userId: string, name: string): Customer {
  const now = new Date();
  return {
    id: crypto.randomUUID(),
    tenantId,
    firstName: name,
    lastName: 'Test',
    displayName: `${name} Test`,
    preferredChannel: 'phone',
    smsConsent: false,
    isArchived: false,
    createdBy: userId,
    createdAt: now,
    updatedAt: now,
  };
}

describe('Postgres integration — customer merge (Story 4.6)', () => {
  let pool: Pool;
  let customers: PgCustomerRepository;
  let mergeRepo: PgCustomerMergeRepository;
  let jobs: PgJobRepository;
  let locations: PgLocationRepository;
  let contacts: PgContactRepository;
  let tags: PgTagRepository;
  let notes: PgNoteRepository;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    customers = new PgCustomerRepository(pool);
    mergeRepo = new PgCustomerMergeRepository(pool);
    jobs = new PgJobRepository(pool);
    locations = new PgLocationRepository(pool);
    contacts = new PgContactRepository(pool);
    tags = new PgTagRepository(pool);
    notes = new PgNoteRepository(pool);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('re-parents jobs/locations/tags/contacts/notes onto the survivor and archives the loser', async () => {
    const t = await createTestTenant(pool);
    const survivor = await customers.create(baseCustomer(t.tenantId, t.userId, 'Survivor'));
    const loser = await customers.create(baseCustomer(t.tenantId, t.userId, 'Loser'));

    // Loser-owned service location + job.
    const loc = await locations.create({
      id: crypto.randomUUID(),
      tenantId: t.tenantId,
      customerId: loser.id,
      street1: '1 Loser Ln',
      city: 'Austin',
      state: 'TX',
      postalCode: '78701',
      country: 'USA',
      isPrimary: true,
      isArchived: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const job = await jobs.create({
      id: crypto.randomUUID(),
      tenantId: t.tenantId,
      customerId: loser.id,
      locationId: loc.id,
      jobNumber: `JOB-${crypto.randomUUID().slice(0, 4)}`,
      summary: 'Loser job',
      status: 'scheduled',
      priority: 'normal',
      createdBy: t.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Tags — survivor + loser share 'vip'; loser also has a unique 'net30'.
    await tags.addTag(t.tenantId, survivor.id, 'vip');
    await tags.addTag(t.tenantId, loser.id, 'vip');
    await tags.addTag(t.tenantId, loser.id, 'net30');

    // Loser primary contact (should arrive demoted).
    await createContact(
      {
        tenantId: t.tenantId,
        customerId: loser.id,
        name: 'Loser Primary',
        role: 'primary',
        isPrimary: true,
        phone: '555-222-3333',
        createdBy: t.userId,
      },
      contacts,
    );

    // Note attached to the loser.
    await notes.create({
      id: crypto.randomUUID(),
      tenantId: t.tenantId,
      entityType: 'customer',
      entityId: loser.id,
      content: 'Prefers mornings',
      authorId: t.userId,
      authorRole: 'owner',
      isPinned: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const result = await mergeCustomers(
      t.tenantId,
      { survivingId: survivor.id, losingId: loser.id, actorId: t.userId, actorRole: 'owner' },
      { customerRepo: customers, mergeRepo },
    );
    expect(result.movedCounts.jobs).toBe(1);

    // Job + location now belong to the survivor.
    expect((await jobs.findByCustomer(t.tenantId, survivor.id)).map((j) => j.id)).toContain(job.id);
    expect((await jobs.findByCustomer(t.tenantId, loser.id))).toHaveLength(0);
    expect((await locations.findByCustomer(t.tenantId, survivor.id)).map((l) => l.id)).toContain(loc.id);

    // Tags consolidated without duplicating 'vip'.
    expect((await tags.listForCustomer(t.tenantId, survivor.id)).sort()).toEqual(['net30', 'vip']);
    expect(await tags.listForCustomer(t.tenantId, loser.id)).toEqual([]);

    // Contact moved in, demoted from primary.
    const survivorContacts = await contacts.findByCustomer(t.tenantId, survivor.id);
    const moved = survivorContacts.find((c) => c.name === 'Loser Primary');
    expect(moved).toBeDefined();
    expect(moved!.isPrimary).toBe(false);

    // Note re-parented.
    expect((await notes.findByEntity(t.tenantId, 'customer', survivor.id)).map((n) => n.content)).toContain(
      'Prefers mornings',
    );

    // Loser archived; survivor active.
    expect((await customers.findById(t.tenantId, loser.id))!.isArchived).toBe(true);
    expect((await customers.findById(t.tenantId, survivor.id))!.isArchived).toBe(false);
  });

  it('is tenant-isolated — cannot reach a customer in another tenant', async () => {
    const tenantA = await createTestTenant(pool);
    const tenantB = await createTestTenant(pool);
    const survivor = await customers.create(baseCustomer(tenantA.tenantId, tenantA.userId, 'A-Survivor'));
    const bystander = await customers.create(baseCustomer(tenantB.tenantId, tenantB.userId, 'B-Customer'));

    // Reassign under tenant A using tenant B's id as the loser: tenant A's
    // RLS context means no rows match, so nothing in tenant B is touched.
    await mergeRepo.reassignAndArchive(tenantA.tenantId, survivor.id, bystander.id);
    expect((await customers.findById(tenantB.tenantId, bystander.id))!.isArchived).toBe(false);
  });
});

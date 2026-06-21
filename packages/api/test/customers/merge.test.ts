import { describe, it, expect, beforeEach } from 'vitest';
import {
  mergeCustomers,
  InMemoryCustomerMergeRepository,
} from '../../src/customers/merge';
import {
  createCustomer,
  InMemoryCustomerRepository,
} from '../../src/customers/customer';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { ValidationError, NotFoundError } from '../../src/shared/errors';

const TENANT = 'tenant-1';
const ACTOR = 'user-1';

describe('Story 4.6 — customer merge orchestration', () => {
  let customerRepo: InMemoryCustomerRepository;
  let mergeRepo: InMemoryCustomerMergeRepository;
  let auditRepo: InMemoryAuditRepository;

  async function seedCustomer(firstName: string, lastName: string) {
    return createCustomer(
      { tenantId: TENANT, firstName, lastName, createdBy: ACTOR },
      customerRepo,
    );
  }

  beforeEach(() => {
    customerRepo = new InMemoryCustomerRepository();
    mergeRepo = new InMemoryCustomerMergeRepository(customerRepo);
    auditRepo = new InMemoryAuditRepository();
  });

  it('archives the losing record and records a customer.merged audit event', async () => {
    const survivor = await seedCustomer('Keep', 'Me');
    const loser = await seedCustomer('Drop', 'Me');

    const result = await mergeCustomers(
      TENANT,
      { survivingId: survivor.id, losingId: loser.id, actorId: ACTOR, actorRole: 'owner' },
      { customerRepo, mergeRepo, auditRepo },
    );

    expect(result.survivingId).toBe(survivor.id);
    expect(result.losingId).toBe(loser.id);

    // Survivor stays active; loser is archived.
    expect((await customerRepo.findById(TENANT, survivor.id))!.isArchived).toBe(false);
    expect((await customerRepo.findById(TENANT, loser.id))!.isArchived).toBe(true);

    const events = await auditRepo.findByEntity(TENANT, 'customer', survivor.id);
    const merged = events.find((e) => e.eventType === 'customer.merged');
    expect(merged).toBeDefined();
    expect((merged!.metadata as Record<string, unknown>).losingId).toBe(loser.id);
  });

  it('rejects merging a customer into itself', async () => {
    const c = await seedCustomer('Solo', 'One');
    await expect(
      mergeCustomers(
        TENANT,
        { survivingId: c.id, losingId: c.id, actorId: ACTOR },
        { customerRepo, mergeRepo, auditRepo },
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('rejects merging a customer into one of its own sub-accounts (B2B cycle)', async () => {
    const parent = await seedCustomer('Parent', 'Co');
    const sub = await seedCustomer('Sub', 'Account');
    // `sub` is a sub-account of `parent`. Merging the parent (loser) INTO the
    // sub (survivor) would re-parent the sub onto itself → cycle. Reject it.
    await customerRepo.update(TENANT, sub.id, { parentAccountId: parent.id });
    await expect(
      mergeCustomers(
        TENANT,
        { survivingId: sub.id, losingId: parent.id, actorId: ACTOR },
        { customerRepo, mergeRepo, auditRepo },
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    // Nothing was archived — the guard fires before any write.
    expect((await customerRepo.findById(TENANT, parent.id))!.isArchived).toBe(false);
  });

  it('404s when the surviving record does not exist', async () => {
    const loser = await seedCustomer('Drop', 'Me');
    await expect(
      mergeCustomers(
        TENANT,
        { survivingId: 'missing', losingId: loser.id, actorId: ACTOR },
        { customerRepo, mergeRepo, auditRepo },
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('refuses to merge into an archived survivor', async () => {
    const survivor = await seedCustomer('Keep', 'Me');
    const loser = await seedCustomer('Drop', 'Me');
    await customerRepo.update(TENANT, survivor.id, { isArchived: true });
    await expect(
      mergeCustomers(
        TENANT,
        { survivingId: survivor.id, losingId: loser.id, actorId: ACTOR },
        { customerRepo, mergeRepo, auditRepo },
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('refuses to merge an already-archived loser', async () => {
    const survivor = await seedCustomer('Keep', 'Me');
    const loser = await seedCustomer('Drop', 'Me');
    await customerRepo.update(TENANT, loser.id, { isArchived: true });
    await expect(
      mergeCustomers(
        TENANT,
        { survivingId: survivor.id, losingId: loser.id, actorId: ACTOR },
        { customerRepo, mergeRepo, auditRepo },
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('is tenant-scoped — a survivor in another tenant 404s', async () => {
    const loser = await seedCustomer('Drop', 'Me');
    const otherTenantSurvivor = await createCustomer(
      { tenantId: 'tenant-2', firstName: 'Other', lastName: 'Tenant', createdBy: ACTOR },
      customerRepo,
    );
    await expect(
      mergeCustomers(
        TENANT,
        { survivingId: otherTenantSurvivor.id, losingId: loser.id, actorId: ACTOR },
        { customerRepo, mergeRepo, auditRepo },
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

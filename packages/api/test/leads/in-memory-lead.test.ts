/**
 * VQ-002 — InMemoryLeadRepository (canonical module).
 *
 * The Voice Quality Layer 1 corpus runner imports the in-memory repo from
 * `src/leads/in-memory-lead.ts` (separated module path). These tests pin
 * the contract against the existing `LeadRepository` interface and exercise
 * tenant-isolation + copy-not-reference invariants.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryLeadRepository } from '../../src/leads/in-memory-lead';
import type { Lead, LeadRepository } from '../../src/leads/lead';

const tenantA = '00000000-0000-4000-8000-00000000000a';
const tenantB = '00000000-0000-4000-8000-00000000000b';

function makeLead(overrides: Partial<Lead> = {}): Lead {
  const now = new Date();
  return {
    id: overrides.id ?? `lead-${Math.random().toString(36).slice(2, 10)}`,
    tenantId: overrides.tenantId ?? tenantA,
    firstName: overrides.firstName ?? 'Alice',
    lastName: overrides.lastName ?? 'Wong',
    companyName: overrides.companyName,
    primaryPhone: overrides.primaryPhone,
    email: overrides.email,
    source: overrides.source ?? 'web_form',
    sourceDetail: overrides.sourceDetail,
    utmSource: overrides.utmSource,
    utmMedium: overrides.utmMedium,
    utmCampaign: overrides.utmCampaign,
    attribution: overrides.attribution,
    stage: overrides.stage ?? 'new',
    estimatedValueCents: overrides.estimatedValueCents,
    notes: overrides.notes,
    assignedUserId: overrides.assignedUserId,
    convertedCustomerId: overrides.convertedCustomerId,
    lostReason: overrides.lostReason,
    createdBy: overrides.createdBy ?? 'user-1',
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
  };
}

describe('VQ-002 — InMemoryLeadRepository (canonical module)', () => {
  let repo: InMemoryLeadRepository;

  beforeEach(() => {
    repo = new InMemoryLeadRepository();
  });

  it('VQ-002 — implements LeadRepository interface', () => {
    // Type-level check: the in-memory class must be substitutable.
    const asInterface: LeadRepository = repo;
    expect(typeof asInterface.create).toBe('function');
    expect(typeof asInterface.findById).toBe('function');
    expect(typeof asInterface.findByTenant).toBe('function');
    expect(typeof asInterface.listWithMeta).toBe('function');
    expect(typeof asInterface.update).toBe('function');
    expect(typeof asInterface.findByPhoneNormalized).toBe('function');
  });

  it('VQ-002 — happy path: create + findById round-trip', async () => {
    const lead = makeLead({ id: 'lead-001', firstName: 'Alice' });
    await repo.create(lead);

    const found = await repo.findById(tenantA, 'lead-001');
    expect(found).not.toBeNull();
    expect(found!.id).toBe('lead-001');
    expect(found!.firstName).toBe('Alice');
    expect(found!.tenantId).toBe(tenantA);
  });

  it('VQ-002 — tenant isolation: tenant B cannot read tenant A lead', async () => {
    const lead = makeLead({ id: 'lead-iso', tenantId: tenantA });
    await repo.create(lead);

    const fromB = await repo.findById(tenantB, 'lead-iso');
    expect(fromB).toBeNull();

    const listFromB = await repo.findByTenant(tenantB);
    expect(listFromB).toEqual([]);

    const fromA = await repo.findById(tenantA, 'lead-iso');
    expect(fromA).not.toBeNull();
  });

  it('VQ-002 — update: change a field, findById returns updated', async () => {
    const lead = makeLead({ id: 'lead-upd', stage: 'new' });
    await repo.create(lead);

    const updated = await repo.update(tenantA, 'lead-upd', { stage: 'qualified', notes: 'hot lead' });
    expect(updated).not.toBeNull();
    expect(updated!.stage).toBe('qualified');
    expect(updated!.notes).toBe('hot lead');

    const refetched = await repo.findById(tenantA, 'lead-upd');
    expect(refetched!.stage).toBe('qualified');
    expect(refetched!.notes).toBe('hot lead');
  });

  it('VQ-002 — update returns null when lead is in a different tenant', async () => {
    const lead = makeLead({ id: 'lead-x', tenantId: tenantA });
    await repo.create(lead);

    const updated = await repo.update(tenantB, 'lead-x', { stage: 'won' });
    expect(updated).toBeNull();
  });

  it('VQ-002 — findByPhoneNormalized: matches against normalized digits', async () => {
    await repo.create(
      makeLead({ id: 'lead-p1', primaryPhone: '(415) 555-1212', createdAt: new Date('2026-01-01') })
    );
    await repo.create(
      makeLead({ id: 'lead-p2', primaryPhone: '+1-415-555-1212', createdAt: new Date('2026-02-01') })
    );

    // Both leads share normalized phone "4155551212" (10-digit canonical
    // form per src/shared/phone.ts — leading "1" stripped). Return most recent.
    const found = await repo.findByPhoneNormalized(tenantA, '4155551212');
    expect(found).not.toBeNull();
    expect(found!.id).toBe('lead-p2');
  });

  it('VQ-002 — findByPhoneNormalized: returns null on no match', async () => {
    await repo.create(makeLead({ id: 'lead-p3', primaryPhone: '415-555-9999' }));
    const found = await repo.findByPhoneNormalized(tenantA, '4155551212');
    expect(found).toBeNull();
  });

  it('VQ-002 — findByPhoneNormalized: respects tenant isolation', async () => {
    await repo.create(
      makeLead({ id: 'lead-p4', tenantId: tenantA, primaryPhone: '415-555-1212' })
    );
    const fromB = await repo.findByPhoneNormalized(tenantB, '4155551212');
    expect(fromB).toBeNull();
  });

  it('VQ-002 — returns copy, not reference: mutating result does not corrupt repo', async () => {
    const lead = makeLead({ id: 'lead-cp', firstName: 'Original' });
    await repo.create(lead);

    const found = await repo.findById(tenantA, 'lead-cp');
    expect(found).not.toBeNull();
    found!.firstName = 'Mutated';

    const refetched = await repo.findById(tenantA, 'lead-cp');
    expect(refetched!.firstName).toBe('Original');
  });

  it('VQ-002 — create snapshots input: mutating input after create does not corrupt repo', async () => {
    const lead = makeLead({ id: 'lead-snap', firstName: 'Pristine' });
    await repo.create(lead);
    lead.firstName = 'TamperedAfterCreate';

    const refetched = await repo.findById(tenantA, 'lead-snap');
    expect(refetched!.firstName).toBe('Pristine');
  });

  it('VQ-002 — findByTenant filters by tenant and supports pagination', async () => {
    for (let i = 0; i < 5; i++) {
      await repo.create(
        makeLead({
          id: `lead-list-${i}`,
          tenantId: tenantA,
          createdAt: new Date(2026, 0, i + 1),
        })
      );
    }
    await repo.create(makeLead({ id: 'lead-other', tenantId: tenantB }));

    const all = await repo.findByTenant(tenantA);
    expect(all).toHaveLength(5);

    const page = await repo.findByTenant(tenantA, { limit: 2, offset: 0 });
    expect(page).toHaveLength(2);
  });
});

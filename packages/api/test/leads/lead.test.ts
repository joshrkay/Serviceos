/**
 * P9-001 — Lead repository + service tests.
 *
 * NOTE: this file lives in /test/ (where vitest picks it up). The dispatch
 * contract's allowed files list also calls out src/leads/__tests__/* —
 * a placeholder lives there too so the contract's path exists.
 */
import { InMemoryLeadRepository } from '../../src/leads/lead';
import {
  convertToCustomer,
  createLead,
  loseLead,
  transitionStage,
  updateLead,
} from '../../src/leads/lead-service';
import { InMemoryCustomerRepository } from '../../src/customers/customer';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { createLeadSchema, loseLeadSchema, updateLeadSchema } from '../../src/leads/enums';

describe('P9-001 — leads repository + service', () => {
  let leadRepo: InMemoryLeadRepository;
  let customerRepo: InMemoryCustomerRepository;
  let auditRepo: InMemoryAuditRepository;
  const tenantA = '00000000-0000-4000-8000-00000000000a';
  const tenantB = '00000000-0000-4000-8000-00000000000b';

  beforeEach(() => {
    leadRepo = new InMemoryLeadRepository();
    customerRepo = new InMemoryCustomerRepository();
    auditRepo = new InMemoryAuditRepository();
  });

  it('creates a lead with required fields', async () => {
    const lead = await createLead(
      {
        tenantId: tenantA,
        firstName: 'Alice',
        lastName: 'Wong',
        source: 'web_form',
        sourceDetail: 'spring-promo',
        createdBy: 'user-1',
        actorRole: 'owner',
      },
      leadRepo,
      auditRepo
    );
    expect(lead.id).toBeTruthy();
    expect(lead.stage).toBe('new');
    expect(lead.source).toBe('web_form');
    expect(lead.convertedCustomerId).toBeUndefined();

    const events = auditRepo.getAll();
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('lead.created');
    expect(events[0].entityId).toBe(lead.id);
  });

  it('rejects creation when neither firstName nor companyName is provided', async () => {
    await expect(
      createLead(
        {
          tenantId: tenantA,
          source: 'phone_call',
          createdBy: 'user-1',
        },
        leadRepo,
        auditRepo
      )
    ).rejects.toThrow(/firstName or companyName is required/);
  });

  it('lists leads filtered by stage / source / assignee', async () => {
    const a = await createLead(
      { tenantId: tenantA, firstName: 'A', source: 'web_form', createdBy: 'u', assignedUserId: 'user-x' },
      leadRepo
    );
    await createLead(
      { tenantId: tenantA, firstName: 'B', source: 'phone_call', createdBy: 'u' },
      leadRepo
    );
    await transitionStage(tenantA, a.id, 'contacted', leadRepo);

    const byStage = await leadRepo.findByTenant(tenantA, { stage: 'contacted' });
    expect(byStage).toHaveLength(1);
    expect(byStage[0].id).toBe(a.id);

    const bySource = await leadRepo.findByTenant(tenantA, { source: 'web_form' });
    expect(bySource).toHaveLength(1);

    const byAssignee = await leadRepo.findByTenant(tenantA, { assignedUserId: 'user-x' });
    expect(byAssignee).toHaveLength(1);
  });

  it('stage transition writes lead.stage_changed audit event', async () => {
    const lead = await createLead(
      { tenantId: tenantA, firstName: 'A', source: 'referral', createdBy: 'u' },
      leadRepo,
      auditRepo
    );
    auditRepo.clear();

    const updated = await transitionStage(
      tenantA,
      lead.id,
      'qualified',
      leadRepo,
      'user-1',
      'owner',
      auditRepo
    );
    expect(updated?.stage).toBe('qualified');
    const events = auditRepo.getAll();
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('lead.stage_changed');
    expect(events[0].metadata).toMatchObject({ fromStage: 'new', toStage: 'qualified' });
  });

  it('rejects manual stage transition into "won" — must use convertToCustomer', async () => {
    const lead = await createLead(
      { tenantId: tenantA, firstName: 'A', source: 'referral', createdBy: 'u' },
      leadRepo
    );
    await expect(
      updateLead(tenantA, lead.id, { stage: 'won' }, leadRepo)
    ).rejects.toThrow(/convertToCustomer/);
  });

  it('rejects manual stage transition into "lost" — must use loseLead', async () => {
    const lead = await createLead(
      { tenantId: tenantA, firstName: 'A', source: 'referral', createdBy: 'u' },
      leadRepo
    );
    await expect(
      updateLead(tenantA, lead.id, { stage: 'lost' }, leadRepo)
    ).rejects.toThrow(/loseLead/);
  });

  it('convertToCustomer creates customer, sets converted id, transitions to won, audits both sides', async () => {
    const lead = await createLead(
      {
        tenantId: tenantA,
        firstName: 'Carla',
        lastName: 'Reyes',
        primaryPhone: '555-0100',
        email: 'carla@example.com',
        source: 'referral',
        createdBy: 'user-1',
      },
      leadRepo,
      auditRepo
    );
    auditRepo.clear();

    const result = await convertToCustomer(
      tenantA,
      lead.id,
      leadRepo,
      customerRepo,
      'user-2',
      'owner',
      auditRepo
    );

    expect(result).not.toBeNull();
    expect(result!.lead.stage).toBe('won');
    expect(result!.lead.convertedCustomerId).toBe(result!.customer.id);
    expect(result!.customer.firstName).toBe('Carla');
    expect(result!.customer.email).toBe('carla@example.com');
    expect(result!.customer.preferredChannel).toBe('email');

    // Both audit events written, sharing the same correlation id.
    const events = auditRepo.getAll();
    const leadEvent = events.find((e) => e.eventType === 'lead.converted');
    const customerEvent = events.find((e) => e.eventType === 'customer.created_from_lead');
    expect(leadEvent).toBeTruthy();
    expect(customerEvent).toBeTruthy();
    expect(leadEvent!.correlationId).toBe(customerEvent!.correlationId);
    expect(leadEvent!.metadata).toMatchObject({ customerId: result!.customer.id });
    expect(customerEvent!.metadata).toMatchObject({ leadId: lead.id });
  });

  it("convertToCustomer carries the lead's preferred language onto the customer", async () => {
    const lead = await createLead(
      { tenantId: tenantA, firstName: 'Sofia', source: 'phone_call', createdBy: 'u' },
      leadRepo
    );
    await updateLead(tenantA, lead.id, { preferredLanguage: 'es' }, leadRepo);

    const result = await convertToCustomer(
      tenantA,
      lead.id,
      leadRepo,
      customerRepo,
      'user-2',
      'owner',
      auditRepo
    );

    expect(result!.customer.preferredLanguage).toBe('es');
  });

  it('convertToCustomer rolls back when customer create fails', async () => {
    const lead = await createLead(
      { tenantId: tenantA, firstName: 'D', source: 'walk_in', createdBy: 'u' },
      leadRepo
    );

    // Force customer.create to throw.
    const failingCustomerRepo = new InMemoryCustomerRepository();
    failingCustomerRepo.create = async () => {
      throw new Error('simulated db failure');
    };

    await expect(
      convertToCustomer(tenantA, lead.id, leadRepo, failingCustomerRepo, 'u', 'owner', auditRepo)
    ).rejects.toThrow(/simulated db failure/);

    const after = await leadRepo.findById(tenantA, lead.id);
    expect(after?.stage).toBe('new');
    expect(after?.convertedCustomerId).toBeUndefined();
    // No audit events for either side.
    expect(auditRepo.getAll().filter((e) => e.eventType === 'lead.converted')).toHaveLength(0);
    expect(
      auditRepo.getAll().filter((e) => e.eventType === 'customer.created_from_lead')
    ).toHaveLength(0);
  });

  // ── LC-5: dedup (link vs create) + idempotency ────────────────────────
  it('convertToCustomer LINKS to an existing customer on a phone match (dedup)', async () => {
    const now = new Date();
    const existingCustomer = await customerRepo.create({
      id: crypto.randomUUID(),
      tenantId: tenantA,
      firstName: 'Carla',
      lastName: 'Reyes',
      displayName: 'Carla Reyes',
      primaryPhone: '5550100',
      email: 'carla@example.com',
      preferredChannel: 'phone',
      smsConsent: false,
      isArchived: false,
      createdBy: 'seed',
      createdAt: now,
      updatedAt: now,
    });
    const lead = await createLead(
      { tenantId: tenantA, firstName: 'Carla', primaryPhone: '5550100', source: 'referral', createdBy: 'u' },
      leadRepo,
      auditRepo,
    );

    const result = await convertToCustomer(tenantA, lead.id, leadRepo, customerRepo, 'u2', 'owner', auditRepo);
    expect(result!.linked).toBe(true);
    expect(result!.customer.id).toBe(existingCustomer.id);
    expect(result!.lead.convertedCustomerId).toBe(existingCustomer.id);
    expect(result!.lead.stage).toBe('won');

    // Exactly one customer for the tenant — no duplicate minted.
    const all = await customerRepo.findByTenant(tenantA);
    expect(all).toHaveLength(1);
    // Linked-from-lead audit emitted instead of created-from-lead.
    const events = auditRepo.getAll();
    expect(events.some((e) => e.eventType === 'customer.linked_from_lead')).toBe(true);
    expect(events.some((e) => e.eventType === 'customer.created_from_lead')).toBe(false);
  });

  it('convertToCustomer creates a new customer when no high-confidence match exists', async () => {
    const lead = await createLead(
      { tenantId: tenantA, firstName: 'Unique', primaryPhone: '5559999', source: 'web_form', createdBy: 'u' },
      leadRepo,
      auditRepo,
    );
    const result = await convertToCustomer(tenantA, lead.id, leadRepo, customerRepo, 'u2', 'owner', auditRepo);
    expect(result!.linked).toBeUndefined();
    expect(result!.customer.originatingLeadId).toBe(lead.id);
    expect(await customerRepo.findByTenant(tenantA)).toHaveLength(1);
  });

  it('convertToCustomer is idempotent — re-convert returns the prior result, no duplicate', async () => {
    const lead = await createLead(
      { tenantId: tenantA, firstName: 'Repeat', primaryPhone: '5551111', source: 'web_form', createdBy: 'u' },
      leadRepo,
      auditRepo,
    );
    const first = await convertToCustomer(tenantA, lead.id, leadRepo, customerRepo, 'u2', 'owner', auditRepo);
    const second = await convertToCustomer(tenantA, lead.id, leadRepo, customerRepo, 'u2', 'owner', auditRepo);

    expect(second!.alreadyConverted).toBe(true);
    expect(second!.customer.id).toBe(first!.customer.id);
    // No second customer, no second conversion audit.
    expect(await customerRepo.findByTenant(tenantA)).toHaveLength(1);
    expect(auditRepo.getAll().filter((e) => e.eventType === 'lead.converted')).toHaveLength(1);
  });

  it('convertToCustomer re-convert is idempotent (LC-5): returns the prior result, not an error', async () => {
    const lead = await createLead(
      { tenantId: tenantA, firstName: 'D', source: 'walk_in', createdBy: 'u' },
      leadRepo
    );
    const first = await convertToCustomer(tenantA, lead.id, leadRepo, customerRepo, 'u', 'owner');
    const again = await convertToCustomer(tenantA, lead.id, leadRepo, customerRepo, 'u', 'owner');
    expect(again!.alreadyConverted).toBe(true);
    expect(again!.customer.id).toBe(first!.customer.id);
  });

  it('loseLead requires a non-empty reason and writes lead.lost audit event', async () => {
    const lead = await createLead(
      { tenantId: tenantA, firstName: 'E', source: 'marketplace', createdBy: 'u' },
      leadRepo
    );
    await expect(
      loseLead(tenantA, lead.id, '', leadRepo, 'u', 'owner', auditRepo)
    ).rejects.toThrow(/reason is required/);

    const updated = await loseLead(
      tenantA,
      lead.id,
      'No budget',
      leadRepo,
      'u',
      'owner',
      auditRepo
    );
    expect(updated?.stage).toBe('lost');
    expect(updated?.lostReason).toBe('No budget');
    const events = auditRepo.getAll().filter((e) => e.eventType === 'lead.lost');
    expect(events).toHaveLength(1);
    expect(events[0].metadata).toMatchObject({ reason: 'No budget' });
  });

  it('tenant isolation — lead in tenant A is invisible to tenant B', async () => {
    const lead = await createLead(
      { tenantId: tenantA, firstName: 'A', source: 'referral', createdBy: 'u' },
      leadRepo
    );
    expect(await leadRepo.findById(tenantB, lead.id)).toBeNull();
    expect(await leadRepo.findByTenant(tenantB)).toHaveLength(0);
    expect(await leadRepo.update(tenantB, lead.id, { stage: 'contacted' })).toBeNull();
  });

  it('listWithMeta caps limit at 200 server-side', async () => {
    const repo = new InMemoryLeadRepository();
    // Insert 5 leads and request limit=999
    for (let i = 0; i < 5; i++) {
      await createLead(
        { tenantId: tenantA, firstName: `L${i}`, source: 'other', createdBy: 'u' },
        repo
      );
    }
    const result = await repo.listWithMeta(tenantA, { limit: 999 });
    expect(result.total).toBe(5);
    expect(result.data.length).toBeLessThanOrEqual(200);
  });

  describe('Zod schemas', () => {
    it('createLeadSchema rejects invalid source', () => {
      const r = createLeadSchema.safeParse({
        firstName: 'A',
        source: 'fax',
      });
      expect(r.success).toBe(false);
    });

    it('createLeadSchema rejects decimal estimatedValueCents (money safety)', () => {
      const r = createLeadSchema.safeParse({
        firstName: 'A',
        source: 'web_form',
        estimatedValueCents: 12.5,
      });
      expect(r.success).toBe(false);
    });

    it('createLeadSchema accepts valid integer cents', () => {
      const r = createLeadSchema.safeParse({
        firstName: 'A',
        source: 'web_form',
        estimatedValueCents: 12500,
      });
      expect(r.success).toBe(true);
    });

    it('updateLeadSchema accepts a stage transition payload', () => {
      const r = updateLeadSchema.safeParse({ stage: 'contacted' });
      expect(r.success).toBe(true);
    });

    it('loseLeadSchema requires reason', () => {
      expect(loseLeadSchema.safeParse({}).success).toBe(false);
      expect(loseLeadSchema.safeParse({ reason: '' }).success).toBe(false);
      expect(loseLeadSchema.safeParse({ reason: 'No reply' }).success).toBe(true);
    });
  });
});

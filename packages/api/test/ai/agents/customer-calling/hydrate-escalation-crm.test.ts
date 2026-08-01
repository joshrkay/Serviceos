import { describe, it, expect } from 'vitest';
import {
  hydrateEscalationCrm,
  mergeCallerContextWithCrm,
} from '../../../../src/ai/agents/customer-calling/hydrate-escalation-crm';
import { buildEscalationSummary } from '../../../../src/ai/agents/customer-calling/escalation-summary-builder';
import { InMemoryCustomerRepository } from '../../../../src/customers/customer';
import { InMemoryTagRepository } from '../../../../src/customers/tag';
import { InMemoryJobRepository } from '../../../../src/jobs/job';
import { InMemoryAgreementRepository } from '../../../../src/agreements/agreement';
import type { Customer } from '../../../../src/customers/customer';
import type { Job } from '../../../../src/jobs/job';
import type { Agreement } from '../../../../src/agreements/agreement';

const TENANT = '11111111-1111-4111-8111-111111111111';
const CUSTOMER_ID = '22222222-2222-4222-8222-222222222222';

function makeCustomer(overrides: Partial<Customer> = {}): Customer {
  return {
    id: CUSTOMER_ID,
    tenantId: TENANT,
    firstName: 'María',
    lastName: 'López',
    displayName: 'María López',
    preferredChannel: 'phone',
    smsConsent: true,
    isArchived: false,
    createdBy: 'test',
    createdAt: new Date('2025-01-01T00:00:00Z'),
    updatedAt: new Date('2025-01-01T00:00:00Z'),
    primaryPhone: '+15125550142',
    communicationNotes: 'Prefers mornings. Frustrated about price last visit.',
    preferredLanguage: 'es',
    ...overrides,
  };
}

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-1',
    tenantId: TENANT,
    customerId: CUSTOMER_ID,
    locationId: 'loc-1',
    jobNumber: 'J-100',
    summary: 'AC tune-up',
    status: 'completed',
    priority: 'normal',
    createdBy: 'test',
    createdAt: new Date('2026-01-10T12:00:00Z'),
    updatedAt: new Date('2026-01-10T12:00:00Z'),
    completedAt: new Date('2026-01-10T15:00:00Z'),
    ...overrides,
  };
}

function makeAgreement(overrides: Partial<Agreement> = {}): Agreement {
  const now = new Date();
  return {
    id: 'agr-1',
    tenantId: TENANT,
    customerId: CUSTOMER_ID,
    name: 'Gold Plan',
    recurrenceRule: 'FREQ=YEARLY',
    priceCents: 29900,
    autoGenerateInvoice: false,
    autoGenerateJob: false,
    nextRunAt: now,
    status: 'active',
    startsOn: '2025-01-01',
    endsOn: '2027-01-01',
    memberDiscountBps: 1000,
    createdBy: 'test',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('hydrateEscalationCrm', () => {
  it('loads tags, lastService, membership, and communication notes', async () => {
    const customerRepo = new InMemoryCustomerRepository();
    const tagRepo = new InMemoryTagRepository();
    const jobRepo = new InMemoryJobRepository();
    const agreementRepo = new InMemoryAgreementRepository();

    await customerRepo.create(makeCustomer());
    await tagRepo.addTag(TENANT, CUSTOMER_ID, 'vip');
    await tagRepo.addTag(TENANT, CUSTOMER_ID, 'net-30');
    await jobRepo.create(makeJob());
    await jobRepo.create(
      makeJob({
        id: 'job-older',
        summary: 'Old repair',
        completedAt: new Date('2025-06-01T00:00:00Z'),
        createdAt: new Date('2025-06-01T00:00:00Z'),
      }),
    );
    await agreementRepo.create(makeAgreement());

    const crm = await hydrateEscalationCrm(
      TENANT,
      { customerId: CUSTOMER_ID },
      { customerRepo, tagRepo, jobRepo, agreementRepo },
    );

    expect(crm.tags).toEqual(expect.arrayContaining(['vip', 'net-30', 'Spanish']));
    expect(crm.customer?.lastService?.type).toBe('AC tune-up');
    expect(crm.customer?.lastService?.date.toISOString()).toBe('2026-01-10T15:00:00.000Z');
    expect(crm.customer?.isMember).toBe(true);
    expect(crm.customer?.memberTier).toBe('Gold Plan');
    expect(crm.customer?.communicationNotes).toContain('Prefers mornings');
  });

  it('resolves customer by phone when customerId is absent', async () => {
    const customerRepo = new InMemoryCustomerRepository();
    await customerRepo.create(makeCustomer());

    const crm = await hydrateEscalationCrm(
      TENANT,
      { phone: '+1 (512) 555-0142' },
      { customerRepo },
    );

    expect(crm.customer?.communicationNotes).toContain('Prefers mornings');
    expect(crm.tags).toContain('Spanish');
  });

  it('returns empty enrichment when customer is unknown', async () => {
    const customerRepo = new InMemoryCustomerRepository();
    const crm = await hydrateEscalationCrm(
      TENANT,
      { phone: '+15551234567' },
      { customerRepo },
    );
    expect(crm).toEqual({ tags: [] });
  });

  it('survives individual repo failures without throwing', async () => {
    const customerRepo = new InMemoryCustomerRepository();
    await customerRepo.create(makeCustomer());
    const tagRepo = {
      listForCustomer: async () => {
        throw new Error('tags down');
      },
    } as never;
    const jobRepo = {
      findByCustomer: async () => {
        throw new Error('jobs down');
      },
    } as never;

    const crm = await hydrateEscalationCrm(
      TENANT,
      { customerId: CUSTOMER_ID },
      { customerRepo, tagRepo, jobRepo },
    );

    expect(crm.customer?.communicationNotes).toContain('Prefers mornings');
    expect(crm.tags).toContain('Spanish');
  });
});

describe('mergeCallerContextWithCrm + buildEscalationSummary', () => {
  it('surfaces lastService, membership, tags, and notes in whisper/SMS/panel', () => {
    const base = {
      caller: { name: 'María López', phone: '+15125550142', customerId: CUSTOMER_ID },
      intent: {
        type: 'create_appointment',
        entities: { service: 'AC repair' },
        confidence: 0.4,
      },
      transcriptSnapshot: [
        { role: 'caller' as const, text: 'necesito una cita', ts: 1 },
      ],
    };
    const merged = mergeCallerContextWithCrm(base, {
      tags: ['vip', 'Spanish'],
      customer: {
        lastService: {
          date: new Date('2026-01-10T15:00:00Z'),
          type: 'AC tune-up',
          amountCents: 18900,
        },
        isMember: true,
        memberTier: 'Gold Plan',
        communicationNotes: 'Prefers mornings.',
      },
    });

    const summary = buildEscalationSummary({
      shopName: "Joe's HVAC",
      tenantTimezone: 'UTC',
      caller: merged.caller,
      customer: merged.customer,
      intent: merged.intent,
      reason: 'operator_request',
      transcriptSnapshot: merged.transcriptSnapshot,
    });

    expect(merged.caller.tags).toEqual(['vip', 'Spanish']);
    expect(summary.whisper).toMatch(/Gold Plan member|Member/i);
    expect(summary.sms).toMatch(/Gold Plan member|Member/i);
    expect(summary.panel.customer.tags).toEqual(['vip', 'Spanish']);
    expect(summary.panel.lastInteraction).toContain('AC tune-up');
    expect(summary.panel.lastInteraction).toContain('$189.00');
    expect(summary.panel.lastInteraction).toContain('Notes: Prefers mornings.');
  });
});

import { describe, it, expect, beforeEach } from 'vitest';
import {
  buildCallerPlanContext,
  formatCallerPlanForPrompt,
} from '../../../src/ai/orchestration/caller-plan-context';
import {
  InMemoryAgreementRepository,
  type Agreement,
} from '../../../src/agreements/agreement';
import type { AgreementStatus } from '../../../src/agreements/enums';

const TENANT = 'tenant-3c';
const CUSTOMER = 'cust-1';

function makeAgreement(overrides: Partial<Agreement>): Agreement {
  return {
    id: overrides.id ?? `agr-${Math.random().toString(36).slice(2, 10)}`,
    tenantId: TENANT,
    customerId: CUSTOMER,
    name: overrides.name ?? 'Gold Membership',
    recurrenceRule: 'FREQ=YEARLY',
    priceCents: 19900,
    autoGenerateInvoice: false,
    autoGenerateJob: true,
    nextRunAt: overrides.nextRunAt ?? new Date('2026-09-01T00:00:00Z'),
    status: (overrides.status ?? 'active') as AgreementStatus,
    startsOn: '2026-01-01',
    createdBy: 'user-1',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('buildCallerPlanContext', () => {
  let repo: InMemoryAgreementRepository;

  beforeEach(() => {
    repo = new InMemoryAgreementRepository();
  });

  it('returns no-plan context when the customer has no agreements', async () => {
    const ctx = await buildCallerPlanContext(TENANT, CUSTOMER, repo);
    expect(ctx.hasActivePlan).toBe(false);
    expect(ctx.planNames).toEqual([]);
    expect(ctx.earliestNextServiceDue).toBeUndefined();
  });

  it('returns no-plan context when the only agreements are paused or cancelled', async () => {
    await repo.create(makeAgreement({ name: 'Old Plan', status: 'paused' }));
    await repo.create(makeAgreement({ name: 'Cancelled Plan', status: 'cancelled' }));
    const ctx = await buildCallerPlanContext(TENANT, CUSTOMER, repo);
    expect(ctx.hasActivePlan).toBe(false);
    expect(ctx.planNames).toEqual([]);
  });

  it('flags an active plan and surfaces the plan name', async () => {
    await repo.create(makeAgreement({ name: 'Gold Membership' }));
    const ctx = await buildCallerPlanContext(TENANT, CUSTOMER, repo);
    expect(ctx.hasActivePlan).toBe(true);
    expect(ctx.planNames).toEqual(['Gold Membership']);
  });

  it('surfaces the earliest nextRunAt across multiple active plans', async () => {
    await repo.create(
      makeAgreement({ name: 'Gold', nextRunAt: new Date('2026-12-01T00:00:00Z') }),
    );
    await repo.create(
      makeAgreement({ name: 'Spring Tune-Up', nextRunAt: new Date('2026-06-15T00:00:00Z') }),
    );
    const ctx = await buildCallerPlanContext(TENANT, CUSTOMER, repo);
    expect(ctx.hasActivePlan).toBe(true);
    expect(new Set(ctx.planNames)).toEqual(new Set(['Gold', 'Spring Tune-Up']));
    expect(ctx.earliestNextServiceDue).toEqual(new Date('2026-06-15T00:00:00Z'));
  });

  it('isolates tenants — Tenant A’s plan is invisible to Tenant B', async () => {
    await repo.create(makeAgreement({ name: 'Gold' }));
    const ctx = await buildCallerPlanContext('tenant-other', CUSTOMER, repo);
    expect(ctx.hasActivePlan).toBe(false);
  });

  it('returns no-plan context on missing tenantId or customerId', async () => {
    expect((await buildCallerPlanContext('', CUSTOMER, repo)).hasActivePlan).toBe(false);
    expect((await buildCallerPlanContext(TENANT, '', repo)).hasActivePlan).toBe(false);
  });

  it('returns no-plan context (does not throw) when the repo throws', async () => {
    const failingRepo: InMemoryAgreementRepository = {
      ...repo,
      findByTenant: async () => {
        throw new Error('simulated DB outage');
      },
    } as unknown as InMemoryAgreementRepository;
    const ctx = await buildCallerPlanContext(TENANT, CUSTOMER, failingRepo);
    expect(ctx.hasActivePlan).toBe(false);
  });
});

describe('formatCallerPlanForPrompt', () => {
  it('returns empty string when the caller has no active plan', () => {
    expect(formatCallerPlanForPrompt({ hasActivePlan: false, planNames: [] })).toBe('');
  });

  it('emits a prompt block with plan names', () => {
    const out = formatCallerPlanForPrompt({
      hasActivePlan: true,
      planNames: ['Gold Membership', 'Spring Tune-Up'],
    });
    expect(out).toContain('Caller is on an active maintenance plan');
    expect(out).toContain('Plans: Gold Membership, Spring Tune-Up');
    expect(out).toContain('priority');
  });

  it('includes next scheduled service date when supplied', () => {
    const out = formatCallerPlanForPrompt({
      hasActivePlan: true,
      planNames: ['Gold'],
      earliestNextServiceDue: new Date('2026-06-15T00:00:00Z'),
    });
    expect(out).toContain('Next scheduled service: 2026-06-15');
  });

  it('omits the date line when no nextServiceDue is provided', () => {
    const out = formatCallerPlanForPrompt({
      hasActivePlan: true,
      planNames: ['Gold'],
    });
    expect(out).not.toContain('Next scheduled service');
  });
});

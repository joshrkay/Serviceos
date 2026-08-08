/**
 * Task 7 (2026-08-07 tradesperson plan) — CreateServiceAgreementTaskHandler
 * (drafting leg).
 *
 * Mirrors SendCustomerMessageTaskHandler's customer resolution: joins
 * `CUSTOMER_REF_INTENTS` (entity-resolution.ts), so the voice-action-router
 * resolves the spoken customer name to a verified id BEFORE this handler
 * runs and threads it onto `context.customerId` (NOT
 * `context.existingEntities.customerId`) — the generic resolution behavior
 * itself is pinned in test/ai/agents/customer-calling/entity-resolution.test.ts.
 *
 * Cadence words are mapped deterministically to an RRULE string — no LLM
 * call in this handler. `startsOn` defaults to the first of next month
 * computed from the TENANT's local calendar date (never raw server-local
 * `Date` math — a naive default is off by a day for some tenants near
 * midnight); a spoken override is parsed best-effort via chrono-node
 * (mirrors ai/scheduling/resolve-datetime.ts's own chrono+luxon pattern)
 * and falls back to the default when unparseable.
 */
import { describe, it, expect } from 'vitest';
import { CreateServiceAgreementTaskHandler } from '../../../src/ai/tasks/create-service-agreement-task';
import { TaskContext } from '../../../src/ai/tasks/task-handlers';
import { missingFieldsFor, actionClassForProposalType } from '../../../src/proposals/proposal';

const TENANT_ID = 't-1';
const CUSTOMER_ID = '11111111-1111-4111-8111-111111111111';

function ctx(overrides: Partial<TaskContext>): TaskContext {
  return {
    tenantId: TENANT_ID,
    userId: 'u-1',
    message: 'sign the Garcias up for the annual maintenance plan, 290 a year',
    ...overrides,
  };
}

describe('CreateServiceAgreementTaskHandler', () => {
  it('a resolved customerId + full fields drafts ungated', async () => {
    const { proposal, taskType } = await new CreateServiceAgreementTaskHandler().handle(
      ctx({
        customerId: CUSTOMER_ID,
        existingEntities: {
          serviceAgreementName: 'Annual maintenance plan',
          serviceAgreementCadence: 'annual',
          amount: 29000,
        },
      }),
    );

    expect(taskType).toBe('create_service_agreement');
    expect(actionClassForProposalType(proposal.proposalType)).toBe('capture');
    const payload = proposal.payload as Record<string, unknown>;
    expect(payload.customerId).toBe(CUSTOMER_ID);
    expect(payload.name).toBe('Annual maintenance plan');
    expect(payload.recurrenceRule).toBe('FREQ=YEARLY');
    expect(payload.priceCents).toBe(29000);
    expect(typeof payload.startsOn).toBe('string');
    expect(missingFieldsFor(proposal)).toEqual([]);
  });

  it('an unresolved customer reference gates with a FLAT customerId key', async () => {
    const { proposal } = await new CreateServiceAgreementTaskHandler().handle(
      ctx({
        existingEntities: {
          serviceAgreementName: 'Annual maintenance plan',
          serviceAgreementCadence: 'annual',
          amount: 29000,
        },
      }),
    );

    expect(missingFieldsFor(proposal)).toContain('customerId');
    expect(missingFieldsFor(proposal).every((f) => !f.includes(' '))).toBe(true);
  });

  it('a missing plan name gates with a FLAT name key', async () => {
    const { proposal } = await new CreateServiceAgreementTaskHandler().handle(
      ctx({
        customerId: CUSTOMER_ID,
        existingEntities: { serviceAgreementCadence: 'annual', amount: 29000 },
      }),
    );

    expect(missingFieldsFor(proposal)).toContain('name');
  });

  it('a missing amount gates with a FLAT priceCents key', async () => {
    const { proposal } = await new CreateServiceAgreementTaskHandler().handle(
      ctx({
        customerId: CUSTOMER_ID,
        existingEntities: { serviceAgreementName: 'Annual maintenance plan', serviceAgreementCadence: 'annual' },
      }),
    );

    expect(missingFieldsFor(proposal)).toContain('priceCents');
  });

  it('a zero or negative spoken amount is not trusted as a real price (gates)', async () => {
    const { proposal } = await new CreateServiceAgreementTaskHandler().handle(
      ctx({
        customerId: CUSTOMER_ID,
        existingEntities: {
          serviceAgreementName: 'Annual maintenance plan',
          serviceAgreementCadence: 'annual',
          amount: -100,
        },
      }),
    );

    expect(missingFieldsFor(proposal)).toContain('priceCents');
    const payload = proposal.payload as Record<string, unknown>;
    expect(payload.priceCents).toBeUndefined();
  });

  it('rounds a fractional spoken amount to the nearest cent', async () => {
    const { proposal } = await new CreateServiceAgreementTaskHandler().handle(
      ctx({
        customerId: CUSTOMER_ID,
        existingEntities: {
          serviceAgreementName: 'Annual maintenance plan',
          serviceAgreementCadence: 'annual',
          amount: 2899.6,
        },
      }),
    );

    const payload = proposal.payload as Record<string, unknown>;
    expect(payload.priceCents).toBe(2900);
  });

  it('a missing or unrecognized cadence gates with a FLAT recurrenceRule key', async () => {
    const { proposal } = await new CreateServiceAgreementTaskHandler().handle(
      ctx({
        customerId: CUSTOMER_ID,
        existingEntities: { serviceAgreementName: 'Annual maintenance plan', amount: 29000 },
      }),
    );

    expect(missingFieldsFor(proposal)).toContain('recurrenceRule');
  });

  it.each([
    ['monthly', 'FREQ=MONTHLY'],
    ['quarterly', 'FREQ=MONTHLY;INTERVAL=3'],
    ['twice_a_year', 'FREQ=MONTHLY;INTERVAL=6'],
    ['annual', 'FREQ=YEARLY'],
  ])('maps cadence %s to RRULE %s', async (cadence, expectedRule) => {
    const { proposal } = await new CreateServiceAgreementTaskHandler().handle(
      ctx({
        customerId: CUSTOMER_ID,
        existingEntities: {
          serviceAgreementName: 'Maintenance plan',
          serviceAgreementCadence: cadence,
          amount: 7900,
        },
      }),
    );

    const payload = proposal.payload as Record<string, unknown>;
    expect(payload.recurrenceRule).toBe(expectedRule);
    expect(missingFieldsFor(proposal)).not.toContain('recurrenceRule');
  });

  describe('startsOn', () => {
    it('defaults to the first of next month in the TENANT timezone — not a naive server-local default', async () => {
      // UTC instant is already Jan 1, 2026 — but in America/Los_Angeles
      // (UTC-8) it is still Dec 31, 2025 locally. A naive `new Date()`
      // UTC-based default would compute Feb 1, 2026 (wrong); the correct
      // tenant-local answer is Jan 1, 2026 (first of next month from the
      // tenant's actual "today", Dec 31, 2025).
      const now = new Date('2026-01-01T02:00:00Z');
      const { proposal } = await new CreateServiceAgreementTaskHandler().handle(
        ctx({
          customerId: CUSTOMER_ID,
          now,
          timezone: 'America/Los_Angeles',
          existingEntities: {
            serviceAgreementName: 'Annual maintenance plan',
            serviceAgreementCadence: 'annual',
            amount: 29000,
          },
        }),
      );

      const payload = proposal.payload as Record<string, unknown>;
      expect(payload.startsOn).toBe('2026-01-01');
    });

    it('falls back to the product-default timezone when no tenant timezone resolved (never raw Date() math)', async () => {
      const now = new Date('2026-03-15T12:00:00Z');
      const { proposal } = await new CreateServiceAgreementTaskHandler().handle(
        ctx({
          customerId: CUSTOMER_ID,
          now,
          existingEntities: {
            serviceAgreementName: 'Annual maintenance plan',
            serviceAgreementCadence: 'annual',
            amount: 29000,
          },
        }),
      );

      const payload = proposal.payload as Record<string, unknown>;
      expect(payload.startsOn).toBe('2026-04-01');
    });

    it('honors an explicit spoken start date over the default', async () => {
      const now = new Date('2026-01-01T12:00:00Z');
      const { proposal } = await new CreateServiceAgreementTaskHandler().handle(
        ctx({
          customerId: CUSTOMER_ID,
          now,
          timezone: 'America/New_York',
          existingEntities: {
            serviceAgreementName: 'Annual maintenance plan',
            serviceAgreementCadence: 'annual',
            amount: 29000,
            serviceAgreementStartsOn: 'October 1, 2026',
          },
        }),
      );

      const payload = proposal.payload as Record<string, unknown>;
      expect(payload.startsOn).toBe('2026-10-01');
    });

    it('resolves a bare month phrase ("starting September") to the 1st of that month', async () => {
      const now = new Date('2026-01-01T12:00:00Z');
      const { proposal } = await new CreateServiceAgreementTaskHandler().handle(
        ctx({
          customerId: CUSTOMER_ID,
          now,
          timezone: 'America/New_York',
          existingEntities: {
            serviceAgreementName: '29-a-month membership',
            serviceAgreementCadence: 'monthly',
            amount: 2900,
            serviceAgreementStartsOn: 'starting September',
          },
        }),
      );

      const payload = proposal.payload as Record<string, unknown>;
      expect(payload.startsOn).toBe('2026-09-01');
    });

    it('falls back to the default when the spoken phrase is unparseable', async () => {
      const now = new Date('2026-03-15T12:00:00Z');
      const { proposal } = await new CreateServiceAgreementTaskHandler().handle(
        ctx({
          customerId: CUSTOMER_ID,
          now,
          timezone: 'America/New_York',
          existingEntities: {
            serviceAgreementName: 'Annual maintenance plan',
            serviceAgreementCadence: 'annual',
            amount: 29000,
            serviceAgreementStartsOn: 'sometime, whenever works',
          },
        }),
      );

      const payload = proposal.payload as Record<string, unknown>;
      expect(payload.startsOn).toBe('2026-04-01');
    });
  });
});

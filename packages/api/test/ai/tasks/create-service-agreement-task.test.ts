/**
 * Task 7 (2026-08-07 tradesperson plan) — CreateServiceAgreementTaskHandler
 * (drafting leg).
 *
 * Mirrors SendCustomerMessageTaskHandler's customer resolution: joins
 * `CUSTOMER_REF_INTENTS` (entity-resolution.ts), so the voice-action-router
 * resolves the spoken customer name to a verified id BEFORE this handler
 * runs and threads it onto `context.customerId` — the generic resolution
 * behavior itself is pinned in
 * test/ai/agents/customer-calling/entity-resolution.test.ts.
 *
 * Cadence words are mapped deterministically to an RRULE string — no LLM
 * call in this handler. `startsOn` defaults to the first of next month
 * computed from the TENANT's local calendar date (never raw server-local
 * `Date` math); a spoken override is parsed best-effort via chrono-node,
 * guarded (quality-review I2) against ambiguous relative phrases ("a
 * year") and past dates ("January 2019").
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

  // Quality-review — payload.recurrenceRule ("FREQ=YEARLY") is not
  // something an operator verifies by eye; the review card must state the
  // plan in plain language instead.
  it('renders a human-readable explanation instead of the raw RRULE', async () => {
    const { proposal } = await new CreateServiceAgreementTaskHandler().handle(
      ctx({
        customerId: CUSTOMER_ID,
        now: new Date('2026-06-01T12:00:00Z'),
        timezone: 'America/New_York',
        existingEntities: {
          serviceAgreementName: 'Annual maintenance plan',
          serviceAgreementCadence: 'twice_a_year',
          amount: 29000,
          serviceAgreementStartsOn: 'September 1, 2026',
        },
      }),
    );

    expect(proposal.explanation).toBe('Twice a year, $290.00, starting Sep 1, 2026');
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

  // Quality-review addendum #17(a) — a $0 plan is legal at the CONTRACT
  // layer (a comp membership, reachable via non-voice callers), but this
  // handler is deliberately stricter: voice cannot distinguish "the
  // caller said zero" from "the caller didn't state a price", so it never
  // emits priceCents: 0. See contracts/create-service-agreement.ts's doc
  // comment for the full rationale — the two behaviors are intentionally
  // different layers, not a contradiction.
  it('a spoken zero amount is not trusted as a real price (gates) — voice can never produce a $0 plan today', async () => {
    const { proposal } = await new CreateServiceAgreementTaskHandler().handle(
      ctx({
        customerId: CUSTOMER_ID,
        existingEntities: {
          serviceAgreementName: 'Annual maintenance plan',
          serviceAgreementCadence: 'annual',
          amount: 0,
        },
      }),
    );

    expect(missingFieldsFor(proposal)).toContain('priceCents');
  });

  it('a negative spoken amount is not trusted as a real price (gates)', async () => {
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
          serviceAgreementCadence: cadence as 'monthly' | 'quarterly' | 'twice_a_year' | 'annual',
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

    // Quality-review minor — the ORIGINAL version of this test used a
    // midday UTC instant, which produces the SAME local calendar date in
    // every candidate zone (New_York and UTC never diverge at noon), so it
    // could not actually distinguish "used the tenant zone" from "ignored
    // it and used UTC". This instant (11:30pm UTC) is still "today" in UTC
    // but already "tomorrow" in America/New_York (UTC-4 in June, EDT) —
    // the two zones compute DIFFERENT calendar dates, so this test fails
    // if the fallback ever silently reverts to UTC math.
    it('falls back to the product-default timezone when no tenant timezone resolved (never raw Date() math)', async () => {
      const now = new Date('2026-06-14T23:30:00Z'); // 7:30pm EDT same day; 11:30pm UTC same day
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
      // DEFAULT_TENANT_TIMEZONE (America/New_York) reads June 14 locally
      // -> first of next month = July 1. A UTC-based implementation would
      // ALSO read June 14 here (this instant hasn't crossed UTC midnight
      // yet either), so add a second assertion below that DOES diverge.
      expect(payload.startsOn).toBe('2026-07-01');
    });

    // The genuinely discriminating case: an instant already past UTC
    // midnight but still "yesterday" in America/New_York.
    it('uses the tenant-local calendar day, not the UTC day, when they disagree', async () => {
      const now = new Date('2026-07-01T02:00:00Z'); // July 1 in UTC; June 30, 10pm EDT locally
      const { proposal } = await new CreateServiceAgreementTaskHandler().handle(
        ctx({
          customerId: CUSTOMER_ID,
          now,
          // No explicit timezone -> falls back to DEFAULT_TENANT_TIMEZONE
          // (America/New_York), exercising the SAME fallback path as the
          // test above, but at an instant where UTC and America/New_York
          // disagree on the calendar day.
          existingEntities: {
            serviceAgreementName: 'Annual maintenance plan',
            serviceAgreementCadence: 'annual',
            amount: 29000,
          },
        }),
      );

      const payload = proposal.payload as Record<string, unknown>;
      // Tenant-local "today" is June 30 -> first of next month = July 1.
      // A UTC-based bug would instead read "today" as July 1 -> August 1.
      expect(payload.startsOn).toBe('2026-07-01');
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

    // Quality-review I2, guard 1 — a fully ambiguous relative phrase
    // (neither month nor day named) must NOT resolve to chrono's best
    // guess. This is the classifier's OWN canonical example: "290 a year"
    // could drop "a year" into this field.
    it.each(['a year', 'last year'])(
      'falls back to the default for an ambiguous relative phrase (%s), never chrono\'s best guess',
      async (phrase) => {
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
              serviceAgreementStartsOn: phrase,
            },
          }),
        );

        const payload = proposal.payload as Record<string, unknown>;
        // Default (first of next month from 2026-03-15) — NOT chrono's
        // "a year"/"last year" guess (2027-03-15 / 2025-03-15).
        expect(payload.startsOn).toBe('2026-04-01');
      },
    );

    // Quality-review I2, guard 2 — an explicit but PAST date must not
    // reach nextRunAt: the sweep (every 60 seconds) would pick it up
    // immediately and drip a job+invoice pair roughly once a minute.
    it('falls back to the default for an explicit but PAST date ("January 2019")', async () => {
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
            serviceAgreementStartsOn: 'January 2019',
          },
        }),
      );

      const payload = proposal.payload as Record<string, unknown>;
      expect(payload.startsOn).toBe('2026-04-01');
    });

    it('still resolves relative phrases that keep working ("next week")', async () => {
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
            serviceAgreementStartsOn: 'next week',
          },
        }),
      );

      const payload = proposal.payload as Record<string, unknown>;
      expect(payload.startsOn).toBe('2026-03-22');
    });
  });

  // Quality-review addendum #16 — the coordinator's ruling accepts the
  // soft timezone default (unlike appointment scheduling) ON CONDITION
  // that the assumption is made VISIBLE on the review card.
  it('names the assumed timezone in the explanation when no tenant timezone resolved', async () => {
    const { proposal } = await new CreateServiceAgreementTaskHandler().handle(
      ctx({
        customerId: CUSTOMER_ID,
        now: new Date('2026-06-01T12:00:00Z'),
        // No timezone supplied -> falls back to DEFAULT_TENANT_TIMEZONE.
        existingEntities: {
          serviceAgreementName: 'Annual maintenance plan',
          serviceAgreementCadence: 'annual',
          amount: 29000,
        },
      }),
    );

    expect(proposal.explanation).toContain('assumed America/New_York — tenant timezone unset');
  });

  it('does NOT name an assumed timezone when the tenant timezone resolved normally', async () => {
    const { proposal } = await new CreateServiceAgreementTaskHandler().handle(
      ctx({
        customerId: CUSTOMER_ID,
        now: new Date('2026-06-01T12:00:00Z'),
        timezone: 'America/Los_Angeles',
        existingEntities: {
          serviceAgreementName: 'Annual maintenance plan',
          serviceAgreementCadence: 'annual',
          amount: 29000,
        },
      }),
    );

    expect(proposal.explanation).not.toContain('assumed');
  });
});

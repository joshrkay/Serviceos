/**
 * Task 7 (2026-08-07 tradesperson plan) — create_service_agreement
 * execution handler tests.
 *
 * `create_service_agreement` signs a customer up for a recurring
 * maintenance plan/membership — writes a `service_agreements` row
 * (migration 056, already live) that the existing recurring-agreements
 * sweep (`agreements/agreement-service.ts runDueAgreements`, driven by
 * `workers/recurring-agreements-worker.ts`) picks up on its own schedule
 * and invoices from later. No money moves at creation, so capture-class —
 * same posture as `draft_estimate` / `create_change_order`.
 *
 * Covers: valid-type + capture-class classification, payload validation
 * (customerId/name/recurrenceRule/priceCents/startsOn required,
 * priceCents rejects negative and an absurd sanity-ceiling breach, name
 * rejects empty, startsOn rejects a malformed/impossible calendar date AND
 * a date already in the past), dev-wiring passthrough
 * (LogExpenseExecutionHandler's house pattern), the customer
 * service-location resolution ladder (quality-review C1), the wired
 * agreement-creation path via the SAME `createAgreement` the authenticated
 * route uses (quality-review I1) with its full commitment-defaults set
 * pinned, and a sweep round-trip proving a handler-created agreement
 * actually produces a `generated` run (quality-review I4b — the test that
 * would have caught C1).
 */
import { describe, it, expect } from 'vitest';
import { CreateServiceAgreementExecutionHandler } from '../../src/proposals/execution/create-service-agreement-handler';
import { InMemoryAgreementRepository } from '../../src/agreements/agreement';
import { InMemoryAgreementRunRepository } from '../../src/agreements/agreement-run';
import { runDueAgreements, JobsServicePort, InvoicesServicePort } from '../../src/agreements/agreement-service';
import { InMemoryLocationRepository, ServiceLocation } from '../../src/locations/location';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { Proposal, VALID_PROPOSAL_TYPES, actionClassForProposalType } from '../../src/proposals/proposal';
import { validateProposalPayload } from '../../src/proposals/contracts';

const TENANT = 't-1';
const OTHER_TENANT = 't-2';
const CUSTOMER_ID = '11111111-1111-4111-8111-111111111111';
const LOCATION_ID = '99999999-9999-4999-8999-999999999999';

/**
 * A safely-future ISO date with an EXPLICIT day-of-month, computed
 * relative to REAL wall-clock time so these tests never go stale as the
 * calendar advances (the contract rejects a past `startsOn` — quality-
 * review I2 defense-in-depth — so a hardcoded literal like '2026-09-01'
 * would eventually start failing).
 */
function futureDateWithDay(monthsAhead: number, day: number): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + monthsAhead, day))
    .toISOString()
    .slice(0, 10);
}

const VALID_STARTS_ON = futureDateWithDay(2, 1); // always day 1, always >= 2 months out

function makeLocation(overrides: Partial<ServiceLocation> = {}): ServiceLocation {
  const now = new Date();
  return {
    id: LOCATION_ID,
    tenantId: TENANT,
    customerId: CUSTOMER_ID,
    street1: '1 Main St',
    city: 'Austin',
    state: 'TX',
    postalCode: '78701',
    country: 'US',
    addressType: 'service',
    isPrimary: true,
    isArchived: false,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeProposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    id: 'prop-1',
    tenantId: TENANT,
    proposalType: 'create_service_agreement',
    status: 'approved',
    payload: {
      customerId: CUSTOMER_ID,
      name: 'Annual maintenance plan',
      recurrenceRule: 'FREQ=MONTHLY',
      priceCents: 2900,
      startsOn: VALID_STARTS_ON,
    },
    summary: 'Service agreement for the Garcias',
    createdBy: 'u-1',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('create_service_agreement proposal type', () => {
  it('is a valid proposal type classified as capture', () => {
    expect(VALID_PROPOSAL_TYPES).toContain('create_service_agreement');
    expect(actionClassForProposalType('create_service_agreement')).toBe('capture');
  });

  it('accepts a well-formed payload', () => {
    const result = validateProposalPayload('create_service_agreement', {
      customerId: CUSTOMER_ID,
      name: 'Annual maintenance plan',
      recurrenceRule: 'FREQ=MONTHLY',
      priceCents: 2900,
      startsOn: VALID_STARTS_ON,
    });
    expect(result.valid).toBe(true);
  });

  it('rejects a payload missing customerId', () => {
    const result = validateProposalPayload('create_service_agreement', {
      name: 'Annual maintenance plan',
      recurrenceRule: 'FREQ=MONTHLY',
      priceCents: 2900,
      startsOn: VALID_STARTS_ON,
    });
    expect(result.valid).toBe(false);
  });

  it('rejects a negative priceCents', () => {
    const result = validateProposalPayload('create_service_agreement', {
      customerId: CUSTOMER_ID,
      name: 'Annual maintenance plan',
      recurrenceRule: 'FREQ=MONTHLY',
      priceCents: -100,
      startsOn: VALID_STARTS_ON,
    });
    expect(result.valid).toBe(false);
  });

  // Quality-review minor — priceCentsSchema alone allows up to
  // Number.MAX_SAFE_INTEGER; the contract adds a sanity ceiling so a
  // misheard "290 thousand a year" doesn't persist a $2.9M/period plan.
  it('rejects a priceCents that breaches the sanity ceiling', () => {
    const result = validateProposalPayload('create_service_agreement', {
      customerId: CUSTOMER_ID,
      name: 'Annual maintenance plan',
      recurrenceRule: 'FREQ=YEARLY',
      priceCents: 29_000_000, // $290,000/period
      startsOn: VALID_STARTS_ON,
    });
    expect(result.valid).toBe(false);
  });

  it('accepts a zero priceCents (a free/comp plan is legal at the contract layer)', () => {
    const result = validateProposalPayload('create_service_agreement', {
      customerId: CUSTOMER_ID,
      name: 'Annual maintenance plan',
      recurrenceRule: 'FREQ=MONTHLY',
      priceCents: 0,
      startsOn: VALID_STARTS_ON,
    });
    expect(result.valid).toBe(true);
  });

  it('rejects an empty name', () => {
    const result = validateProposalPayload('create_service_agreement', {
      customerId: CUSTOMER_ID,
      name: '',
      recurrenceRule: 'FREQ=MONTHLY',
      priceCents: 2900,
      startsOn: VALID_STARTS_ON,
    });
    expect(result.valid).toBe(false);
  });

  it('rejects a missing recurrenceRule', () => {
    const result = validateProposalPayload('create_service_agreement', {
      customerId: CUSTOMER_ID,
      name: 'Annual maintenance plan',
      priceCents: 2900,
      startsOn: VALID_STARTS_ON,
    });
    expect(result.valid).toBe(false);
  });

  it('rejects a garbage recurrenceRule the recurrence engine cannot parse', () => {
    const result = validateProposalPayload('create_service_agreement', {
      customerId: CUSTOMER_ID,
      name: 'Annual maintenance plan',
      recurrenceRule: 'weekly-ish',
      priceCents: 2900,
      startsOn: VALID_STARTS_ON,
    });
    expect(result.valid).toBe(false);
  });

  it('rejects a malformed startsOn (wrong shape)', () => {
    const result = validateProposalPayload('create_service_agreement', {
      customerId: CUSTOMER_ID,
      name: 'Annual maintenance plan',
      recurrenceRule: 'FREQ=MONTHLY',
      priceCents: 2900,
      startsOn: 'September 1st',
    });
    expect(result.valid).toBe(false);
  });

  // Right shape, impossible calendar date — must not reach nextRunAt
  // computation as a silently-rolled-over date (Feb 30 -> Mar 2).
  it('rejects a startsOn that is not a real calendar date', () => {
    const result = validateProposalPayload('create_service_agreement', {
      customerId: CUSTOMER_ID,
      name: 'Annual maintenance plan',
      recurrenceRule: 'FREQ=MONTHLY',
      priceCents: 2900,
      startsOn: '2026-02-30',
    });
    expect(result.valid).toBe(false);
  });

  // Quality-review I2 defense-in-depth — a back-dated startsOn would be
  // picked up by the sweep (every 60 seconds) on its very next tick and
  // drip a job+invoice pair roughly once a minute until it caught up.
  it('rejects a startsOn already in the past', () => {
    const result = validateProposalPayload('create_service_agreement', {
      customerId: CUSTOMER_ID,
      name: 'Annual maintenance plan',
      recurrenceRule: 'FREQ=MONTHLY',
      priceCents: 2900,
      startsOn: '2020-01-01',
    });
    expect(result.valid).toBe(false);
  });
});

describe('CreateServiceAgreementExecutionHandler', () => {
  const ctx = { tenantId: TENANT, executedBy: 'u-1' };

  function wired(opts: { auditRepo?: InMemoryAuditRepository; seedLocation?: boolean } = {}) {
    const agreementRepo = new InMemoryAgreementRepository();
    const locationRepo = new InMemoryLocationRepository();
    const seedLocation = opts.seedLocation ?? true;
    const ready = seedLocation ? locationRepo.create(makeLocation()) : Promise.resolve(undefined);
    return ready.then(() => ({
      agreementRepo,
      locationRepo,
      handler: new CreateServiceAgreementExecutionHandler(agreementRepo, opts.auditRepo, locationRepo),
    }));
  }

  it('degrades to a synthetic-id passthrough when no agreementRepo is wired', async () => {
    const handler = new CreateServiceAgreementExecutionHandler(undefined, undefined, new InMemoryLocationRepository());
    const result = await handler.execute(makeProposal(), ctx);
    expect(result.success).toBe(true);
    expect(result.resultEntityId).toMatch(/[0-9a-f-]{36}/);
  });

  it('degrades to a synthetic-id passthrough when no locationRepo is wired', async () => {
    const handler = new CreateServiceAgreementExecutionHandler(new InMemoryAgreementRepository());
    const result = await handler.execute(makeProposal(), ctx);
    expect(result.success).toBe(true);
    expect(result.resultEntityId).toMatch(/[0-9a-f-]{36}/);
  });

  it('isFullyWired requires BOTH agreementRepo and locationRepo', () => {
    const agreementRepo = new InMemoryAgreementRepository();
    const locationRepo = new InMemoryLocationRepository();
    expect(new CreateServiceAgreementExecutionHandler(agreementRepo, undefined, locationRepo).isFullyWired()).toBe(
      true,
    );
    expect(new CreateServiceAgreementExecutionHandler(agreementRepo).isFullyWired()).toBe(false);
    expect(new CreateServiceAgreementExecutionHandler(undefined, undefined, locationRepo).isFullyWired()).toBe(false);
    expect(new CreateServiceAgreementExecutionHandler().isFullyWired()).toBe(false);
  });

  it('fails cleanly on an invalid payload (missing customerId) without throwing', async () => {
    const { handler } = await wired();
    const result = await handler.execute(
      makeProposal({
        payload: {
          name: 'Annual maintenance plan',
          recurrenceRule: 'FREQ=MONTHLY',
          priceCents: 2900,
          startsOn: VALID_STARTS_ON,
        },
      }),
      ctx,
    );
    expect(result.success).toBe(false);
  });

  // Quality-review C1 — the whole point of this handler's location
  // resolution: without it, EVERY voice-created agreement's sweep runs
  // failed forever (locationId: '' rejected by createJob).
  describe('service-location resolution (C1)', () => {
    it('fails execution — no mutation — when the customer has no service location at all', async () => {
      const { agreementRepo, handler } = await wired({ seedLocation: false });

      const result = await handler.execute(makeProposal(), ctx);
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/no service location/i);
      expect(await agreementRepo.findByTenant(TENANT)).toHaveLength(0);
    });

    it('resolves the customer PRIMARY active location when multiple locations exist', async () => {
      const agreementRepo = new InMemoryAgreementRepository();
      const locationRepo = new InMemoryLocationRepository();
      await locationRepo.create(makeLocation({ id: 'loc-secondary', isPrimary: false }));
      await locationRepo.create(makeLocation({ id: 'loc-primary', isPrimary: true }));
      const handler = new CreateServiceAgreementExecutionHandler(agreementRepo, undefined, locationRepo);

      const result = await handler.execute(makeProposal(), ctx);
      expect(result.success).toBe(true);

      const stored = await agreementRepo.findById(TENANT, result.resultEntityId!);
      expect(stored!.locationId).toBe('loc-primary');
    });

    it('falls back to any active location when none is primary', async () => {
      const agreementRepo = new InMemoryAgreementRepository();
      const locationRepo = new InMemoryLocationRepository();
      await locationRepo.create(makeLocation({ id: 'loc-only', isPrimary: false }));
      const handler = new CreateServiceAgreementExecutionHandler(agreementRepo, undefined, locationRepo);

      const result = await handler.execute(makeProposal(), ctx);
      expect(result.success).toBe(true);

      const stored = await agreementRepo.findById(TENANT, result.resultEntityId!);
      expect(stored!.locationId).toBe('loc-only');
    });

    it('ignores an archived location, failing execution if it is the only one', async () => {
      const agreementRepo = new InMemoryAgreementRepository();
      const locationRepo = new InMemoryLocationRepository();
      await locationRepo.create(makeLocation({ isArchived: true }));
      const handler = new CreateServiceAgreementExecutionHandler(agreementRepo, undefined, locationRepo);

      const result = await handler.execute(makeProposal(), ctx);
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/no service location/i);
    });

    it('honors an explicit payload.locationId over resolution when the payload supplies one', async () => {
      const agreementRepo = new InMemoryAgreementRepository();
      const locationRepo = new InMemoryLocationRepository();
      await locationRepo.create(makeLocation({ id: 'loc-primary', isPrimary: true }));
      const handler = new CreateServiceAgreementExecutionHandler(agreementRepo, undefined, locationRepo);
      const explicitLocationId = '88888888-8888-4888-8888-888888888888';

      const result = await handler.execute(
        makeProposal({ payload: { ...makeProposal().payload, locationId: explicitLocationId } }),
        ctx,
      );
      expect(result.success).toBe(true);

      const stored = await agreementRepo.findById(TENANT, result.resultEntityId!);
      expect(stored!.locationId).toBe(explicitLocationId);
    });
  });

  // Quality-review I4a — pins the FULL commitment-defaults set: the
  // entire capture-class safety story for this type rests on these
  // fields never silently landing something other than "off".
  it('creates the agreement row via createAgreement with the full commitment-defaults set, nextRunAt computed from startsOn', async () => {
    const auditRepo = new InMemoryAuditRepository();
    const { agreementRepo, handler } = await wired({ auditRepo });

    const result = await handler.execute(makeProposal(), ctx);
    expect(result.success).toBe(true);
    expect(result.resultEntityId).toBeDefined();

    const stored = await agreementRepo.findById(TENANT, result.resultEntityId!);
    expect(stored).toBeDefined();
    expect(stored).toMatchObject({
      customerId: CUSTOMER_ID,
      locationId: LOCATION_ID,
      name: 'Annual maintenance plan',
      recurrenceRule: 'FREQ=MONTHLY',
      priceCents: 2900,
      startsOn: VALID_STARTS_ON,
      status: 'active',
      // The full commitment-defaults set createAgreement applies —
      // quality-review I4a.
      autoGenerateInvoice: true,
      autoGenerateJob: true,
      autoRenew: false,
      renewalCount: 0,
      memberDiscountBps: 0,
      priorityBooking: false,
      autoCollectDues: false,
    });
    expect(stored!.endsOn).toBeUndefined();
    expect(stored!.renewalTermMonths).toBeUndefined();
    // FREQ=MONTHLY has no BYMONTHDAY, so startsOn IS the first run
    // (computeFirstRun's documented behavior, agreements/agreement-service.ts).
    expect(stored!.nextRunAt.toISOString().slice(0, 10)).toBe(VALID_STARTS_ON);
  });

  it('computes a DIFFERENT nextRunAt (not a copy of startsOn) when startsOn does not match BYMONTHDAY', async () => {
    const { agreementRepo, handler } = await wired();

    const result = await handler.execute(
      makeProposal({
        payload: {
          customerId: CUSTOMER_ID,
          name: 'Monthly filter service',
          recurrenceRule: 'FREQ=MONTHLY;BYMONTHDAY=15',
          priceCents: 7900,
          startsOn: VALID_STARTS_ON, // day 1, by construction
        },
      }),
      ctx,
    );
    expect(result.success).toBe(true);

    const stored = await agreementRepo.findById(TENANT, result.resultEntityId!);
    // startsOn (the 1st) doesn't satisfy BYMONTHDAY=15, so createAgreement
    // rolls forward to the 15th of the same anchor month — proving
    // nextRunAt is genuinely COMPUTED, not just copied from startsOn.
    expect(stored!.nextRunAt.getUTCDate()).toBe(15);
    expect(stored!.nextRunAt.getTime()).toBeGreaterThan(new Date(`${VALID_STARTS_ON}T00:00:00Z`).getTime());
  });

  // I1 — createAgreement's own audit call is suppressed (undefined passed
  // as its audit repo); this handler's OWN failure-soft audit is the sole
  // emitter.
  it('emits exactly one service_agreement.created audit event carrying proposalId/priceCents/recurrenceRule/locationId', async () => {
    const auditRepo = new InMemoryAuditRepository();
    const { handler } = await wired({ auditRepo });

    const result = await handler.execute(makeProposal(), ctx);

    const events = auditRepo.getAll();
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('service_agreement.created');
    expect(events[0].entityType).toBe('service_agreement');
    expect(events[0].entityId).toBe(result.resultEntityId);
    expect(events[0].metadata).toMatchObject({
      proposalId: 'prop-1',
      proposalType: 'create_service_agreement',
      priceCents: 2900,
      recurrenceRule: 'FREQ=MONTHLY',
      locationId: LOCATION_ID,
    });
  });

  // Idempotent replay: a re-executed approval (redelivery) must never mint
  // a SECOND agreement row — mirrors CreateChangeOrderExecutionHandler's
  // same guard for the same reason (this handler also creates a brand NEW
  // row on every execute() call, unlike apply_credit/record_refund which
  // mutate an EXISTING row and are naturally idempotent elsewhere).
  it('replays the same resultEntityId without creating a second row when already executed', async () => {
    const { agreementRepo, handler } = await wired();

    const already = makeProposal({ resultEntityId: 'agreement-existing' });
    const result = await handler.execute(already, ctx);
    expect(result).toEqual({ success: true, resultEntityId: 'agreement-existing' });
    expect(await agreementRepo.findByTenant(TENANT)).toHaveLength(0);
  });

  it('tenant isolation — an agreement created for one tenant is invisible from another tenant’s repo view', async () => {
    const agreementRepo = new InMemoryAgreementRepository();
    const locationRepo = new InMemoryLocationRepository();
    await locationRepo.create(makeLocation({ tenantId: OTHER_TENANT }));
    const handler = new CreateServiceAgreementExecutionHandler(agreementRepo, undefined, locationRepo);

    const result = await handler.execute(makeProposal(), { tenantId: OTHER_TENANT, executedBy: 'u-2' });
    expect(result.success).toBe(true);

    const seenFromOriginalTenant = await agreementRepo.findById(TENANT, result.resultEntityId!);
    expect(seenFromOriginalTenant).toBeNull();
    const seenFromOwnTenant = await agreementRepo.findById(OTHER_TENANT, result.resultEntityId!);
    expect(seenFromOwnTenant).toBeDefined();
  });

  // Quality-review I4b — the test that would have caught C1: a handler-
  // created agreement must actually be CONSUMABLE by the real sweep, not
  // just persisted. Before the C1 fix this row asserted failedRunIds
  // (locationId: '' rejected by createJob); it now asserts 'generated'.
  it('sweep round-trip: a handler-created agreement produces a GENERATED run, not a failed one', async () => {
    const { agreementRepo, handler } = await wired();
    const runRepo = new InMemoryAgreementRunRepository();

    const created = await handler.execute(makeProposal(), ctx);
    expect(created.success).toBe(true);

    let capturedLocationId: string | undefined;
    const jobsService: JobsServicePort = {
      async createJob(input) {
        capturedLocationId = input.locationId;
        return { id: 'job-1' };
      },
    };
    const invoicesService: InvoicesServicePort = {
      async createDraftInvoice() {
        return { id: 'invoice-1' };
      },
    };

    const result = await runDueAgreements(TENANT, {
      agreementRepo,
      runRepo,
      jobsService,
      invoicesService,
      now: new Date(`${VALID_STARTS_ON}T00:00:00Z`),
    });

    expect(result.failedRunIds).toEqual([]);
    expect(result.generatedRunIds).toHaveLength(1);
    // The C1 bug's exact signature: locationId reaching createJob as ''.
    expect(capturedLocationId).toBe(LOCATION_ID);
    expect(capturedLocationId).not.toBe('');
  });
});

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
 * priceCents rejects negative, name rejects empty, startsOn rejects a
 * malformed/impossible calendar date), dev-wiring passthrough
 * (LogExpenseExecutionHandler's house pattern), and the wired
 * agreement-creation path (nextRunAt computed from startsOn via the SAME
 * `computeFirstRun` the authenticated route/sweep use, read back through
 * the real repo).
 */
import { describe, it, expect } from 'vitest';
import { CreateServiceAgreementExecutionHandler } from '../../src/proposals/execution/create-service-agreement-handler';
import { InMemoryAgreementRepository } from '../../src/agreements/agreement';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { Proposal, VALID_PROPOSAL_TYPES, actionClassForProposalType } from '../../src/proposals/proposal';
import { validateProposalPayload } from '../../src/proposals/contracts';

const TENANT = 't-1';
const OTHER_TENANT = 't-2';
const CUSTOMER_ID = '11111111-1111-4111-8111-111111111111';

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
      startsOn: '2026-09-01',
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
      startsOn: '2026-09-01',
    });
    expect(result.valid).toBe(true);
  });

  it('rejects a payload missing customerId', () => {
    const result = validateProposalPayload('create_service_agreement', {
      name: 'Annual maintenance plan',
      recurrenceRule: 'FREQ=MONTHLY',
      priceCents: 2900,
      startsOn: '2026-09-01',
    });
    expect(result.valid).toBe(false);
  });

  it('rejects a negative priceCents', () => {
    const result = validateProposalPayload('create_service_agreement', {
      customerId: CUSTOMER_ID,
      name: 'Annual maintenance plan',
      recurrenceRule: 'FREQ=MONTHLY',
      priceCents: -100,
      startsOn: '2026-09-01',
    });
    expect(result.valid).toBe(false);
  });

  it('accepts a zero priceCents (a free/comp plan is legal)', () => {
    const result = validateProposalPayload('create_service_agreement', {
      customerId: CUSTOMER_ID,
      name: 'Annual maintenance plan',
      recurrenceRule: 'FREQ=MONTHLY',
      priceCents: 0,
      startsOn: '2026-09-01',
    });
    expect(result.valid).toBe(true);
  });

  it('rejects an empty name', () => {
    const result = validateProposalPayload('create_service_agreement', {
      customerId: CUSTOMER_ID,
      name: '',
      recurrenceRule: 'FREQ=MONTHLY',
      priceCents: 2900,
      startsOn: '2026-09-01',
    });
    expect(result.valid).toBe(false);
  });

  it('rejects a missing recurrenceRule', () => {
    const result = validateProposalPayload('create_service_agreement', {
      customerId: CUSTOMER_ID,
      name: 'Annual maintenance plan',
      priceCents: 2900,
      startsOn: '2026-09-01',
    });
    expect(result.valid).toBe(false);
  });

  it('rejects a garbage recurrenceRule the recurrence engine cannot parse', () => {
    const result = validateProposalPayload('create_service_agreement', {
      customerId: CUSTOMER_ID,
      name: 'Annual maintenance plan',
      recurrenceRule: 'weekly-ish',
      priceCents: 2900,
      startsOn: '2026-09-01',
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
});

describe('CreateServiceAgreementExecutionHandler', () => {
  const ctx = { tenantId: TENANT, executedBy: 'u-1' };

  function wired(auditRepo?: InMemoryAuditRepository) {
    const agreementRepo = new InMemoryAgreementRepository();
    return {
      agreementRepo,
      handler: new CreateServiceAgreementExecutionHandler(agreementRepo, auditRepo),
    };
  }

  it('degrades to a synthetic-id passthrough when no agreementRepo is wired', async () => {
    const handler = new CreateServiceAgreementExecutionHandler();
    const result = await handler.execute(makeProposal(), ctx);
    expect(result.success).toBe(true);
    expect(result.resultEntityId).toMatch(/[0-9a-f-]{36}/);
  });

  it('isFullyWired requires the agreementRepo', () => {
    expect(new CreateServiceAgreementExecutionHandler(new InMemoryAgreementRepository()).isFullyWired()).toBe(true);
    expect(new CreateServiceAgreementExecutionHandler().isFullyWired()).toBe(false);
  });

  it('fails cleanly on an invalid payload (missing customerId) without throwing', async () => {
    const { handler } = wired();
    const result = await handler.execute(
      makeProposal({
        payload: { name: 'Annual maintenance plan', recurrenceRule: 'FREQ=MONTHLY', priceCents: 2900, startsOn: '2026-09-01' },
      }),
      ctx,
    );
    expect(result.success).toBe(false);
  });

  it('creates the agreement row with nextRunAt computed from startsOn, read back through the repo', async () => {
    const auditRepo = new InMemoryAuditRepository();
    const { agreementRepo, handler } = wired(auditRepo);

    const result = await handler.execute(makeProposal(), ctx);
    expect(result.success).toBe(true);
    expect(result.resultEntityId).toBeDefined();

    const stored = await agreementRepo.findById(TENANT, result.resultEntityId!);
    expect(stored).toBeDefined();
    expect(stored!.customerId).toBe(CUSTOMER_ID);
    expect(stored!.name).toBe('Annual maintenance plan');
    expect(stored!.recurrenceRule).toBe('FREQ=MONTHLY');
    expect(stored!.priceCents).toBe(2900);
    expect(stored!.startsOn).toBe('2026-09-01');
    expect(stored!.status).toBe('active');
    // FREQ=MONTHLY has no BYMONTHDAY, so startsOn IS the first run
    // (computeFirstRun's documented behavior, agreements/agreement-service.ts).
    expect(stored!.nextRunAt.toISOString().slice(0, 10)).toBe('2026-09-01');
  });

  it('computes a DIFFERENT nextRunAt (not a copy of startsOn) when startsOn does not match BYMONTHDAY', async () => {
    const { agreementRepo, handler } = wired();

    const result = await handler.execute(
      makeProposal({
        payload: {
          customerId: CUSTOMER_ID,
          name: 'Monthly filter service',
          recurrenceRule: 'FREQ=MONTHLY;BYMONTHDAY=15',
          priceCents: 7900,
          startsOn: '2026-09-01',
        },
      }),
      ctx,
    );
    expect(result.success).toBe(true);

    const stored = await agreementRepo.findById(TENANT, result.resultEntityId!);
    // startsOn (Sep 1) doesn't satisfy BYMONTHDAY=15, so computeFirstRun
    // rolls forward to the 15th of the same anchor month — proving
    // nextRunAt is genuinely COMPUTED, not just copied from startsOn.
    expect(stored!.nextRunAt.toISOString().slice(0, 10)).toBe('2026-09-15');
  });

  it('emits a service_agreement.created audit event carrying proposalId/priceCents/recurrenceRule', async () => {
    const auditRepo = new InMemoryAuditRepository();
    const { handler } = wired(auditRepo);

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
    });
  });

  // Idempotent replay: a re-executed approval (redelivery) must never mint
  // a SECOND agreement row — mirrors CreateChangeOrderExecutionHandler's
  // same guard for the same reason (this handler also creates a brand NEW
  // row on every execute() call, unlike apply_credit/record_refund which
  // mutate an EXISTING row and are naturally idempotent elsewhere).
  it('replays the same resultEntityId without creating a second row when already executed', async () => {
    const { agreementRepo, handler } = wired();

    const already = makeProposal({ resultEntityId: 'agreement-existing' });
    const result = await handler.execute(already, ctx);
    expect(result).toEqual({ success: true, resultEntityId: 'agreement-existing' });
    expect(await agreementRepo.findByTenant(TENANT)).toHaveLength(0);
  });

  it('tenant isolation — an agreement created for one tenant is invisible from another tenant’s repo view', async () => {
    const { agreementRepo, handler } = wired();

    const result = await handler.execute(makeProposal(), { tenantId: OTHER_TENANT, executedBy: 'u-2' });
    expect(result.success).toBe(true);

    const seenFromOriginalTenant = await agreementRepo.findById(TENANT, result.resultEntityId!);
    expect(seenFromOriginalTenant).toBeNull();
    const seenFromOwnTenant = await agreementRepo.findById(OTHER_TENANT, result.resultEntityId!);
    expect(seenFromOwnTenant).toBeDefined();
  });
});

/**
 * #849 — the two execution handlers no test ever called.
 *
 * `MarkLeadLostExecutionHandler` and `AddServiceLocationExecutionHandler` are
 * the only two of 53 proposal types with no execution test of any kind. Before
 * this file, neither class name appeared anywhere in `packages/api/test`;
 * `wiring-assertions.test.ts` reaches them only indirectly, by iterating
 * `createExecutionHandlerRegistry`, so it can prove they are REGISTERED and
 * carry an `isFullyWired()` probe but never that they do anything. The
 * payload-contract gate covers both as `gated` rows, which assert only that
 * `missingFields` stays non-empty and never construct the handler.
 *
 * These tests assert PERSISTENCE and the AUDIT EVENT, not return values. A
 * handler that reports success without writing is indistinguishable from a
 * working one at every layer above it — the failure mode the capability audit
 * found across 33 handlers — and CLAUDE.md's Core Patterns make the audit
 * trail a mutation invariant ("All mutations: emit audit events"), so a test
 * that ignores it leaves the one documented invariant unpinned.
 *
 * SCOPE OF PROOF: in-memory repositories only. Per CLAUDE.md, "Tests that mock
 * the DB are never the only proof a query works." This moves both handlers
 * from "no execution test" to "in-memory execution proof" — NOT to the
 * real-database bar the repo sets for this class in
 * `test/integration/*-voice-execution.test.ts`. That integration test is a
 * follow-up, tracked with the proven-bar standard at #841.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { Proposal, ProposalType } from '../../../src/proposals/proposal';
import {
  MarkLeadLostExecutionHandler,
  AddServiceLocationExecutionHandler,
} from '../../../src/proposals/execution/full-app-voice-handlers';
import { InMemoryLeadRepository } from '../../../src/leads/in-memory-lead';
import { InMemoryLocationRepository } from '../../../src/locations/location';
import { InMemoryAuditRepository } from '../../../src/audit/audit';
import type { Lead } from '../../../src/leads/lead';

const TENANT = 't-1';
const EXECUTOR = 'u-1';
const EXECUTION_CONTEXT = { tenantId: TENANT, executedBy: EXECUTOR };

function approvedProposal(
  proposalType: ProposalType,
  payload: Record<string, unknown>,
): Proposal {
  const now = new Date();
  return {
    id: 'p-1',
    tenantId: TENANT,
    proposalType,
    status: 'approved',
    payload,
    summary: 'test',
    createdBy: EXECUTOR,
    createdAt: now,
    updatedAt: now,
    approvedAt: new Date(now.getTime() - 10_000),
  };
}

/** A complete `Lead` — every required field present, so no cast is needed. */
function seedLead(id: string): Lead {
  const now = new Date();
  return {
    id,
    tenantId: TENANT,
    firstName: 'Dana',
    lastName: 'Okafor',
    source: 'phone_call',
    stage: 'new',
    createdBy: EXECUTOR,
    createdAt: now,
    updatedAt: now,
  };
}

describe('MarkLeadLostExecutionHandler', () => {
  let leadRepo: InMemoryLeadRepository;
  let auditRepo: InMemoryAuditRepository;

  beforeEach(() => {
    leadRepo = new InMemoryLeadRepository();
    auditRepo = new InMemoryAuditRepository();
  });

  it('persists the lost stage and reason, and emits the audit event', async () => {
    await leadRepo.create(seedLead('lead-1'));
    const handler = new MarkLeadLostExecutionHandler(leadRepo, auditRepo);

    const result = await handler.execute(
      approvedProposal('mark_lead_lost', {
        leadId: 'lead-1',
        reason: 'went with a competitor',
      }),
      EXECUTION_CONTEXT,
    );

    expect(result.success).toBe(true);
    expect(result.resultEntityId).toBe('lead-1');

    const stored = await leadRepo.findById(TENANT, 'lead-1');
    expect(stored?.stage).toBe('lost');
    expect(stored?.lostReason).toBe('went with a competitor');

    const audits = await auditRepo.findByEntity(TENANT, 'lead', 'lead-1');
    expect(audits.some((a) => a.eventType === 'lead.lost')).toBe(true);
  });

  it('defaults the reason when the caller gave none', async () => {
    await leadRepo.create(seedLead('lead-2'));
    const handler = new MarkLeadLostExecutionHandler(leadRepo, auditRepo);

    await handler.execute(
      approvedProposal('mark_lead_lost', { leadId: 'lead-2' }),
      EXECUTION_CONTEXT,
    );

    expect((await leadRepo.findById(TENANT, 'lead-2'))?.lostReason).toBe('Lost (voice)');
  });

  it('treats an empty reason as absent rather than passing it through', async () => {
    // `loseLead` throws a ValidationError on a blank reason, so the handler's
    // `payload.reason.length > 0` check is what keeps this path working.
    await leadRepo.create(seedLead('lead-4'));
    const handler = new MarkLeadLostExecutionHandler(leadRepo, auditRepo);

    const result = await handler.execute(
      approvedProposal('mark_lead_lost', { leadId: 'lead-4', reason: '' }),
      EXECUTION_CONTEXT,
    );

    expect(result.success).toBe(true);
    expect((await leadRepo.findById(TENANT, 'lead-4'))?.lostReason).toBe('Lost (voice)');
  });

  it('rejects a payload with no resolved leadId rather than guessing', async () => {
    const handler = new MarkLeadLostExecutionHandler(leadRepo, auditRepo);
    const result = await handler.execute(
      approvedProposal('mark_lead_lost', {}),
      EXECUTION_CONTEXT,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('resolved leadId');
  });

  it('fails when the lead does not exist, instead of reporting success', async () => {
    const handler = new MarkLeadLostExecutionHandler(leadRepo, auditRepo);
    const result = await handler.execute(
      approvedProposal('mark_lead_lost', { leadId: 'missing' }),
      EXECUTION_CONTEXT,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });

  it('does not touch another tenant\'s lead', async () => {
    await leadRepo.create({ ...seedLead('lead-5'), tenantId: 'other-tenant' });
    const handler = new MarkLeadLostExecutionHandler(leadRepo, auditRepo);

    const result = await handler.execute(
      approvedProposal('mark_lead_lost', { leadId: 'lead-5' }),
      EXECUTION_CONTEXT,
    );

    expect(result.success).toBe(false);
    expect((await leadRepo.findById('other-tenant', 'lead-5'))?.stage).toBe('new');
  });

  it('reports NOT fully wired without a lead repo', () => {
    expect(new MarkLeadLostExecutionHandler().isFullyWired()).toBe(false);
    expect(new MarkLeadLostExecutionHandler(leadRepo).isFullyWired()).toBe(true);
  });

  it('pins the synthetic passthrough: no repo means success, echoing the input id', async () => {
    // Documents the degraded branch precisely. `assertVoiceHandlersWired`
    // makes it unreachable in a booting deployment, but it is one dependency
    // away from silent data loss. The meaningful assertion is that the
    // returned id is the INPUT leadId — not an id of anything created — and
    // that no audit event was emitted.
    const handler = new MarkLeadLostExecutionHandler(undefined, auditRepo);
    const result = await handler.execute(
      approvedProposal('mark_lead_lost', { leadId: 'lead-3' }),
      EXECUTION_CONTEXT,
    );

    expect(result.success).toBe(true);
    expect(result.resultEntityId).toBe('lead-3');
    expect(await auditRepo.findByEntity(TENANT, 'lead', 'lead-3')).toEqual([]);
  });
});

describe('AddServiceLocationExecutionHandler', () => {
  let locationRepo: InMemoryLocationRepository;
  let auditRepo: InMemoryAuditRepository;

  const address = {
    customerId: 'cust-1',
    street1: '14 Bridgewater Road',
    city: 'Sheffield',
    state: 'SY',
    postalCode: 'S1 2AB',
  };

  beforeEach(() => {
    locationRepo = new InMemoryLocationRepository();
    auditRepo = new InMemoryAuditRepository();
  });

  it('persists the service location against the customer, and emits the audit event', async () => {
    const handler = new AddServiceLocationExecutionHandler(locationRepo, auditRepo);

    const result = await handler.execute(
      approvedProposal('add_service_location', { ...address, label: 'Rear workshop' }),
      EXECUTION_CONTEXT,
    );

    expect(result.success).toBe(true);
    expect(result.resultEntityId).toBeTruthy();

    const stored = await locationRepo.findById(TENANT, result.resultEntityId!);
    expect(stored?.street1).toBe('14 Bridgewater Road');
    expect(stored?.customerId).toBe('cust-1');
    expect(stored?.label).toBe('Rear workshop');

    const audits = await auditRepo.findByEntity(TENANT, 'location', result.resultEntityId!);
    expect(audits.some((a) => a.eventType === 'location.created')).toBe(true);
  });

  it.each(['customerId', 'street1', 'city', 'state', 'postalCode'])(
    'refuses when %s is missing rather than writing a partial address',
    async (field) => {
      const handler = new AddServiceLocationExecutionHandler(locationRepo, auditRepo);
      const partial: Record<string, unknown> = { ...address };
      delete partial[field];

      const result = await handler.execute(
        approvedProposal('add_service_location', partial),
        EXECUTION_CONTEXT,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('full address');
    },
  );

  it('returns a failure rather than throwing when the repository fails', async () => {
    // The handler's own guard covers every field `validateLocationInput`
    // checks, so a bad payload can never reach `createLocation`'s throw. The
    // catch block's real job is a repository failure — without it the
    // rejection escapes into the executor.
    class FailingLocationRepository extends InMemoryLocationRepository {
      override async create(): Promise<never> {
        throw new Error('connection terminated');
      }
    }
    const handler = new AddServiceLocationExecutionHandler(
      new FailingLocationRepository(),
      auditRepo,
    );

    const result = await handler.execute(
      approvedProposal('add_service_location', address),
      EXECUTION_CONTEXT,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('connection terminated');
  });

  it('reports NOT fully wired without a location repo', () => {
    expect(new AddServiceLocationExecutionHandler().isFullyWired()).toBe(false);
    expect(new AddServiceLocationExecutionHandler(locationRepo).isFullyWired()).toBe(true);
  });

  it('pins the synthetic passthrough: no repo means success, echoing the customerId', async () => {
    const handler = new AddServiceLocationExecutionHandler(undefined, auditRepo);
    const result = await handler.execute(
      approvedProposal('add_service_location', address),
      EXECUTION_CONTEXT,
    );

    expect(result.success).toBe(true);
    // The customerId, not a created location id — nothing was written.
    expect(result.resultEntityId).toBe('cust-1');
    expect(await auditRepo.findRecentByTenant(TENANT, { limit: 10 })).toEqual([]);
  });
});

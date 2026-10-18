/**
 * OVAS-01 — an AI edit of an estimate the customer has ACCEPTED must never
 * void the signed acceptance without a human who saw the warning.
 *
 * The bug: EstimateEditTaskHandler stamped the RV-042 `_acceptance` marker but
 * kept `sourceTrustTier: 'autonomous'`, and auto-approval never reads markers.
 * A price-less "take the disposal fee off the Garcia estimate" with a
 * router-verified id was born 'approved', and UpdateEstimateExecutionHandler
 * passed `allowAccepted` / `invalidateAcceptance` unconditionally — deleting
 * `accepted_signature_data`, returning the row to 'sent' and resetting the
 * reminder budget so the customer was re-sent the link.
 *
 * Against real Postgres (the columns that must survive are pinned by SQL, not
 * by an in-memory double):
 *   1. the drafted proposal for an accepted target is born 'draft' (confidence
 *      0.99, supervisor present, tech mode) and carries the marker;
 *   2. executing an UNMARKED update_estimate (drafted before the customer
 *      accepted, or a marker stripped by an edit) refuses and leaves
 *      status / accepted_* / signature / version untouched;
 *   3. the MARKED proposal, once a human approved it, still voids the
 *      acceptance (the RV-042 path is preserved).
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant } from './shared';
import { PgEstimateRepository } from '../../src/estimates/pg-estimate';
import { PgSettingsRepository } from '../../src/settings/pg-settings';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgLocationRepository } from '../../src/locations/pg-location';
import { createEstimate } from '../../src/estimates/estimate';
import { getNextEstimateNumber } from '../../src/settings/settings';
import { buildLineItem } from '../../src/shared/billing-engine';
import { EstimateEditTaskHandler } from '../../src/ai/tasks/estimate-edit-task';
import { voidsCustomerAcceptance } from '../../src/proposals/acceptance-void';
import type { LLMGateway, LLMResponse } from '../../src/ai/gateway/gateway';
import { InMemoryProposalRepository, type Proposal } from '../../src/proposals/proposal';
import { InMemoryProposalExecutionRepository } from '../../src/proposals/proposal-execution';
import { transitionProposal, UNDO_WINDOW_MS } from '../../src/proposals/lifecycle';
import { ProposalExecutor } from '../../src/proposals/execution/executor';
import { IdempotencyGuard } from '../../src/proposals/execution/idempotency';
import { createExecutionHandlerRegistry } from '../../src/proposals/execution/handlers';

const SIGNATURE = 'data:image/png;base64,c2lnbmVkLWJ5LWdhcmNpYQ==';

function removeFeeGateway(): LLMGateway {
  return {
    complete: vi.fn(async () => ({
      content: JSON.stringify({
        estimateReference: 'the Garcia estimate',
        editActions: [{ type: 'remove_line_item', description: 'disposal fee' }],
        confidence_score: 0.99,
      }),
      model: 'mock',
      provider: 'mock',
      tokenUsage: { input: 10, output: 10, total: 20 },
      latencyMs: 1,
    } satisfies LLMResponse)),
  } as unknown as LLMGateway;
}

describe('OVAS-01 — accepted estimate edits (Postgres)', () => {
  let pool: Pool;
  let estimateRepo: PgEstimateRepository;
  let settingsRepo: PgSettingsRepository;
  let auditRepo: PgAuditRepository;
  let jobRepo: PgJobRepository;
  let customerRepo: PgCustomerRepository;
  let locationRepo: PgLocationRepository;
  let tenant: { tenantId: string; userId: string };

  beforeAll(async () => {
    pool = await getSharedTestDb();
    estimateRepo = new PgEstimateRepository(pool);
    settingsRepo = new PgSettingsRepository(pool);
    auditRepo = new PgAuditRepository(pool);
    jobRepo = new PgJobRepository(pool);
    customerRepo = new PgCustomerRepository(pool);
    locationRepo = new PgLocationRepository(pool);
    tenant = await createTestTenant(pool);
  });

  /** A customer-accepted, signed estimate with a disposal-fee line. */
  async function seedAcceptedEstimate(): Promise<string> {
    const { tenantId, userId } = tenant;
    const customerId = crypto.randomUUID();
    await customerRepo.create({
      id: customerId,
      tenantId,
      firstName: 'Marisol',
      lastName: 'Garcia',
      displayName: 'Marisol Garcia',
      preferredChannel: 'phone',
      smsConsent: false,
      isArchived: false,
      createdBy: userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const locationId = crypto.randomUUID();
    await locationRepo.create({
      id: locationId,
      tenantId,
      customerId,
      street1: '12 Juniper Ln',
      city: 'Austin',
      state: 'TX',
      postalCode: '78701',
      country: 'USA',
      isPrimary: true,
      isArchived: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const jobId = crypto.randomUUID();
    await jobRepo.create({
      id: jobId,
      tenantId,
      customerId,
      locationId,
      jobNumber: `JOB-GARCIA-${jobId.slice(0, 6)}`,
      summary: 'Water heater replacement',
      status: 'scheduled',
      priority: 'normal',
      createdBy: userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const estimate = await createEstimate(
      {
        tenantId,
        jobId,
        estimateNumber: await getNextEstimateNumber(tenantId, settingsRepo),
        lineItems: [
          buildLineItem('li-heater', '50-gallon heater', 1, 120000, 0, true, 'material'),
          buildLineItem('li-disposal', 'Disposal fee', 1, 7500, 1, true, 'other'),
        ],
        createdBy: userId,
      },
      estimateRepo,
      auditRepo,
    );
    // The customer signed on the portal.
    await pool.query(
      `UPDATE estimates
          SET status = 'accepted', accepted_at = now(), accepted_by_name = 'Marisol Garcia',
              accepted_signature_data = $3, sent_at = now() - interval '2 days'
        WHERE tenant_id = $1 AND id = $2`,
      [tenantId, estimate.id, SIGNATURE],
    );
    return estimate.id;
  }

  async function acceptanceRow(estimateId: string) {
    const { rows } = await pool.query(
      `SELECT status, accepted_at, accepted_by_name, accepted_signature_data, version
         FROM estimates WHERE tenant_id = $1 AND id = $2`,
      [tenant.tenantId, estimateId],
    );
    expect(rows).toHaveLength(1);
    return rows[0];
  }

  async function execute(proposal: Proposal) {
    const ready: Proposal = {
      ...(proposal.status === 'approved'
        ? proposal
        : transitionProposal(
            transitionProposal(proposal, 'ready_for_review', tenant.userId),
            'approved',
            tenant.userId,
          )),
      approvedAt: new Date(Date.now() - UNDO_WINDOW_MS - 100),
    };
    const proposalRepo = new InMemoryProposalRepository();
    await proposalRepo.create(ready);
    const executor = new ProposalExecutor(
      createExecutionHandlerRegistry({ estimateRepo, auditRepo, jobRepo }),
      proposalRepo,
      new IdempotencyGuard(new InMemoryProposalExecutionRepository(), proposalRepo),
      auditRepo,
    );
    return (await executor.execute(ready, { tenantId: tenant.tenantId, executedBy: tenant.userId }))
      .result;
  }

  async function draft(estimateId: string): Promise<Proposal> {
    const handler = new EstimateEditTaskHandler(removeFeeGateway(), estimateRepo);
    const { proposal } = await handler.handle({
      tenantId: tenant.tenantId,
      userId: tenant.userId,
      message: 'take the disposal fee off the Garcia estimate',
      // The router-verified id (voice-action-router / chat pre-draft resolver).
      existingEntities: { estimateId },
      supervisorPresent: true,
      supervisorMode: 'tech',
    });
    return proposal;
  }

  it('the drafted edit of an accepted estimate is born draft and carries the marker', async () => {
    const estimateId = await seedAcceptedEstimate();
    const proposal = await draft(estimateId);
    expect(proposal.payload.estimateId).toBe(estimateId);
    expect(proposal.missingFields ?? []).toEqual([]);
    expect(voidsCustomerAcceptance(proposal.payload)).toBe(true);
    expect(proposal.status).toBe('draft');
  });

  it('an UNMARKED update_estimate leaves accepted_signature_data, status and version untouched', async () => {
    const estimateId = await seedAcceptedEstimate();
    const before = await acceptanceRow(estimateId);
    const drafted = await draft(estimateId);
    // Drafted before the customer accepted / the marker stripped by an edit.
    const { _meta: _stripped, ...unmarked } = drafted.payload;
    const result = await execute({ ...drafted, payload: unmarked });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/accepted/i);
    const after = await acceptanceRow(estimateId);
    expect(after.status).toBe('accepted');
    expect(after.accepted_signature_data).toBe(SIGNATURE);
    expect(after.accepted_by_name).toBe('Marisol Garcia');
    expect(after.accepted_at).toEqual(before.accepted_at);
    expect(Number(after.version)).toBe(Number(before.version));
    const { rows: lines } = await pool.query(
      `SELECT description FROM estimate_line_items WHERE estimate_id = $1 ORDER BY sort_order`,
      [estimateId],
    );
    expect(lines.map((l) => l.description)).toEqual(['50-gallon heater', 'Disposal fee']);
  });

  it('the MARKED proposal, once a human approves it, still voids the acceptance (RV-042)', async () => {
    const estimateId = await seedAcceptedEstimate();
    const drafted = await draft(estimateId);
    const result = await execute(drafted);

    expect(result.success).toBe(true);
    const after = await acceptanceRow(estimateId);
    expect(after.status).toBe('sent');
    expect(after.accepted_signature_data).toBeNull();
    const { rows: audits } = await pool.query(
      `SELECT 1 FROM audit_events
        WHERE tenant_id = $1 AND entity_id = $2 AND event_type = 'estimate.acceptance_invalidated'`,
      [tenant.tenantId, estimateId],
    );
    expect(audits).toHaveLength(1);
  });
});

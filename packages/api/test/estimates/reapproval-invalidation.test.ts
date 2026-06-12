/**
 * RV-042 — re-approval invalidation hardening.
 *
 * Requirement: an ACCEPTED estimate that is then updated via the
 * `update_estimate` machinery must return to a non-accepted, RE-SENDABLE
 * state with the prior acceptance recorded.
 *
 * Finding (pinned below): the pre-RV-042 machinery hard-locked accepted
 * estimates (`assertEstimateEditable` → ConflictError "Clone it"), so the
 * required behavior was MISSING — the proposal execution simply failed and
 * the stale acceptance stayed in place. The minimal correction lives in the
 * estimates service: `updateEstimate` gains an explicit
 * `invalidateAcceptance` mutation option that (a) clears the acceptance
 * fields, (b) returns the estimate to 'sent' (re-sendable: token preserved,
 * reminder budget reset, lastRevisedAt stamped so the stale-accept version
 * guard engages), and (c) records the prior acceptance in an
 * `estimate.acceptance_invalidated` audit event. The default path (no flag)
 * keeps the pre-existing hard lock, so the authenticated edit route is
 * unchanged.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  Estimate,
  InMemoryEstimateRepository,
  updateEstimate,
  transitionEstimateStatus,
  reviseEstimate,
} from '../../src/estimates/estimate';
import { applyEstimateEdits } from '../../src/estimates/estimate-editor';
import { UpdateEstimateExecutionHandler } from '../../src/proposals/execution/update-estimate-handler';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { ConflictError } from '../../src/shared/errors';
import { buildLineItem, calculateDocumentTotals, LineItem } from '../../src/shared/billing-engine';
import type { Proposal } from '../../src/proposals/proposal';

const TENANT = 't-1';
const ESTIMATE_ID = 'e1d4c1aa-0000-4000-8000-000000000001';
const ACCEPTED_AT = new Date('2026-06-01T15:00:00Z');

function makeAcceptedEstimate(overrides: Partial<Estimate> = {}): Estimate {
  const lineItems: LineItem[] = [
    buildLineItem('li-1', 'Replace heater', 1, 120000, 0, true, 'labor'),
  ];
  return {
    id: ESTIMATE_ID,
    tenantId: TENANT,
    jobId: 'job-1',
    estimateNumber: 'EST-0007',
    status: 'accepted',
    lineItems,
    totals: calculateDocumentTotals(lineItems, 0, 0),
    viewToken: 'tok-123',
    viewTokenExpiresAt: new Date('2026-09-01T00:00:00Z'),
    sentAt: new Date('2026-05-28T12:00:00Z'),
    acceptedAt: ACCEPTED_AT,
    acceptedByName: 'Jane Henderson',
    acceptedByIp: '203.0.113.9',
    acceptedUserAgent: 'Safari',
    acceptedSignatureData: 'data:image/png;base64,abc',
    acceptedSelection: ['li-1'],
    version: 3,
    reminderCount: 1,
    lastReminderAt: new Date('2026-05-30T12:00:00Z'),
    createdBy: 'u-1',
    createdAt: new Date('2026-05-27T00:00:00Z'),
    updatedAt: ACCEPTED_AT,
    ...overrides,
  };
}

describe('RV-042 — pre-existing lock behavior (pinned, unchanged by default)', () => {
  let repo: InMemoryEstimateRepository;

  beforeEach(async () => {
    repo = new InMemoryEstimateRepository();
    await repo.create(makeAcceptedEstimate());
  });

  it('updateEstimate WITHOUT invalidateAcceptance still refuses an accepted estimate', async () => {
    await expect(
      updateEstimate(TENANT, ESTIMATE_ID, { customerMessage: 'tweak' }, repo),
    ).rejects.toThrow(ConflictError);
    const unchanged = await repo.findById(TENANT, ESTIMATE_ID);
    expect(unchanged!.status).toBe('accepted');
    expect(unchanged!.acceptedAt).toEqual(ACCEPTED_AT);
  });

  it('applyEstimateEdits without allowAccepted still refuses an accepted estimate', () => {
    expect(() =>
      applyEstimateEdits(makeAcceptedEstimate(), [
        { type: 'update_line_item', index: 0, lineItem: { description: 'Replace heater', quantity: 1, unitPrice: 110000 } },
      ]),
    ).toThrow(ConflictError);
  });
});

describe('RV-042 — acceptance invalidation via updateEstimate', () => {
  let repo: InMemoryEstimateRepository;
  let auditRepo: InMemoryAuditRepository;

  beforeEach(async () => {
    repo = new InMemoryEstimateRepository();
    auditRepo = new InMemoryAuditRepository();
    await repo.create(makeAcceptedEstimate());
  });

  it('returns the estimate to a non-accepted, re-sendable state', async () => {
    const updated = await updateEstimate(
      TENANT,
      ESTIMATE_ID,
      { customerMessage: 'Updated scope' },
      repo,
      { auditRepo, actorId: 'owner-1', actorRole: 'owner', invalidateAcceptance: true },
    );

    expect(updated).not.toBeNull();
    expect(updated!.status).toBe('sent'); // re-sendable, link preserved
    expect(updated!.viewToken).toBe('tok-123');
    expect(updated!.version).toBe(4); // stale-accept guard engages
    expect(updated!.acceptedAt == null).toBe(true);
    expect(updated!.acceptedByName == null).toBe(true);
    expect(updated!.acceptedByIp == null).toBe(true);
    expect(updated!.acceptedUserAgent == null).toBe(true);
    expect(updated!.acceptedSignatureData == null).toBe(true);
    expect(updated!.acceptedSelection == null).toBe(true);
    // Reminder machinery re-engages for the changed content.
    expect(updated!.reminderCount).toBe(0);
    expect(updated!.lastRevisedAt).toBeInstanceOf(Date);
  });

  it('records the prior acceptance in the audit trail', async () => {
    await updateEstimate(
      TENANT,
      ESTIMATE_ID,
      { customerMessage: 'Updated scope' },
      repo,
      { auditRepo, actorId: 'owner-1', actorRole: 'owner', invalidateAcceptance: true },
    );

    const events = auditRepo.getAll();
    const invalidated = events.find((e) => e.eventType === 'estimate.acceptance_invalidated');
    expect(invalidated).toBeDefined();
    expect(invalidated!.entityId).toBe(ESTIMATE_ID);
    expect(invalidated!.metadata).toMatchObject({
      estimateNumber: 'EST-0007',
      priorAcceptedAt: ACCEPTED_AT.toISOString(),
      priorAcceptedByName: 'Jane Henderson',
      priorVersion: 3,
    });
  });

  it('keeps the deposit lock: a paid deposit still refuses even with the flag', async () => {
    await expect(
      updateEstimate(
        TENANT,
        ESTIMATE_ID,
        { customerMessage: 'tweak' },
        repo,
        { invalidateAcceptance: true, depositPaidCents: 50000 },
      ),
    ).rejects.toThrow(ConflictError);
    const unchanged = await repo.findById(TENANT, ESTIMATE_ID);
    expect(unchanged!.status).toBe('accepted');
  });

  it('the invalidated estimate can be re-accepted (sent → accepted is legal again)', async () => {
    await updateEstimate(TENANT, ESTIMATE_ID, { customerMessage: 'v2' }, repo, {
      invalidateAcceptance: true,
    });
    const reAccepted = await transitionEstimateStatus(TENANT, ESTIMATE_ID, 'accepted', repo);
    expect(reAccepted!.status).toBe('accepted');
  });

  it('the invalidated estimate can be revised (revise requires sent)', async () => {
    await updateEstimate(TENANT, ESTIMATE_ID, { customerMessage: 'v2' }, repo, {
      invalidateAcceptance: true,
    });
    const revised = await reviseEstimate(
      TENANT,
      ESTIMATE_ID,
      { customerMessage: 'v3' },
      repo,
    );
    expect(revised!.status).toBe('sent');
    expect(revised!.version).toBe(5);
  });
});

describe('RV-042 — update_estimate proposal machinery end-to-end', () => {
  it('an approved update_estimate against an ACCEPTED estimate succeeds and invalidates acceptance', async () => {
    const repo = new InMemoryEstimateRepository();
    const auditRepo = new InMemoryAuditRepository();
    await repo.create(makeAcceptedEstimate());
    // Deposit-lock wiring: a zero-deposit job lets the invalidation proceed.
    const jobRepo = {
      findById: async () => ({ id: 'job-1', tenantId: TENANT, depositPaidCents: 0 }),
    } as unknown as import('../../src/jobs/job').JobRepository;
    const handler = new UpdateEstimateExecutionHandler(
      repo,
      auditRepo,
      undefined,
      undefined,
      jobRepo,
    );

    const proposal: Proposal = {
      id: 'prop-42',
      tenantId: TENANT,
      proposalType: 'update_estimate',
      status: 'approved',
      payload: {
        estimateId: ESTIMATE_ID,
        editActions: [
          {
            type: 'update_line_item',
            index: 0,
            lineItem: { description: 'Replace heater (revised)', quantity: 1, unitPrice: 110000 },
          },
        ],
      },
      summary: 'Revise accepted estimate',
      createdBy: 'u-1',
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await handler.execute(proposal, { tenantId: TENANT, executedBy: 'owner-1' });
    expect(result.success).toBe(true);

    const after = await repo.findById(TENANT, ESTIMATE_ID);
    expect(after!.status).toBe('sent');
    expect(after!.acceptedAt == null).toBe(true);
    expect(after!.lineItems[0].description).toBe('Replace heater (revised)');
    expect(after!.totals.totalCents).toBe(110000);
    expect(after!.version).toBe(4);

    const invalidated = auditRepo
      .getAll()
      .find((e) => e.eventType === 'estimate.acceptance_invalidated');
    expect(invalidated).toBeDefined();
    expect(invalidated!.metadata).toMatchObject({
      priorAcceptedByName: 'Jane Henderson',
      priorVersion: 3,
    });
  });
});

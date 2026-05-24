import {
  createEstimate,
  updateEstimate,
  reviseEstimate,
  transitionEstimateStatus,
  InMemoryEstimateRepository,
} from '../../src/estimates/estimate';
import { buildLineItem } from '../../src/shared/billing-engine';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { ConflictError, ValidationError } from '../../src/shared/errors';

const items = [
  buildLineItem('item-1', 'AC Repair Labor', 2, 7500, 1, true, 'labor'),
  buildLineItem('item-2', 'Compressor Part', 1, 15000, 2, true, 'material'),
];

async function seed(repo: InMemoryEstimateRepository) {
  return createEstimate(
    { tenantId: 't1', jobId: 'j1', estimateNumber: 'EST-1', lineItems: items, createdBy: 'u1' },
    repo,
  );
}

describe('estimate versioning + optimistic locking', () => {
  let repo: InMemoryEstimateRepository;
  beforeEach(() => { repo = new InMemoryEstimateRepository(); });

  it('starts at version 1 and increments on edit', async () => {
    const est = await seed(repo);
    expect(est.version).toBe(1);
    const updated = await updateEstimate('t1', est.id, { discountCents: 500 }, repo);
    expect(updated?.version).toBe(2);
  });

  it('rejects a stale edit when expectedVersion no longer matches', async () => {
    const est = await seed(repo);
    await updateEstimate('t1', est.id, { discountCents: 500 }, repo); // -> v2
    await expect(
      updateEstimate('t1', est.id, { discountCents: 700, expectedVersion: 1 }, repo),
    ).rejects.toThrow(ConflictError);
  });

  it('allows an edit when expectedVersion matches', async () => {
    const est = await seed(repo);
    const updated = await updateEstimate('t1', est.id, { discountCents: 500, expectedVersion: 1 }, repo);
    expect(updated?.version).toBe(2);
  });
});

describe('estimate locking', () => {
  let repo: InMemoryEstimateRepository;
  beforeEach(() => { repo = new InMemoryEstimateRepository(); });

  it('locks edits once the customer has accepted/signed', async () => {
    const est = await seed(repo);
    await transitionEstimateStatus('t1', est.id, 'sent', repo);
    await transitionEstimateStatus('t1', est.id, 'accepted', repo);
    await expect(updateEstimate('t1', est.id, { discountCents: 1 }, repo)).rejects.toThrow(ConflictError);
    await expect(reviseEstimate('t1', est.id, { discountCents: 1 }, repo)).rejects.toThrow();
  });

  it('locks edits when a deposit has been paid on the linked job', async () => {
    const est = await seed(repo);
    await transitionEstimateStatus('t1', est.id, 'sent', repo);
    await expect(
      reviseEstimate('t1', est.id, { discountCents: 1 }, repo, { depositPaidCents: 5000 }),
    ).rejects.toThrow(/deposit/i);
  });
});

describe('reviseEstimate (sent estimates)', () => {
  let repo: InMemoryEstimateRepository;
  let auditRepo: InMemoryAuditRepository;
  beforeEach(() => {
    repo = new InMemoryEstimateRepository();
    auditRepo = new InMemoryAuditRepository();
  });

  it('revises a sent estimate, bumps version, stamps lastRevisedAt, keeps it sent', async () => {
    const est = await seed(repo);
    await transitionEstimateStatus('t1', est.id, 'sent', repo);
    const revised = await reviseEstimate('t1', est.id, { discountCents: 1000 }, repo, { auditRepo });
    expect(revised?.status).toBe('sent');
    expect(revised?.version).toBe(2);
    expect(revised?.lastRevisedAt).toBeInstanceOf(Date);
    expect(revised?.totals.discountCents).toBe(1000);
    const events = await auditRepo.findByEntity('t1', 'estimate', est.id);
    expect(events.some((e) => e.eventType === 'estimate.revised')).toBe(true);
  });

  it('refuses to revise an estimate that has not been sent', async () => {
    const est = await seed(repo);
    await expect(reviseEstimate('t1', est.id, { discountCents: 1 }, repo)).rejects.toThrow(ValidationError);
  });

  it('resets the reminder budget so the worker re-notifies about the revision', async () => {
    const est = await seed(repo);
    await transitionEstimateStatus('t1', est.id, 'sent', repo);
    await repo.update('t1', est.id, { reminderCount: 1, lastReminderAt: new Date() });

    const revised = await reviseEstimate('t1', est.id, { discountCents: 1000 }, repo);
    expect(revised?.reminderCount).toBe(0);
  });
});

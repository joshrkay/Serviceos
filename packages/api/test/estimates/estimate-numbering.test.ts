import {
  transitionEstimateStatus,
  isValidEstimateTransition,
  InMemoryEstimateRepository,
  createEstimate,
} from '../../src/estimates/estimate';
import { buildLineItem } from '../../src/shared/billing-engine';
import {
  createSettings,
  getNextEstimateNumber,
  InMemorySettingsRepository,
} from '../../src/settings/settings';

describe('P1-010 — Estimate numbering + statuses', () => {
  let estimateRepo: InMemoryEstimateRepository;
  let settingsRepo: InMemorySettingsRepository;

  const sampleItems = [buildLineItem('1', 'Service', 1, 10000, 1, true)];

  beforeEach(async () => {
    estimateRepo = new InMemoryEstimateRepository();
    settingsRepo = new InMemorySettingsRepository();
    await createSettings({ tenantId: 'tenant-1', businessName: 'ACME' }, settingsRepo);
  });

  it('happy path — generates sequential estimate numbers', async () => {
    const num1 = await getNextEstimateNumber('tenant-1', settingsRepo);
    const num2 = await getNextEstimateNumber('tenant-1', settingsRepo);

    expect(num1).toBe('EST-0001');
    expect(num2).toBe('EST-0002');
  });

  it('happy path — transitions draft to sent', async () => {
    const estimate = await createEstimate(
      { tenantId: 'tenant-1', jobId: 'j-1', estimateNumber: 'EST-0001', lineItems: sampleItems, createdBy: 'u-1' },
      estimateRepo
    );

    const sent = await transitionEstimateStatus('tenant-1', estimate.id, 'sent', estimateRepo);
    expect(sent!.status).toBe('sent');
  });

  it('happy path — full lifecycle: draft → ready_for_review → sent → accepted', async () => {
    const est = await createEstimate(
      { tenantId: 'tenant-1', jobId: 'j-1', estimateNumber: 'EST-0001', lineItems: sampleItems, createdBy: 'u-1' },
      estimateRepo
    );

    await transitionEstimateStatus('tenant-1', est.id, 'ready_for_review', estimateRepo);
    await transitionEstimateStatus('tenant-1', est.id, 'sent', estimateRepo);
    const accepted = await transitionEstimateStatus('tenant-1', est.id, 'accepted', estimateRepo);
    expect(accepted!.status).toBe('accepted');
  });

  it('happy path — rejected estimate can return to draft', async () => {
    const est = await createEstimate(
      { tenantId: 'tenant-1', jobId: 'j-1', estimateNumber: 'EST-0001', lineItems: sampleItems, createdBy: 'u-1' },
      estimateRepo
    );

    await transitionEstimateStatus('tenant-1', est.id, 'sent', estimateRepo);
    await transitionEstimateStatus('tenant-1', est.id, 'rejected', estimateRepo);
    const revised = await transitionEstimateStatus('tenant-1', est.id, 'draft', estimateRepo);
    expect(revised!.status).toBe('draft');
  });

  it('validation — rejects invalid status transition', async () => {
    const est = await createEstimate(
      { tenantId: 'tenant-1', jobId: 'j-1', estimateNumber: 'EST-0001', lineItems: sampleItems, createdBy: 'u-1' },
      estimateRepo
    );

    await expect(
      transitionEstimateStatus('tenant-1', est.id, 'accepted', estimateRepo)
    ).rejects.toThrow('Invalid transition from draft to accepted');
  });

  it('validation — accepted is terminal', () => {
    expect(isValidEstimateTransition('accepted', 'draft')).toBe(false);
    expect(isValidEstimateTransition('accepted', 'sent')).toBe(false);
  });

  it('tenant isolation — numbers are tenant-scoped', async () => {
    await createSettings({ tenantId: 'tenant-2', businessName: 'Beta' }, settingsRepo);

    const t1num = await getNextEstimateNumber('tenant-1', settingsRepo);
    const t2num = await getNextEstimateNumber('tenant-2', settingsRepo);

    expect(t1num).toBe('EST-0001');
    expect(t2num).toBe('EST-0001'); // Each tenant starts at 1
  });
});

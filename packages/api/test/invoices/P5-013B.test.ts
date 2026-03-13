import {
  captureTimeToCashMilestone,
  InMemoryTimeToCashEventRepository,
  TimeToCashMilestone,
  VALID_MILESTONES,
} from '../../src/invoices/analytics';

describe('P5-013B: Capture time-to-cash milestones', () => {
  let repo: InMemoryTimeToCashEventRepository;
  const tenantId = 'tenant-1';
  const jobId = 'job-001';

  beforeEach(() => {
    repo = new InMemoryTimeToCashEventRepository();
  });

  describe('Happy path: captures milestone with timestamp', () => {
    it('should capture a milestone event with correct fields', async () => {
      const before = new Date();
      const event = await captureTimeToCashMilestone(tenantId, jobId, 'inv-001', 'invoice_approved', repo);
      const after = new Date();

      expect(event.id).toBeDefined();
      expect(event.tenantId).toBe(tenantId);
      expect(event.jobId).toBe(jobId);
      expect(event.invoiceId).toBe('inv-001');
      expect(event.milestone).toBe('invoice_approved');
      expect(event.occurredAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(event.occurredAt.getTime()).toBeLessThanOrEqual(after.getTime());
      expect(event.createdAt).toBeInstanceOf(Date);
    });

    it('should persist the event in the repository', async () => {
      await captureTimeToCashMilestone(tenantId, jobId, 'inv-001', 'first_payment', repo);

      const events = await repo.findByJob(tenantId, jobId);
      expect(events).toHaveLength(1);
      expect(events[0].milestone).toBe('first_payment');
    });
  });

  describe('All milestone types captured', () => {
    it.each(VALID_MILESTONES)('should capture milestone: %s', async (milestone) => {
      const event = await captureTimeToCashMilestone(tenantId, jobId, 'inv-001', milestone, repo);

      expect(event.milestone).toBe(milestone);
      expect(event.tenantId).toBe(tenantId);
      expect(event.jobId).toBe(jobId);
    });
  });

  describe('Links to invoice when provided', () => {
    it('should include invoiceId when provided', async () => {
      const event = await captureTimeToCashMilestone(tenantId, jobId, 'inv-099', 'invoice_drafted', repo);

      expect(event.invoiceId).toBe('inv-099');
    });

    it('should allow undefined invoiceId for early milestones', async () => {
      const event = await captureTimeToCashMilestone(tenantId, jobId, undefined, 'job_completed', repo);

      expect(event.invoiceId).toBeUndefined();
    });

    it('should find events by invoice when invoiceId is set', async () => {
      await captureTimeToCashMilestone(tenantId, jobId, 'inv-050', 'invoice_issued', repo);
      await captureTimeToCashMilestone(tenantId, jobId, undefined, 'job_completed', repo);

      const invoiceEvents = await repo.findByInvoice(tenantId, 'inv-050');
      expect(invoiceEvents).toHaveLength(1);
      expect(invoiceEvents[0].milestone).toBe('invoice_issued');
    });
  });

  describe('Validation: required fields', () => {
    it('should create event with all required fields populated', async () => {
      const event = await captureTimeToCashMilestone(tenantId, jobId, 'inv-001', 'fully_paid', repo);

      expect(event.id).toBeTruthy();
      expect(event.tenantId).toBeTruthy();
      expect(event.jobId).toBeTruthy();
      expect(event.milestone).toBeTruthy();
      expect(event.occurredAt).toBeInstanceOf(Date);
      expect(event.createdAt).toBeInstanceOf(Date);
    });

    it('should generate unique IDs for each milestone event', async () => {
      const event1 = await captureTimeToCashMilestone(tenantId, jobId, 'inv-001', 'invoice_drafted', repo);
      const event2 = await captureTimeToCashMilestone(tenantId, jobId, 'inv-001', 'invoice_approved', repo);

      expect(event1.id).not.toBe(event2.id);
    });
  });
});

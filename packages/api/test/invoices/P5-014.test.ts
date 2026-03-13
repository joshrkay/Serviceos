import {
  detectInvoiceOpportunity,
  validateOpportunityInput,
  TechnicianJobUpdate,
  JobContext,
} from '../../src/invoices/invoice-opportunity';

describe('P5-014: Technician update to invoice opportunity signal', () => {
  const baseUpdate: TechnicianJobUpdate = {
    updateType: 'general_note',
    content: 'Replaced filter and checked system',
    timestamp: new Date(),
  };

  const completedJobContext: JobContext = {
    jobId: 'job-001',
    tenantId: 'tenant-1',
    status: 'completed',
    hasExistingDraftInvoice: false,
    completedAt: new Date(),
  };

  describe('Happy path: completed job with no invoice', () => {
    it('should signal shouldDraft=true when job is completed and no invoice exists', () => {
      const signal = detectInvoiceOpportunity(baseUpdate, completedJobContext);

      expect(signal.shouldDraft).toBe(true);
      expect(signal.reason).toContain('completed');
      expect(signal.confidence).toBeGreaterThan(0);
      expect(signal.confidence).toBeLessThanOrEqual(1);
    });
  });

  describe('Happy path: work_completed update on non-completed job triggers draft', () => {
    it('should signal shouldDraft=true for work_completed update type', () => {
      const update: TechnicianJobUpdate = {
        ...baseUpdate,
        updateType: 'work_completed',
      };
      const context: JobContext = {
        ...completedJobContext,
        status: 'in_progress',
      };

      const signal = detectInvoiceOpportunity(update, context);

      expect(signal.shouldDraft).toBe(true);
      expect(signal.reason).toContain('completion');
      expect(signal.confidence).toBeGreaterThan(0);
    });

    it('should signal shouldDraft=true for job_completed update type', () => {
      const update: TechnicianJobUpdate = {
        ...baseUpdate,
        updateType: 'job_completed',
      };
      const context: JobContext = {
        ...completedJobContext,
        status: 'in_progress',
      };

      const signal = detectInvoiceOpportunity(update, context);
      expect(signal.shouldDraft).toBe(true);
    });

    it('should signal shouldDraft=true for final_update update type', () => {
      const update: TechnicianJobUpdate = {
        ...baseUpdate,
        updateType: 'final_update',
      };
      const context: JobContext = {
        ...completedJobContext,
        status: 'in_progress',
      };

      const signal = detectInvoiceOpportunity(update, context);
      expect(signal.shouldDraft).toBe(true);
    });
  });

  describe('Existing draft invoice: shouldDraft=false', () => {
    it('should not draft when a draft invoice already exists', () => {
      const context: JobContext = {
        ...completedJobContext,
        hasExistingDraftInvoice: true,
      };

      const signal = detectInvoiceOpportunity(baseUpdate, context);

      expect(signal.shouldDraft).toBe(false);
      expect(signal.reason).toContain('already exists');
    });
  });

  describe('Non-completed job without completion signal: shouldDraft=false', () => {
    it('should not draft for a non-completed job with a general update', () => {
      const context: JobContext = {
        ...completedJobContext,
        status: 'in_progress',
      };

      const signal = detectInvoiceOpportunity(baseUpdate, context);

      expect(signal.shouldDraft).toBe(false);
      expect(signal.reason).toContain('not yet completed');
    });
  });

  describe('Validation: required fields validated', () => {
    it('should report missing updateType', () => {
      const errors = validateOpportunityInput(
        { ...baseUpdate, updateType: '' },
        completedJobContext
      );
      expect(errors).toContain('updateType is required');
    });

    it('should report missing content', () => {
      const errors = validateOpportunityInput(
        { ...baseUpdate, content: '' },
        completedJobContext
      );
      expect(errors).toContain('content is required');
    });

    it('should report missing jobId', () => {
      const errors = validateOpportunityInput(baseUpdate, {
        ...completedJobContext,
        jobId: '',
      });
      expect(errors).toContain('jobId is required');
    });

    it('should report missing job status', () => {
      const errors = validateOpportunityInput(baseUpdate, {
        ...completedJobContext,
        status: '',
      });
      expect(errors).toContain('job status is required');
    });

    it('should return no errors for valid input', () => {
      const errors = validateOpportunityInput(baseUpdate, completedJobContext);
      expect(errors).toHaveLength(0);
    });
  });

  describe('Tenant isolation: tenantId required in context', () => {
    it('should report missing tenantId in validation', () => {
      const errors = validateOpportunityInput(baseUpdate, {
        ...completedJobContext,
        tenantId: '',
      });
      expect(errors).toContain('tenantId is required');
    });
  });

  describe('Confidence scores are reasonable (0-1)', () => {
    it('should return confidence between 0 and 1 for completed job', () => {
      const signal = detectInvoiceOpportunity(baseUpdate, completedJobContext);
      expect(signal.confidence).toBeGreaterThanOrEqual(0);
      expect(signal.confidence).toBeLessThanOrEqual(1);
    });

    it('should return confidence between 0 and 1 for existing draft', () => {
      const signal = detectInvoiceOpportunity(baseUpdate, {
        ...completedJobContext,
        hasExistingDraftInvoice: true,
      });
      expect(signal.confidence).toBeGreaterThanOrEqual(0);
      expect(signal.confidence).toBeLessThanOrEqual(1);
    });

    it('should return confidence between 0 and 1 for non-completed job', () => {
      const signal = detectInvoiceOpportunity(baseUpdate, {
        ...completedJobContext,
        status: 'in_progress',
      });
      expect(signal.confidence).toBeGreaterThanOrEqual(0);
      expect(signal.confidence).toBeLessThanOrEqual(1);
    });

    it('should return confidence between 0 and 1 for completion signal', () => {
      const signal = detectInvoiceOpportunity(
        { ...baseUpdate, updateType: 'work_completed' },
        { ...completedJobContext, status: 'in_progress' }
      );
      expect(signal.confidence).toBeGreaterThanOrEqual(0);
      expect(signal.confidence).toBeLessThanOrEqual(1);
    });
  });
});

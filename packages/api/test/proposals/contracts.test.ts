import { v4 as uuidv4 } from 'uuid';
import {
  validateProposalPayload,
  assertValidProposalPayload,
  PROPOSAL_TYPE_SCHEMAS,
  createCustomerPayloadSchema,
  createJobPayloadSchema,
  createAppointmentPayloadSchema,
  draftEstimatePayloadSchema,
  updateCustomerPayloadSchema,
  updateEstimatePayloadSchema,
} from '../../src/proposals/contracts';
import { ValidationError } from '../../src/shared/errors';

describe('P2-002 — Typed proposal contracts', () => {
  const validCustomerId = uuidv4();
  const validJobId = uuidv4();
  const validEstimateId = uuidv4();
  const validTechnicianId = uuidv4();

  it('happy path — validates create_customer payload', () => {
    const result = validateProposalPayload('create_customer', {
      name: 'John Doe',
      email: 'john@example.com',
      phone: '555-1234',
      address: '123 Main St',
      notes: 'New customer from call',
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toBeUndefined();
  });

  it('happy path — validates create_job payload', () => {
    const result = validateProposalPayload('create_job', {
      customerId: validCustomerId,
      title: 'Fix leaky faucet',
      description: 'Kitchen faucet dripping',
      scheduledDate: '2026-04-01',
      priority: 'high',
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toBeUndefined();
  });

  it('happy path — validates create_appointment payload', () => {
    const result = validateProposalPayload('create_appointment', {
      jobId: validJobId,
      scheduledStart: '2026-04-01T09:00:00Z',
      scheduledEnd: '2026-04-01T11:00:00Z',
      technicianId: validTechnicianId,
      notes: 'Bring extra parts',
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toBeUndefined();
  });

  it('happy path — validates draft_estimate payload', () => {
    const result = validateProposalPayload('draft_estimate', {
      customerId: validCustomerId,
      jobId: validJobId,
      lineItems: [
        { description: 'Labor', quantity: 2, unitPrice: 75, category: 'service' },
        { description: 'Parts', quantity: 1, unitPrice: 45.99 },
      ],
      notes: 'Estimate for plumbing repair',
      validUntil: '2026-05-01',
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toBeUndefined();
  });

  it('happy path — validates update_customer payload', () => {
    const result = validateProposalPayload('update_customer', {
      customerId: validCustomerId,
      phone: '555-9999',
      notes: 'Updated phone number',
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toBeUndefined();
  });

  it('happy path — validates update_estimate payload with editActions', () => {
    const result = validateProposalPayload('update_estimate', {
      estimateId: validEstimateId,
      editActions: [
        {
          type: 'add_line_item',
          lineItem: { description: 'Revised labor', quantity: 3, unitPrice: 75 },
        },
      ],
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toBeUndefined();
  });

  it('validation — rejects invalid create_customer payload', () => {
    const result = validateProposalPayload('create_customer', {
      email: 'not-an-email',
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toBeDefined();
    expect(result.errors!.length).toBeGreaterThan(0);
  });

  it('validation — rejects create_job missing required fields', () => {
    const result = validateProposalPayload('create_job', {
      description: 'No customer or title',
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toBeDefined();
    expect(result.errors!.some((e) => e.includes('customerId'))).toBe(true);
    expect(result.errors!.some((e) => e.includes('title'))).toBe(true);
  });

  it('validation — rejects draft_estimate with empty line items', () => {
    const result = validateProposalPayload('draft_estimate', {
      customerId: validCustomerId,
      lineItems: [],
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toBeDefined();
    expect(result.errors!.some((e) => e.includes('lineItems'))).toBe(true);
  });

  it('validation — rejects unknown proposal type', () => {
    const result = validateProposalPayload('unknown_type', { foo: 'bar' });
    expect(result.valid).toBe(false);
    expect(result.errors).toBeDefined();
    expect(result.errors![0]).toContain('Unknown proposal type');
  });

  it('malformed AI output handled gracefully — assertValidProposalPayload throws ValidationError with structured Zod paths', () => {
    // Simulates the LLM emitting a `create_customer` proposal with an
    // empty name and a bogus email. The AI-safety gate that production
    // task handlers MUST call before persisting is `assertValidProposalPayload`;
    // this test pins its failure surface so callers can rely on the
    // typed error + `details.errors` payload.
    let thrown: unknown;
    try {
      assertValidProposalPayload('create_customer', {
        name: '',
        email: 'not-an-email',
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ValidationError);
    const err = thrown as ValidationError;
    expect(err.code).toBe('VALIDATION_ERROR');
    expect(err.statusCode).toBe(400);
    expect(err.message).toContain("create_customer");
    const errors = (err.details?.errors ?? []) as string[];
    expect(errors.some((e) => e.startsWith('name:'))).toBe(true);
    expect(errors.some((e) => e.startsWith('email:'))).toBe(true);
  });

  it('malformed AI output handled gracefully — assertValidProposalPayload throws on unknown proposal type', () => {
    expect(() =>
      assertValidProposalPayload('not_a_real_type', { foo: 'bar' })
    ).toThrow(ValidationError);
  });

  it('happy path — assertValidProposalPayload returns void on valid payload', () => {
    expect(() =>
      assertValidProposalPayload('create_customer', {
        name: 'Jane Doe',
        email: 'jane@example.com',
      })
    ).not.toThrow();
  });

  // on_my_way (voice ETA notice)
  describe('on_my_way payload', () => {
    it('accepts a resolved appointmentId + etaMinutes', () => {
      expect(validateProposalPayload('on_my_way', { appointmentId: validJobId, etaMinutes: 15 }).valid).toBe(true);
    });
    it('accepts a free-text appointmentReference (pre-resolution)', () => {
      expect(validateProposalPayload('on_my_way', { appointmentReference: 'Miller' }).valid).toBe(true);
    });
    it('rejects neither appointmentId nor appointmentReference', () => {
      expect(validateProposalPayload('on_my_way', { etaMinutes: 15 }).valid).toBe(false);
    });
  });

  // clock_out (voice time tracking)
  describe('clock_out payload', () => {
    it('accepts an empty payload (active entry resolved at execution by userId)', () => {
      expect(validateProposalPayload('clock_out', {}).valid).toBe(true);
    });
    it('accepts an optional note', () => {
      expect(validateProposalPayload('clock_out', { notes: 'done early' }).valid).toBe(true);
    });
  });

  // Job execution by voice (update_job_status)
  describe('update_job_status payload (job execution by voice)', () => {
    it('accepts a resolved jobId + targetStatus', () => {
      const r = validateProposalPayload('update_job_status', {
        jobId: validJobId,
        targetStatus: 'completed',
      });
      expect(r.valid).toBe(true);
    });

    it('accepts a free-text jobReference + targetStatus (pre-resolution)', () => {
      const r = validateProposalPayload('update_job_status', {
        jobReference: 'Henderson',
        targetStatus: 'in_progress',
      });
      expect(r.valid).toBe(true);
    });

    it('rejects a payload with neither jobId nor jobReference', () => {
      const r = validateProposalPayload('update_job_status', { targetStatus: 'completed' });
      expect(r.valid).toBe(false);
    });

    it('rejects an out-of-range targetStatus (only start/complete allowed by voice)', () => {
      const r = validateProposalPayload('update_job_status', {
        jobId: validJobId,
        targetStatus: 'canceled',
      });
      expect(r.valid).toBe(false);
    });
  });

  // P22 — line items accept either price field plus catalog annotations.
  describe('line item price fields (P22)', () => {
    const base = { customerId: validCustomerId, jobId: validJobId };

    it('accepts unitPriceCents-only lines (invoice handler output shape)', () => {
      const result = validateProposalPayload('draft_invoice', {
        ...base,
        lineItems: [{ description: 'Labor', quantity: 1, unitPriceCents: 7500 }],
      });
      expect(result.valid).toBe(true);
    });

    it('accepts unitPrice-only lines (estimate handler output shape)', () => {
      const result = validateProposalPayload('draft_estimate', {
        customerId: validCustomerId,
        lineItems: [{ description: 'Labor', quantity: 1, unitPrice: 7500 }],
      });
      expect(result.valid).toBe(true);
    });

    it('rejects lines with NEITHER price field', () => {
      const result = validateProposalPayload('draft_invoice', {
        ...base,
        lineItems: [{ description: 'Labor', quantity: 1 }],
      });
      expect(result.valid).toBe(false);
    });

    it('accepts catalog annotations (catalogItemId + pricingSource)', () => {
      const result = validateProposalPayload('draft_invoice', {
        ...base,
        lineItems: [
          {
            description: 'Water Heater Install',
            quantity: 1,
            unitPriceCents: 185000,
            catalogItemId: uuidv4(),
            pricingSource: 'catalog',
          },
        ],
      });
      expect(result.valid).toBe(true);
    });

    it('rejects an unknown pricingSource', () => {
      const result = validateProposalPayload('draft_invoice', {
        ...base,
        lineItems: [
          { description: 'X', quantity: 1, unitPriceCents: 100, pricingSource: 'vibes' },
        ],
      });
      expect(result.valid).toBe(false);
    });
  });
});

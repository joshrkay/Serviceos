import { v4 as uuidv4 } from 'uuid';
import {
  validateProposalPayload,
  PROPOSAL_TYPE_SCHEMAS,
  createCustomerPayloadSchema,
  createJobPayloadSchema,
  createAppointmentPayloadSchema,
  draftEstimatePayloadSchema,
  updateCustomerPayloadSchema,
  updateEstimatePayloadSchema,
} from '../../src/proposals/contracts';

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

  it('happy path — validates update_estimate payload', () => {
    const result = validateProposalPayload('update_estimate', {
      estimateId: validEstimateId,
      lineItems: [
        { description: 'Revised labor', quantity: 3, unitPrice: 75 },
      ],
      notes: 'Updated estimate',
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
});

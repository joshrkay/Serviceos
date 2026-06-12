import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
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

// ─── RV-007 (F-4): Confidence Marker `_meta` ─────────────────────────────
// `_meta` is an OPTIONAL fragment on EVERY payload, validated once at the
// validateProposalPayload choke point (the per-type schemas are strip-mode
// and ignore it). Old payloads without `_meta` must keep validating.
describe('RV-007 — payload _meta confidence marker', () => {
  const customerPayload = {
    name: 'John Doe',
    email: 'john@example.com',
    phone: '555-1234',
  };

  it('validates a payload carrying a full, valid _meta', () => {
    const result = validateProposalPayload('create_customer', {
      ...customerPayload,
      _meta: {
        overallConfidence: 'high',
        fieldConfidence: { 'lineItems[0].unitPrice': 'low', name: 'medium' },
        markers: [{ path: 'lineItems[0].unitPrice', reason: 'not in catalog' }],
      },
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toBeUndefined();
  });

  it('validates an overall-only _meta (fieldConfidence/markers optional)', () => {
    for (const level of ['high', 'medium', 'low', 'very_low']) {
      const result = validateProposalPayload('create_customer', {
        ...customerPayload,
        _meta: { overallConfidence: level },
      });
      expect(result.valid).toBe(true);
    }
  });

  it('still validates a payload WITHOUT _meta (old proposals unchanged)', () => {
    const result = validateProposalPayload('create_customer', customerPayload);
    expect(result.valid).toBe(true);
    expect(result.errors).toBeUndefined();
  });

  it('rejects an unknown overallConfidence level', () => {
    const result = validateProposalPayload('create_customer', {
      ...customerPayload,
      _meta: { overallConfidence: 'sorta_sure' },
    });
    expect(result.valid).toBe(false);
    expect(result.errors!.some((e) => e.includes('_meta.overallConfidence'))).toBe(true);
  });

  it('rejects _meta missing overallConfidence', () => {
    const result = validateProposalPayload('create_customer', {
      ...customerPayload,
      _meta: { fieldConfidence: { name: 'high' } },
    });
    expect(result.valid).toBe(false);
  });

  it('rejects a bad fieldConfidence level', () => {
    const result = validateProposalPayload('create_customer', {
      ...customerPayload,
      _meta: { overallConfidence: 'high', fieldConfidence: { name: 0.9 } },
    });
    expect(result.valid).toBe(false);
  });

  it('enforces the markers shape (path + reason both required, non-empty)', () => {
    const missingReason = validateProposalPayload('create_customer', {
      ...customerPayload,
      _meta: { overallConfidence: 'medium', markers: [{ path: 'name' }] },
    });
    expect(missingReason.valid).toBe(false);

    const emptyPath = validateProposalPayload('create_customer', {
      ...customerPayload,
      _meta: {
        overallConfidence: 'medium',
        markers: [{ path: '', reason: 'why' }],
      },
    });
    expect(emptyPath.valid).toBe(false);

    const notAnArray = validateProposalPayload('create_customer', {
      ...customerPayload,
      _meta: { overallConfidence: 'medium', markers: { path: 'x', reason: 'y' } },
    });
    expect(notAnArray.valid).toBe(false);
  });

  it('applies to refined (ZodEffects) schemas too — create_appointment', () => {
    const base = {
      jobId: uuidv4(),
      scheduledStart: '2026-04-01T09:00:00Z',
      scheduledEnd: '2026-04-01T11:00:00Z',
    };
    expect(
      validateProposalPayload('create_appointment', {
        ...base,
        _meta: { overallConfidence: 'medium' },
      }).valid,
    ).toBe(true);
    expect(
      validateProposalPayload('create_appointment', {
        ...base,
        _meta: { overallConfidence: 'nope' },
      }).valid,
    ).toBe(false);
  });

  it('assertValidProposalPayload throws on a malformed _meta', () => {
    expect(() =>
      assertValidProposalPayload('create_customer', {
        ...customerPayload,
        _meta: { overallConfidence: 'bogus' },
      }),
    ).toThrow(ValidationError);
  });
});

// ─── ITEM 1: No schema in PROPOSAL_TYPE_SCHEMAS is strict-mode ────────────────
// A future `.strict()` call on any per-type schema would silently break the
// `_meta` passthrough envelope — unknown keys would be rejected before the
// envelope validator even runs. This test pins the invariant so such a
// regression is caught immediately.
describe('PROPOSAL_TYPE_SCHEMAS — no strict-mode schemas', () => {
  it('every schema in PROPOSAL_TYPE_SCHEMAS is strip-mode (never strict)', () => {
    // ZodObject exposes `_def.unknownKeys` which is 'strip' by default and
    // 'strict' when .strict() has been called. ZodEffects (from .refine())
    // wrap an innerType — we unwrap one level if needed.
    const isStrictObject = (schema: import('zod').ZodSchema): boolean => {
      // Unwrap ZodEffects
      let s: import('zod').ZodSchema = schema;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      while ((s as any)._def?.typeName === 'ZodEffects') {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        s = (s as any)._def.schema;
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (s as any)._def?.unknownKeys === 'strict';
    };

    // Positive control — the detector must fire on a known strict schema so
    // a future zod-internals change can't make the test pass vacuously.
    expect(isStrictObject(z.object({}).strict())).toBe(true);

    const strictSchemas: string[] = [];
    for (const [type, schema] of Object.entries(PROPOSAL_TYPE_SCHEMAS)) {
      if (isStrictObject(schema)) {
        strictSchemas.push(type);
      }
    }
    expect(strictSchemas).toEqual([]);
  });
});

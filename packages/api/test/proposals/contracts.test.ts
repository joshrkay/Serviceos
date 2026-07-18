import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import {
  validateProposalPayload,
  assertValidProposalPayload,
  PROPOSAL_TYPE_SCHEMAS,
  createCustomerPayloadSchema,
  createJobPayloadSchema,
  updateJobPayloadSchema,
  createAppointmentPayloadSchema,
  draftEstimatePayloadSchema,
  updateCustomerPayloadSchema,
  updateEstimatePayloadSchema,
  invoiceEditActionSchema,
  estimateEditActionSchema,
  tierStructureIssues,
} from '../../src/proposals/contracts';
import { normalizeTierStructure } from '../../src/ai/resolution/tier-structure';
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

  it('create_appointment — accepts a valid appointmentType, rejects out-of-enum', () => {
    const base = {
      jobId: validJobId,
      scheduledStart: '2026-04-01T09:00:00Z',
      scheduledEnd: '2026-04-01T11:00:00Z',
    };
    // valid enum value rides through
    expect(
      validateProposalPayload('create_appointment', { ...base, appointmentType: 'install' })
        .valid,
    ).toBe(true);
    // optional — absence is still valid
    expect(validateProposalPayload('create_appointment', base).valid).toBe(true);
    // never trust an unconstrained value (urgency is not a type)
    expect(
      validateProposalPayload('create_appointment', { ...base, appointmentType: 'emergency' })
        .valid,
    ).toBe(false);
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

  // B7 (feat: voice-transcript-and-agent-paths) — update_job.
  describe('update_job payload contract', () => {
    it('happy path — status only', () => {
      const result = validateProposalPayload('update_job', {
        jobId: validJobId,
        status: 'in_progress',
      });
      expect(result.valid).toBe(true);
      expect(result.errors).toBeUndefined();
    });

    it('happy path — every editable field together', () => {
      const result = validateProposalPayload('update_job', {
        jobId: validJobId,
        jobReference: 'JOB-0001',
        status: 'completed',
        priority: 'urgent',
        title: 'Renamed job',
        description: 'Updated notes',
      });
      expect(result.valid).toBe(true);
    });

    it('rejects a payload missing jobId', () => {
      const result = validateProposalPayload('update_job', { status: 'completed' });
      expect(result.valid).toBe(false);
    });

    it('rejects a non-uuid jobId', () => {
      const result = validateProposalPayload('update_job', {
        jobId: 'not-a-uuid',
        status: 'completed',
      });
      expect(result.valid).toBe(false);
    });

    it('rejects a payload with jobId but no editable field (the refine gate)', () => {
      const result = updateJobPayloadSchema.safeParse({ jobId: validJobId });
      expect(result.success).toBe(false);
    });

    it('rejects an invalid status enum value', () => {
      const result = validateProposalPayload('update_job', {
        jobId: validJobId,
        status: 'super_urgent',
      });
      expect(result.valid).toBe(false);
    });

    it('rejects an invalid priority enum value', () => {
      // 'medium' is create_job's (mismatched, pre-existing) priority enum —
      // NOT a valid Job domain priority (low/normal/high/urgent).
      const result = validateProposalPayload('update_job', {
        jobId: validJobId,
        priority: 'medium',
      });
      expect(result.valid).toBe(false);
    });

    it('accepts an empty-string description (clearing the field is allowed)', () => {
      const result = validateProposalPayload('update_job', {
        jobId: validJobId,
        description: '',
      });
      expect(result.valid).toBe(true);
    });

    it('rejects an empty-string title (min length 1 — use description to clear, not title)', () => {
      const result = validateProposalPayload('update_job', {
        jobId: validJobId,
        title: '',
      });
      expect(result.valid).toBe(false);
    });
  });

  // P1 fix — remove_line_item/update_line_item must accept EITHER a
  // numeric index OR a free-text description (the edit-task LLM prompt
  // emits description-only actions; see
  // ai/tasks/invoice-edit-task.ts / estimate-edit-task.ts), but reject a
  // payload that carries neither — the exact shape that used to reach
  // the editor as `action.index === undefined` and silently corrupt the
  // first line item.
  describe('invoiceEditActionSchema / estimateEditActionSchema — index-or-description', () => {
    it('invoice: index-only remove_line_item is valid', () => {
      expect(invoiceEditActionSchema.safeParse({ type: 'remove_line_item', index: 0 }).success).toBe(
        true,
      );
    });

    it('invoice: description-only remove_line_item is valid', () => {
      expect(
        invoiceEditActionSchema.safeParse({ type: 'remove_line_item', description: 'gasket' }).success,
      ).toBe(true);
    });

    it('invoice: remove_line_item with neither index nor description is invalid', () => {
      expect(invoiceEditActionSchema.safeParse({ type: 'remove_line_item' }).success).toBe(false);
    });

    it('invoice: update_line_item with neither index nor description is invalid', () => {
      expect(
        invoiceEditActionSchema.safeParse({
          type: 'update_line_item',
          lineItem: { description: 'Gasket', quantity: 1, unitPrice: 450 },
        }).success,
      ).toBe(false);
    });

    it('invoice: update_line_item with description (no index) is valid', () => {
      expect(
        invoiceEditActionSchema.safeParse({
          type: 'update_line_item',
          description: 'gasket',
          lineItem: { description: 'Gasket', quantity: 1, unitPrice: 450 },
        }).success,
      ).toBe(true);
    });

    it('estimate: index-only remove_line_item is valid', () => {
      expect(
        estimateEditActionSchema.safeParse({ type: 'remove_line_item', index: 0 }).success,
      ).toBe(true);
    });

    it('estimate: description-only remove_line_item is valid', () => {
      expect(
        estimateEditActionSchema.safeParse({ type: 'remove_line_item', description: 'disposal fee' })
          .success,
      ).toBe(true);
    });

    it('estimate: remove_line_item with neither index nor description is invalid', () => {
      expect(estimateEditActionSchema.safeParse({ type: 'remove_line_item' }).success).toBe(false);
    });

    it('estimate: update_line_item with neither index nor description is invalid', () => {
      expect(
        estimateEditActionSchema.safeParse({
          type: 'update_line_item',
          lineItem: { description: 'Tankless heater', quantity: 1, unitPrice: 145000 },
        }).success,
      ).toBe(false);
    });

    it('add_line_item never requires index or description', () => {
      expect(
        invoiceEditActionSchema.safeParse({
          type: 'add_line_item',
          lineItem: { description: 'Trip fee', quantity: 1, unitPrice: 7500 },
        }).success,
      ).toBe(true);
      expect(
        estimateEditActionSchema.safeParse({
          type: 'add_line_item',
          lineItem: { description: 'Trip fee', quantity: 1, unitPrice: 7500 },
        }).success,
      ).toBe(true);
    });

    it('update_estimate payload with a description-based remove_line_item validates end to end', () => {
      const result = validateProposalPayload('update_estimate', {
        estimateId: validEstimateId,
        editActions: [{ type: 'remove_line_item', description: 'disposal fee' }],
      });
      expect(result.valid).toBe(true);
      expect(result.errors).toBeUndefined();
    });
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

  it('happy path — validates send_payment_reminder payload', () => {
    const result = validateProposalPayload('send_payment_reminder', {
      invoiceId: uuidv4(),
      stepKey: '3:sms',
      offsetDays: 3,
      channel: 'sms',
    });
    expect(result.valid).toBe(true);
  });

  it('validation — rejects send_payment_reminder with non-uuid invoice / bad channel', () => {
    const result = validateProposalPayload('send_payment_reminder', {
      invoiceId: 'not-a-uuid',
      stepKey: '3:sms',
      offsetDays: 3,
      channel: 'carrier-pigeon',
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toBeDefined();
    expect(result.errors!.length).toBeGreaterThan(0);
  });

  it('happy path — validates apply_late_fee payload (integer cents)', () => {
    const result = validateProposalPayload('apply_late_fee', {
      invoiceId: uuidv4(),
      feeCents: 2500,
      stepKey: 'initial',
    });
    expect(result.valid).toBe(true);
  });

  it('validation — rejects apply_late_fee with non-positive or fractional fee (money discipline)', () => {
    const zero = validateProposalPayload('apply_late_fee', {
      invoiceId: uuidv4(),
      feeCents: 0,
      stepKey: 'initial',
    });
    expect(zero.valid).toBe(false);

    const fractional = validateProposalPayload('apply_late_fee', {
      invoiceId: uuidv4(),
      feeCents: 25.5,
      stepKey: 'initial',
    });
    expect(fractional.valid).toBe(false);
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

// ─── voice_clarification reasons ─────────────────────────────────────────────
describe('voice_clarification reason enum', () => {
  it('accepts each existing reason', () => {
    for (const reason of [
      'unknown_intent',
      'low_confidence',
      'parse_failed',
      'missing_entities',
      'ambiguous_entity',
    ]) {
      const result = validateProposalPayload('voice_clarification', {
        transcript: 'I heard something',
        reason,
      });
      expect(result.valid).toBe(true);
    }
  });

  it('accepts the P2-036 V2 ambiguous_discount_target reason', () => {
    const result = validateProposalPayload('voice_clarification', {
      transcript: 'can you knock some off',
      reason: 'ambiguous_discount_target',
    });
    expect(result.valid).toBe(true);
  });

  it('rejects an unknown reason', () => {
    const result = validateProposalPayload('voice_clarification', {
      transcript: 'hello',
      reason: 'not_a_real_reason',
    });
    expect(result.valid).toBe(false);
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

describe('EE-1 — good-better-best tier structure', () => {
  const customerId = uuidv4();

  function draft(lineItems: Array<Record<string, unknown>>) {
    return { customerId, lineItems };
  }

  describe('tierStructureIssues', () => {
    it('accepts a flat payload (no groups) as valid', () => {
      expect(tierStructureIssues([{ description: 'Labor' }, { description: 'Parts' }])).toEqual([]);
    });

    it('accepts a well-formed tier group (>=2 options, exactly one default)', () => {
      expect(
        tierStructureIssues([
          { groupKey: 'wh', isOptional: true, isDefaultSelected: true },
          { groupKey: 'wh', isOptional: true, isDefaultSelected: false },
        ]),
      ).toEqual([]);
    });

    it('flags a singleton group', () => {
      const issues = tierStructureIssues([{ groupKey: 'solo', isOptional: true, isDefaultSelected: true }]);
      expect(issues).toHaveLength(1);
      expect(issues[0]).toMatch(/only one option/);
    });

    it('flags a group with two defaults', () => {
      const issues = tierStructureIssues([
        { groupKey: 'g', isOptional: true, isDefaultSelected: true },
        { groupKey: 'g', isOptional: true, isDefaultSelected: true },
      ]);
      expect(issues).toHaveLength(1);
      expect(issues[0]).toMatch(/exactly one default/);
    });

    it('flags a group with zero defaults', () => {
      const issues = tierStructureIssues([
        { groupKey: 'g', isOptional: true },
        { groupKey: 'g', isOptional: true },
      ]);
      expect(issues[0]).toMatch(/exactly one default/);
    });

    it('flags isDefaultSelected on an always-billed line', () => {
      const issues = tierStructureIssues([{ description: 'Labor', isDefaultSelected: true }]);
      expect(issues).toHaveLength(1);
      expect(issues[0]).toMatch(/neither a tier option nor an optional add-on/);
    });

    it('allows a pre-checked optional add-on (isDefaultSelected on isOptional line)', () => {
      expect(tierStructureIssues([{ description: 'Membership', isOptional: true, isDefaultSelected: true }])).toEqual([]);
    });
  });

  describe('draftEstimatePayloadSchema refine', () => {
    it('accepts a valid tiered draft via validateProposalPayload', () => {
      const result = validateProposalPayload(
        'draft_estimate',
        draft([
          { description: 'Builder heater', quantity: 1, unitPrice: 90000, groupKey: 'wh', isOptional: true, isDefaultSelected: true },
          { description: 'Premium heater', quantity: 1, unitPrice: 140000, groupKey: 'wh', isOptional: true },
        ]),
      );
      expect(result.valid).toBe(true);
    });

    it('rejects a malformed tiered draft (two defaults)', () => {
      const result = validateProposalPayload(
        'draft_estimate',
        draft([
          { description: 'A', quantity: 1, unitPrice: 100, groupKey: 'g', isOptional: true, isDefaultSelected: true },
          { description: 'B', quantity: 1, unitPrice: 200, groupKey: 'g', isOptional: true, isDefaultSelected: true },
        ]),
      );
      expect(result.valid).toBe(false);
    });

    it('leaves the flat draft path valid (backstop is inert without groups)', () => {
      const result = validateProposalPayload(
        'draft_estimate',
        draft([{ description: 'Labor', quantity: 2, unitPrice: 7500 }]),
      );
      expect(result.valid).toBe(true);
    });
  });

  it('agreement — normalizeTierStructure output always passes tierStructureIssues', () => {
    // A deliberately malformed draft: a group with no default + extra default,
    // a singleton group, and a pre-checked add-on with no request.
    const messy: Array<Record<string, unknown>> = [
      { description: 'Good', quantity: 1, unitPrice: 100, groupKey: 'g' },
      { description: 'Better', quantity: 1, unitPrice: 200, groupKey: 'g', isDefaultSelected: true },
      { description: 'Best', quantity: 1, unitPrice: 300, groupKey: 'g', isDefaultSelected: true },
      { description: 'Solo', quantity: 1, unitPrice: 50, groupKey: 'solo' },
      { description: 'Add-on', quantity: 1, unitPrice: 25, isOptional: true, isDefaultSelected: true },
    ];
    const normalized = normalizeTierStructure(messy);
    expect(tierStructureIssues(normalized)).toEqual([]);
  });
});

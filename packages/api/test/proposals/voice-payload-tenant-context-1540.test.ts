/**
 * #1540 §6 (owner decision 2026-10-01) — the live-turn payload builder is
 * handed the tenant zone and the clock, so the fields the memo/chat task
 * handlers fill from tenant context are filled the same way on the phone and
 * in-app voice legs instead of gating every draft:
 *   - log_expense.spentAt → the tenant-local today (LogExpenseTaskHandler);
 *   - create_service_agreement.recurrenceRule / startsOn →
 *     CreateServiceAgreementTaskHandler's cadence table and start date.
 * Without a tenant zone nothing is guessed — the field stays a named gate.
 */
import { describe, it, expect } from 'vitest';
import { buildVoiceProposalPayload } from '../../src/proposals/voice-payload';

const LA = 'America/Los_Angeles';

function expenseInput(entities: Record<string, unknown>) {
  return {
    intent: 'log_expense',
    proposalType: 'log_expense' as const,
    entities,
    envelope: { sessionId: 'sess-1540' },
  };
}

describe('#1540 §6 — log_expense.spentAt from the tenant zone + clock', () => {
  it('stamps the TENANT-LOCAL today: 05:00Z May 1 is still April 30 in Los Angeles', async () => {
    const built = await buildVoiceProposalPayload(
      expenseInput({ expenseDescription: 'fuel', amountCents: 6000, category: 'fuel' }),
      {
        tenantId: 't-1540',
        timezone: LA,
        now: () => new Date('2026-05-01T05:00:00.000Z'),
      },
    );
    // Midnight April 30 PDT (UTC-7) as a UTC instant.
    expect(built.payload.spentAt).toBe('2026-04-30T07:00:00.000Z');
    expect(built.missingFieldPaths).not.toContain('spentAt');
  });
});

function agreementInput(entities: Record<string, unknown>) {
  return {
    intent: 'create_service_agreement',
    proposalType: 'create_service_agreement' as const,
    entities,
    envelope: { sessionId: 'sess-1540' },
    callerCustomerId: '11111111-1111-4111-8111-111111111111',
  };
}

describe('#1540 §6 — create_service_agreement cadence and start date', () => {
  // Far enough ahead that the contract's "not in the past" refine (which
  // reads the wall clock) holds whenever this suite runs.
  const NOW = () => new Date('2030-05-01T12:00:00.000Z');
  const deps = { tenantId: 't-1540', timezone: LA, now: NOW };

  it('turns the spoken cadence into the recurrence rule the engine reads (quarterly → every 3 months)', async () => {
    const built = await buildVoiceProposalPayload(
      agreementInput({ name: 'HVAC tune-up plan', priceCents: 15000, serviceAgreementCadence: 'quarterly' }),
      deps,
    );
    expect(built.payload.recurrenceRule).toBe('FREQ=MONTHLY;INTERVAL=3');
    expect(built.missingFieldPaths).not.toContain('recurrenceRule');
  });

  it('starts on the first of next month (tenant calendar) when no start date was said', async () => {
    const built = await buildVoiceProposalPayload(
      agreementInput({ name: 'HVAC tune-up plan', priceCents: 15000, serviceAgreementCadence: 'quarterly' }),
      deps,
    );
    expect(built.payload.startsOn).toBe('2030-06-01');
    expect(built.ok).toBe(true);
    expect(built.missingFieldPaths).toEqual([]);
  });

  it('honours a spoken start date ("June 15")', async () => {
    const built = await buildVoiceProposalPayload(
      agreementInput({
        name: 'HVAC tune-up plan',
        priceCents: 15000,
        serviceAgreementCadence: 'annual',
        serviceAgreementStartsOn: 'June 15',
      }),
      deps,
    );
    expect(built.payload.startsOn).toBe('2030-06-15');
  });

  it('without a tenant zone the start date is not guessed — it stays a named gate', async () => {
    const built = await buildVoiceProposalPayload(
      agreementInput({ name: 'HVAC tune-up plan', priceCents: 15000, serviceAgreementCadence: 'quarterly' }),
      { tenantId: 't-1540', now: NOW },
    );
    expect(built.payload.startsOn).toBeUndefined();
    expect(built.missingFieldPaths).toContain('startsOn');
  });
});

describe('#1540 §6 — tenant context never invents a record id', () => {
  it('"the Henderson invoice" with no resolved invoice stays gated on invoiceId (the honest answer)', async () => {
    const built = await buildVoiceProposalPayload(
      {
        intent: 'apply_credit',
        proposalType: 'apply_credit' as const,
        entities: { jobReference: 'the Henderson invoice', amountCents: 5000 },
        envelope: { sessionId: 'sess-1540' },
      },
      { tenantId: 't-1540', timezone: LA, now: () => new Date('2026-05-01T12:00:00.000Z') },
    );
    expect(built.payload.invoiceId).toBeUndefined();
    expect(built.missingFieldPaths).toContain('invoiceId');
  });
});

describe('#1540 §6 — create_change_order title and grounded line', () => {
  const JOB_ID = '22222222-2222-4222-8222-222222222222';
  const changeOrder = (entities: Record<string, unknown>) => ({
    intent: 'create_change_order',
    proposalType: 'create_change_order' as const,
    entities,
    envelope: { sessionId: 'sess-1540' },
  });

  it('drafts the spoken scope + price as ONE line handed to the injected catalog grounding, titled like the task handler', async () => {
    const seen: unknown[] = [];
    const built = await buildVoiceProposalPayload(
      changeOrder({ jobId: JOB_ID, changeOrderDescription: 'add second zone', amount: 180000 }),
      {
        tenantId: 't-1540',
        groundPricedLineItems: async (lines) => {
          seen.push(lines);
          return {
            lineItems: lines.map((l) => ({ ...l, pricingSource: 'uncatalogued', needsPricing: true })),
            meta: { overallConfidence: 'low' },
          };
        },
      },
    );
    expect(seen).toEqual([[{ description: 'add second zone', quantity: 1, unitPriceCents: 180000 }]]);
    expect(built.payload.title).toBe('Change order — add second zone');
    expect(built.payload.lineItems).toEqual([
      { description: 'add second zone', quantity: 1, unitPriceCents: 180000, pricingSource: 'uncatalogued', needsPricing: true },
    ]);
    expect(built.ok).toBe(true);
    expect(built.missingFieldPaths).toEqual([]);
  });

  it('with no job resolved the draft stays gated on jobId — never guessed', async () => {
    const built = await buildVoiceProposalPayload(
      changeOrder({ jobReference: 'the Garcias', changeOrderDescription: 'add second zone', amount: 180000 }),
      {
        tenantId: 't-1540',
        groundPricedLineItems: async (lines) => ({ lineItems: lines.map((l) => ({ ...l })) }),
      },
    );
    expect(built.payload.jobId).toBeUndefined();
    expect(built.missingFieldPaths).toContain('jobId');
  });
});

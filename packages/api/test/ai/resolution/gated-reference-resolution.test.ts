/**
 * #909 — unit pins for the gated-reference resolution core.
 *
 * These cover the PURE half: which gate pairs with which free text, what a
 * resolver outcome does to the proposal, and that the D-004 invariants hold
 * (no status change, ambiguity never guessed, an unknown gate untouched).
 * The SQL these lookups compile to is pinned separately against real
 * Postgres — see test/integration/chat-entity-resolution.test.ts.
 */
import { describe, it, expect, vi } from 'vitest';
import type { EntityResolver, EntityResolverResult } from '../../../src/ai/resolution/entity-resolver';
import {
  planGatedReferenceLookups,
  resolveGatedReferences,
  applyGatedReferences,
  stampPendingAmbiguity,
  pendingAmbiguityOf,
  clearPendingAmbiguity,
  buildDisambiguationQuestion,
  GATED_REFERENCE_SOURCES,
} from '../../../src/ai/resolution/gated-reference-resolution';
import type { Proposal } from '../../../src/proposals/proposal';
import { missingFieldsFor } from '../../../src/proposals/proposal';

type PartialProposal = Pick<Proposal, 'payload' | 'sourceContext'>;

function draft(
  payload: Record<string, unknown>,
  missingFields: string[],
  extraContext: Record<string, unknown> = {},
): PartialProposal {
  return {
    payload,
    sourceContext: { missingFields, ...extraContext },
  } as unknown as PartialProposal;
}

function resolverFor(
  impl: (input: { reference: string; kind: string }) => EntityResolverResult,
): EntityResolver {
  return { resolve: vi.fn(async (input) => impl(input)) } as unknown as EntityResolver;
}

const resolvedAs = (id: string, kind: string, label = 'X'): EntityResolverResult =>
  ({ kind: 'resolved', candidate: { id, kind, label, score: 0.95 } }) as EntityResolverResult;

const TENANT = 'tenant-1';

describe('#909 planGatedReferenceLookups — gate ↔ free-text pairing', () => {
  it('pairs each gated id with the reference field its handler wrote', () => {
    const cases: Array<[string, Record<string, unknown>, string, string]> = [
      ['customerId', { customerReference: 'Priya Shah' }, 'customer', 'Priya Shah'],
      ['leadId', { leadReference: 'the Johnson lead' }, 'lead', 'the Johnson lead'],
      ['invoiceId', { invoiceReference: 'INV-0001' }, 'invoice', 'INV-0001'],
      ['estimateId', { estimateReference: 'EST-0007' }, 'estimate', 'EST-0007'],
      ['jobId', { jobReference: 'QA Sweep Furnace Inspection' }, 'job', 'QA Sweep Furnace Inspection'],
      ['appointmentId', { appointmentReference: "tomorrow's 3pm" }, 'appointment', "tomorrow's 3pm"],
      ['technicianId', { targetTechnicianName: 'Alex Rivera' }, 'technician', 'Alex Rivera'],
      ['toTechnicianId', { targetTechnicianName: 'Tom Baker' }, 'technician', 'Tom Baker'],
    ];

    for (const [idField, payload, kind, reference] of cases) {
      const plan = planGatedReferenceLookups(draft(payload, [idField]));
      expect(plan, `${idField} should plan a lookup`).toHaveLength(1);
      expect(plan[0]).toEqual({ idField, kind, reference });
    }
  });

  it('falls back to the classifier entities when the payload carries no reference', () => {
    // add_crew_member writes appointmentReference only when the classifier
    // emitted one; the customer name is still a usable appointment reference
    // (PgEntityResolver resolves a named reference through the customer's jobs).
    const plan = planGatedReferenceLookups(draft({}, ['appointmentId']), {
      customerName: 'qa-matrix-A-customer',
    });
    expect(plan).toEqual([
      { idField: 'appointmentId', kind: 'appointment', reference: 'qa-matrix-A-customer' },
    ]);
  });

  it('prefers an explicit payload reference over the entity fallback', () => {
    const plan = planGatedReferenceLookups(
      draft({ appointmentReference: "tomorrow's 3pm" }, ['appointmentId']),
      { customerName: 'qa-matrix-A-customer' },
    );
    expect(plan[0].reference).toBe("tomorrow's 3pm");
  });

  it('leaves gates it does not know how to resolve strictly alone', () => {
    const plan = planGatedReferenceLookups(
      draft({ appointmentReference: 'x' }, [
        'newScheduledStart',
        'recurrenceRule',
        'lineItems[0].catalogItemId',
        'appointmentId',
      ]),
    );
    expect(plan.map((l) => l.idField)).toEqual(['appointmentId']);
  });

  it('plans nothing when the gated id is already filled', () => {
    const plan = planGatedReferenceLookups(
      draft({ customerId: 'abc', customerReference: 'Priya' }, ['customerId']),
    );
    expect(plan).toEqual([]);
  });

  it('plans nothing when there is no free text to resolve from', () => {
    expect(planGatedReferenceLookups(draft({}, ['leadId']))).toEqual([]);
  });

  it('every source entry names a payload field and at least one entity fallback', () => {
    for (const [idField, source] of Object.entries(GATED_REFERENCE_SOURCES)) {
      expect(source.payloadFields.length, idField).toBeGreaterThan(0);
      expect(source.entityFields.length, idField).toBeGreaterThan(0);
    }
  });
});

describe('#909 resolveGatedReferences — outcomes', () => {
  it('fills every unambiguously resolved gate', async () => {
    const resolver = resolverFor(({ kind }) =>
      kind === 'appointment' ? resolvedAs('appt-1', 'appointment') : resolvedAs('tech-1', 'technician'),
    );
    const proposal = draft(
      { appointmentReference: "tomorrow's 3pm", targetTechnicianName: 'Tom Baker' },
      ['appointmentId', 'toTechnicianId'],
    );

    const outcome = await resolveGatedReferences(resolver, TENANT, proposal);

    expect(outcome.filled).toEqual({ appointmentId: 'appt-1', toTechnicianId: 'tech-1' });
    expect(outcome.ambiguity).toBeUndefined();
    expect(outcome.unresolved).toEqual([]);
  });

  it('turns an ambiguous reference into ONE question and never a guess', async () => {
    const resolver = resolverFor(() => ({
      kind: 'ambiguous',
      candidates: [
        { id: 'c1', kind: 'customer', label: 'Bob Smith', hint: '555-0100', score: 0.9 },
        { id: 'c2', kind: 'customer', label: 'Bob Stone', hint: '555-0200', score: 0.88 },
      ],
    }) as EntityResolverResult);

    const outcome = await resolveGatedReferences(
      resolver,
      TENANT,
      draft({ customerReference: 'Bob' }, ['customerId']),
    );

    expect(outcome.filled).toEqual({});
    expect(outcome.unresolved).toEqual(['customerId']);
    expect(outcome.ambiguity).toMatchObject({
      entityKind: 'customer',
      refKey: 'customerId',
      reference: 'Bob',
      attemptCount: 0,
    });
    // label → name, so the voice surface's follow-up matcher can consume it.
    expect(outcome.ambiguity?.candidates.map((c) => c.name)).toEqual(['Bob Smith', 'Bob Stone']);
  });

  it('asks about only the FIRST ambiguity even when two references are ambiguous', async () => {
    const resolver = resolverFor(({ kind }) => ({
      kind: 'ambiguous',
      candidates: [
        { id: `${kind}-1`, kind, label: 'One', score: 0.9 },
        { id: `${kind}-2`, kind, label: 'Two', score: 0.9 },
      ],
    }) as EntityResolverResult);

    const outcome = await resolveGatedReferences(
      resolver,
      TENANT,
      draft({ appointmentReference: 'a', targetTechnicianName: 'b' }, [
        'appointmentId',
        'technicianId',
      ]),
    );

    expect(outcome.ambiguity?.refKey).toBe('appointmentId');
    expect(outcome.unresolved).toEqual(['appointmentId', 'technicianId']);
    expect(outcome.filled).toEqual({});
  });

  it('never auto-adopts a low_confidence candidate', async () => {
    const resolver = resolverFor(() => ({
      kind: 'low_confidence',
      candidate: { id: 'maybe', kind: 'customer', label: 'Bobby', score: 0.7 },
    }) as EntityResolverResult);

    const outcome = await resolveGatedReferences(
      resolver,
      TENANT,
      draft({ customerReference: 'Bob' }, ['customerId']),
    );

    expect(outcome.filled).toEqual({});
    expect(outcome.unresolved).toEqual(['customerId']);
    expect(outcome.ambiguity).toBeUndefined();
  });

  it('degrades to "gate stays" when the resolver throws, without losing sibling lookups', async () => {
    const resolver = {
      resolve: vi.fn(async (input: { kind: string }) => {
        if (input.kind === 'appointment') throw new Error('pg down');
        return resolvedAs('tech-1', 'technician');
      }),
    } as unknown as EntityResolver;

    const outcome = await resolveGatedReferences(
      resolver,
      TENANT,
      draft({ appointmentReference: 'x', targetTechnicianName: 'Tom' }, [
        'appointmentId',
        'technicianId',
      ]),
    );

    expect(outcome.unresolved).toEqual(['appointmentId']);
    expect(outcome.filled).toEqual({ technicianId: 'tech-1' });
  });

  it('is a no-op without a resolver wired', async () => {
    const outcome = await resolveGatedReferences(
      undefined,
      TENANT,
      draft({ customerReference: 'Bob' }, ['customerId']),
    );
    expect(outcome).toEqual({ filled: {}, unresolved: [] });
  });

  it('anchors a later appointment lookup on a job resolved earlier in the same pass', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const resolver = {
      resolve: vi.fn(async (input: Record<string, unknown>) => {
        seen.push(input);
        return resolvedAs(`${input.kind}-1`, String(input.kind));
      }),
    } as unknown as EntityResolver;

    await resolveGatedReferences(
      resolver,
      TENANT,
      draft({ jobReference: 'Furnace', appointmentReference: 'that job' }, [
        'jobId',
        'appointmentId',
      ]),
    );

    const appointmentCall = seen.find((s) => s.kind === 'appointment');
    expect(appointmentCall?.jobId).toBe('job-1');
  });
});

describe('#909 applyGatedReferences — fill, lift, mark verified', () => {
  it('writes the id, lifts ONLY that gate, and records it as DB-verified', () => {
    const proposal = draft(
      { leadReference: 'the Johnson lead' },
      ['leadId', 'someOtherGate'],
    );

    const applied = applyGatedReferences(proposal, { leadId: 'lead-uuid' });

    expect(applied).toEqual(['leadId']);
    expect((proposal.payload as Record<string, unknown>).leadId).toBe('lead-uuid');
    expect(missingFieldsFor(proposal as Proposal)).toEqual(['someOtherGate']);
    expect((proposal.sourceContext as Record<string, unknown>).verifiedIds).toEqual({
      leadId: 'lead-uuid',
    });
  });

  it('keeps the free-text reference on the payload for the review card', () => {
    const proposal = draft({ leadReference: 'the Johnson lead' }, ['leadId']);
    applyGatedReferences(proposal, { leadId: 'lead-uuid' });
    expect((proposal.payload as Record<string, unknown>).leadReference).toBe('the Johnson lead');
  });

  it('merges into verifiedIds a handler already stamped', () => {
    const proposal = draft({ customerReference: 'Priya' }, ['customerId'], {
      verifiedIds: { invoiceId: 'inv-1' },
    });
    applyGatedReferences(proposal, { customerId: 'cust-1' });
    expect((proposal.sourceContext as Record<string, unknown>).verifiedIds).toEqual({
      invoiceId: 'inv-1',
      customerId: 'cust-1',
    });
  });

  it('does nothing at all when nothing resolved', () => {
    const proposal = draft({ customerReference: 'Bob' }, ['customerId']);
    const before = JSON.stringify(proposal);
    expect(applyGatedReferences(proposal, {})).toEqual([]);
    expect(JSON.stringify(proposal)).toBe(before);
  });

  it('D-004: filling a gate never touches proposal status', () => {
    const proposal = {
      status: 'ready_for_review',
      payload: { leadReference: 'Johnson' },
      sourceContext: { missingFields: ['leadId'] },
    } as unknown as Proposal;
    applyGatedReferences(proposal, { leadId: 'lead-1' });
    expect(proposal.status).toBe('ready_for_review');
  });
});

describe('#909 pending-ambiguity round trip on sourceContext', () => {
  const pending = {
    entityKind: 'customer' as const,
    reference: 'Bob',
    refKey: 'customerId',
    candidates: [
      { id: 'c1', name: 'Bob Smith', score: 0.9 },
      { id: 'c2', name: 'Bob Stone', score: 0.9 },
    ],
    partialRefs: {},
    attemptCount: 1,
  };

  it('stamps and reads back through a JSON round trip (as the DB stores it)', () => {
    const proposal = draft({}, ['customerId']);
    stampPendingAmbiguity(proposal, pending);
    const rehydrated = JSON.parse(JSON.stringify(proposal)) as PartialProposal;
    expect(pendingAmbiguityOf(rehydrated)).toEqual(pending);
  });

  it('does not disturb the missingFields gate it rides alongside', () => {
    const proposal = draft({}, ['customerId']);
    stampPendingAmbiguity(proposal, pending);
    expect(missingFieldsFor(proposal as Proposal)).toEqual(['customerId']);
  });

  it('clears cleanly', () => {
    const proposal = draft({}, ['customerId']);
    stampPendingAmbiguity(proposal, pending);
    clearPendingAmbiguity(proposal);
    expect(pendingAmbiguityOf(proposal)).toBeUndefined();
    expect(missingFieldsFor(proposal as Proposal)).toEqual(['customerId']);
  });

  it('rejects a malformed or empty pending blob rather than trusting it', () => {
    expect(pendingAmbiguityOf(draft({}, []))).toBeUndefined();
    expect(
      pendingAmbiguityOf(draft({}, [], { pendingEntityAmbiguity: { refKey: 'customerId' } })),
    ).toBeUndefined();
    expect(
      pendingAmbiguityOf(
        draft({}, [], {
          pendingEntityAmbiguity: { ...pending, candidates: [] },
        }),
      ),
    ).toBeUndefined();
  });
});

describe('#909 buildDisambiguationQuestion — ONE question', () => {
  it('numbers the options so an ordinal answer is meaningful', () => {
    const q = buildDisambiguationQuestion({
      entityKind: 'lead',
      reference: 'the Johnson lead',
      refKey: 'leadId',
      candidates: [
        { id: 'l1', name: 'Dana Johnson', score: 0.9, hint: 'qualified' },
        { id: 'l2', name: 'Marcus Johnson', score: 0.9, hint: 'new' },
      ],
      partialRefs: {},
      attemptCount: 0,
    });
    expect(q).toContain('Which lead did you mean by "the Johnson lead"?');
    expect(q).toContain('1. Dana Johnson (qualified)');
    expect(q).toContain('2. Marcus Johnson (new)');
    expect(q).toContain('Reply with the number or the name.');
  });

  it('caps the list at three options', () => {
    const q = buildDisambiguationQuestion({
      entityKind: 'customer',
      reference: 'Smith',
      refKey: 'customerId',
      candidates: [1, 2, 3, 4, 5].map((n) => ({ id: `c${n}`, name: `Smith ${n}`, score: 0.9 })),
      partialRefs: {},
      attemptCount: 0,
    });
    expect(q).toContain('3. Smith 3');
    expect(q).not.toContain('4. Smith 4');
  });

  it('asks for a distinguishing detail when every candidate has the same name', () => {
    const q = buildDisambiguationQuestion({
      entityKind: 'customer',
      reference: 'Bob Smith',
      refKey: 'customerId',
      candidates: [
        { id: 'c1', name: 'Bob Smith', score: 0.9 },
        { id: 'c2', name: 'Bob Smith', score: 0.9 },
      ],
      partialRefs: {},
      attemptCount: 0,
    });
    expect(q).toContain('all under the same name');
    expect(q).toMatch(/address or phone/i);
  });
});

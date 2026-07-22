import { describe, it, expect, vi } from 'vitest';
import {
  parseNaturalDatetime,
  planVoiceEntityLookups,
  resolveSchedulingEntities,
  resolveVoiceEntityReferences,
} from '../../../../src/ai/agents/customer-calling/entity-resolution';
import type { EntityResolver, EntityResolverResult } from '../../../../src/ai/resolution/entity-resolver';

// VOX-52 regression (PR #665 review): the resolver rewrite must still carry the
// classifier's free-text fields (reason, assigneeName, noteText, …) into refs —
// only the identity keys (customerId/jobId/appointmentId) are the resolver's
// authority and are never copied raw from the classifier.
describe('resolveSchedulingEntities — carries free-text classifier fields into refs', () => {
  it('preserves non-identity string entities, drops raw identity keys', async () => {
    const res = await resolveSchedulingEntities(undefined, 'tenant-1', 'reassign_appointment', {
      assigneeName: 'Maria',
      reason: 'customer requested a different tech',
      noteText: 'gate code is 1234',
      customerId: 'not-a-uuid-should-not-leak',
    });
    expect(res.status).toBe('resolved');
    expect(res.refs.assigneeName).toBe('Maria');
    expect(res.refs.reason).toBe('customer requested a different tech');
    expect(res.refs.noteText).toBe('gate code is 1234');
    // Identity keys are never trusted raw from the classifier.
    expect(res.refs.customerId).toBeUndefined();
  });

  it('does not overwrite a classifier-provided cancellation reason with the default', async () => {
    const res = await resolveSchedulingEntities(undefined, 'tenant-1', 'cancel_appointment', {
      reason: 'rescheduling to next week',
    });
    expect(res.refs.reason).toBe('rescheduling to next week');
  });
});

// QA-2026-06-05 (SCH-02/03) — deterministic NL datetime parsing for the
// calling agent's entity resolution. Fixed "now" so weekday math is stable.
describe('parseNaturalDatetime', () => {
  const now = new Date('2026-06-05T12:00:00Z'); // a Friday

  it('parses "next Tuesday at 2 PM"', () => {
    const w = parseNaturalDatetime('next Tuesday at 2 PM', now)!;
    const start = new Date(w.scheduledStart);
    expect(start.getUTCDay()).toBe(2); // Tuesday
    expect(start.getUTCHours()).toBe(14);
    expect(start.getTime()).toBeGreaterThan(now.getTime());
    expect(new Date(w.scheduledEnd).getTime() - start.getTime()).toBe(60 * 60_000);
  });

  it('parses "tomorrow at 9:30 am"', () => {
    const w = parseNaturalDatetime('tomorrow at 9:30 am', now)!;
    const start = new Date(w.scheduledStart);
    expect(start.getUTCDate()).toBe(6);
    expect(start.getUTCHours()).toBe(9);
    expect(start.getUTCMinutes()).toBe(30);
  });

  it('bare weekday means the NEXT occurrence (never today)', () => {
    const w = parseNaturalDatetime('friday at 1 pm', now)!;
    const start = new Date(w.scheduledStart);
    expect(start.getUTCDay()).toBe(5);
    expect(start.getUTCDate()).toBe(12); // a week out, not today
  });

  it('time-only gets a future slot', () => {
    const w = parseNaturalDatetime('at 8 am', now)!;
    expect(new Date(w.scheduledStart).getTime()).toBeGreaterThan(now.getTime());
  });

  it('day-only defaults to a morning slot', () => {
    const w = parseNaturalDatetime('next monday', now)!;
    const start = new Date(w.scheduledStart);
    expect(start.getUTCDay()).toBe(1);
    expect(start.getUTCHours()).toBe(9);
  });

  it('returns undefined for unparseable text (never guesses)', () => {
    expect(parseNaturalDatetime('whenever works for you', now)).toBeUndefined();
    expect(parseNaturalDatetime('at 27 pm', now)).toBeUndefined();
  });

  it('12 am / 12 pm edge cases', () => {
    const noon = parseNaturalDatetime('tomorrow at 12 pm', now)!;
    expect(new Date(noon.scheduledStart).getUTCHours()).toBe(12);
    const midnight = parseNaturalDatetime('tomorrow at 12 am', now)!;
    expect(new Date(midnight.scheduledStart).getUTCHours()).toBe(0);
  });
});

describe('planVoiceEntityLookups — intent-conditioned operator references', () => {
  it('routes INV-0042 jobReference to invoice lookup for update_invoice', () => {
    const lookups = planVoiceEntityLookups('update_invoice', { jobReference: 'INV-0042' });
    expect(lookups).toEqual([
      { kind: 'invoice', reference: 'INV-0042', refKey: 'invoiceId' },
    ]);
  });

  it('routes EST-0042 jobReference to estimate lookup for update_estimate', () => {
    const lookups = planVoiceEntityLookups('update_estimate', { jobReference: 'EST-0042' });
    expect(lookups).toEqual([
      { kind: 'estimate', reference: 'EST-0042', refKey: 'estimateId' },
    ]);
  });

  it('resolves Khan customer name for lookup_customer', () => {
    const lookups = planVoiceEntityLookups('lookup_customer', { customerName: 'Khan' });
    expect(lookups).toEqual([
      { kind: 'customer', reference: 'Khan', refKey: 'customerId' },
    ]);
  });

  it('resolves Garcia Tuesday appointment reference for reschedule_appointment', () => {
    const lookups = planVoiceEntityLookups('reschedule_appointment', {
      appointmentReference: 'Tuesday',
    });
    expect(lookups).toEqual([
      { kind: 'appointment', reference: 'Tuesday', refKey: 'appointmentId' },
    ]);
  });

  it('resolves Carlos technician name for reassign_appointment', () => {
    const lookups = planVoiceEntityLookups('reassign_appointment', {
      targetTechnicianName: 'Carlos',
    });
    expect(lookups).toEqual([
      { kind: 'technician', reference: 'Carlos', refKey: 'technicianId' },
    ]);
  });

  it('create_customer never pre-resolves a customer name', () => {
    const lookups = planVoiceEntityLookups('create_customer', {
      customerName: 'New Person',
      displayName: 'New Person',
    });
    expect(lookups).toEqual([]);
  });
});

describe('resolveVoiceEntityReferences — router annotation folding', () => {
  const TID = 'tenant-voice';

  function resolverWith(results: Record<string, EntityResolverResult>): EntityResolver {
    return {
      resolve: vi.fn(async (input) => {
        const key = `${input.kind}:${input.reference}`;
        return results[key] ?? { kind: 'not_found', reference: input.reference };
      }),
    };
  }

  it('unique invoice match stamps invoiceId on the annotation', async () => {
    const resolver = resolverWith({
      'invoice:INV-0042': {
        kind: 'resolved',
        candidate: { id: 'inv-42', kind: 'invoice', label: 'INV-0042', score: 1 },
      },
    });
    const result = await resolveVoiceEntityReferences(resolver, {
      tenantId: TID,
      intent: 'update_invoice',
      entities: { jobReference: 'INV-0042' },
    });
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.resolved.invoiceId).toBe('inv-42');
      expect(result.pendingReferences).toEqual([]);
    }
  });

  it('two Smith-like customer matches → ambiguous clarification', async () => {
    const resolver = resolverWith({
      'customer:Smith': {
        kind: 'ambiguous',
        candidates: [
          { id: 'smith-a', kind: 'customer', label: 'John Smith', score: 0.9 },
          { id: 'smith-b', kind: 'customer', label: 'Jane Smith', score: 0.88 },
        ],
      },
    });
    const result = await resolveVoiceEntityReferences(resolver, {
      tenantId: TID,
      intent: 'create_invoice',
      entities: { customerName: 'Smith' },
    });
    expect(result.kind).toBe('ambiguous');
    if (result.kind === 'ambiguous') {
      expect(result.entityKind).toBe('customer');
      expect(result.candidates).toHaveLength(2);
    }
  });

  it('unknown customer becomes pendingReference instead of blocking', async () => {
    const resolver = resolverWith({});
    const result = await resolveVoiceEntityReferences(resolver, {
      tenantId: TID,
      intent: 'create_invoice',
      entities: { customerName: 'Ghost Customer' },
    });
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.resolved.customerId).toBeUndefined();
      expect(result.pendingReferences).toEqual([
        { kind: 'customer', reference: 'Ghost Customer' },
      ]);
    }
  });
});

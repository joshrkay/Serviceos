/**
 * #1331 (Layer 2 run 36925905917) — an owner names a household the way people
 * do out loud: "the Garcias want a second zone — change order for 1800",
 * "refund the Smiths 100 dollars in cash". The customer is "Maria Garcia" /
 * "John Smith"; no resolver matches the PLURAL family form ("garcias" is not
 * the word "garcia"), so the job / invoice the request is about stayed
 * unresolved and a fully specified request was drafted as "still needs a few
 * details".
 *
 * Seam: `resolveSchedulingEntities` (the live-turn resolution both voice legs
 * run) with a resolver that — like PgEntityResolver and the fixture resolver —
 * matches the SINGULAR surname only. The resolver keeps its one / several /
 * none contract; nothing here picks a record on its own.
 */
import { describe, it, expect } from 'vitest';
import { resolveSchedulingEntities } from '../../../../src/ai/agents/customer-calling/entity-resolution';
import type {
  EntityResolver,
  EntityResolverResult,
} from '../../../../src/ai/resolution/entity-resolver';

const TENANT = 't-1331-family';
const GARCIA = '00000000-0000-4000-8000-000013310001';
const GARCIA_JOB = '00000000-0000-4000-8000-000013310002';
const SMITH_INVOICE = '00000000-0000-4000-8000-000013310003';

/** Answers only the singular surname, as a word-matching resolver does. */
function singularOnlyResolver(): EntityResolver & { calls: Array<{ kind: string; reference: string; customerId?: string }> } {
  const calls: Array<{ kind: string; reference: string; customerId?: string }> = [];
  return {
    calls,
    async resolve(input): Promise<EntityResolverResult> {
      calls.push({ kind: input.kind, reference: input.reference, ...(input.customerId ? { customerId: input.customerId } : {}) });
      const ref = input.reference.trim().toLowerCase();
      if (input.kind === 'customer' && ref === 'garcia') {
        return { kind: 'resolved', candidate: { id: GARCIA, kind: 'customer', label: 'Maria Garcia', score: 1 } };
      }
      if (input.kind === 'job' && (ref === 'garcia' || (input.customerId === GARCIA && ref === 'garcia'))) {
        return { kind: 'resolved', candidate: { id: GARCIA_JOB, kind: 'job', label: 'Mini-split install', score: 1 } };
      }
      if (input.kind === 'invoice' && ref === 'smith') {
        return { kind: 'resolved', candidate: { id: SMITH_INVOICE, kind: 'invoice', label: 'INV-3310', score: 1 } };
      }
      return { kind: 'not_found', reference: input.reference };
    },
  };
}

describe('#1331 — a household named in the plural resolves to that customer\'s records', () => {
  it('"the Garcias" as the change order\'s job reference resolves the Garcia job', async () => {
    const result = await resolveSchedulingEntities(
      singularOnlyResolver(),
      TENANT,
      'create_change_order',
      { jobReference: 'the Garcias', changeOrderDescription: 'a second zone', amount: 180000 },
    );

    expect(result.status).toBe('resolved');
    expect(result.refs.jobId).toBe(GARCIA_JOB);
  });

  it('"for the Garcias" named only as the customer resolves the customer, then their job', async () => {
    const resolver = singularOnlyResolver();
    const result = await resolveSchedulingEntities(resolver, TENANT, 'create_change_order', {
      customerName: 'the Garcias',
      changeOrderDescription: 'a second zone',
      amount: 180000,
    });

    expect(result.status).toBe('resolved');
    expect(result.refs.customerId).toBe(GARCIA);
    expect(result.refs.jobId).toBe(GARCIA_JOB);
    // The job was asked about WITHIN the resolved customer, never tenant-wide.
    expect(resolver.calls.filter((c) => c.kind === 'job').every((c) => c.customerId === GARCIA)).toBe(true);
  });

  it('"the Smiths" as the refund\'s invoice reference resolves the Smith invoice', async () => {
    const result = await resolveSchedulingEntities(
      singularOnlyResolver(),
      TENANT,
      'record_refund',
      { jobReference: 'the Smiths', amount: 10000, refundMethod: 'cash' },
    );

    expect(result.status).toBe('resolved');
    expect(result.refs.invoiceId).toBe(SMITH_INVOICE);
  });
});

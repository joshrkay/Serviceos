/**
 * Two guards on the chat route's contract gate and appointment refusal, both
 * pinned by integration tests that went red on the 50-case branch:
 *
 *   1. `applyContractGate` must not gate a card on a field that is DERIVED
 *      from a reference the operator is still being asked about
 *      (`chat-entity-resolution` — a duplicate-named catalog item gates on
 *      `catalogItemId` only; `currentUnitPriceCents` is copied from the row
 *      once the id resolves).
 *   2. The "no such appointment" refusal must be corroborated by the PERSON,
 *      never inferred from a free-text miss (`auto-pick-appointment-920` — an
 *      unmatched "tune-up appointment" against a tenant with two appointments
 *      keeps its gated card and asks).
 */
import { describe, it, expect, vi } from 'vitest';
import { applyContractGate, appointmentProvablyAbsent } from '../../src/routes/assistant';
import { createProposal, missingFieldsFor } from '../../src/proposals/proposal';
import type { EntityResolver, EntityResolverResult } from '../../src/ai/resolution/entity-resolver';

const TENANT = 'tenant-absence';
const CUSTOMER_ID = '11111111-1111-4111-8111-111111111111';
const APPOINTMENT_ID = '22222222-2222-4222-8222-222222222222';

function resolverWith(
  answer: (input: { reference: string; kind: string; customerId?: string }) => EntityResolverResult,
): EntityResolver {
  return { resolve: vi.fn(async (input) => answer(input)) } as unknown as EntityResolver;
}

describe('applyContractGate — derived fields never gate a card still waiting on a reference', () => {
  it('update_catalog_item gated on catalogItemId does not also gain currentUnitPriceCents', () => {
    const proposal = createProposal({
      tenantId: TENANT,
      proposalType: 'update_catalog_item',
      payload: { catalogItemReference: 'QA Sweep Smart Thermostat Install', newUnitPriceCents: 19900 },
      summary: 'Update price',
      sourceContext: { missingFields: ['catalogItemId'] },
    });
    const added = applyContractGate(proposal);
    expect(added).toEqual([]);
    expect(missingFieldsFor(proposal)).toEqual(['catalogItemId']);
  });

  it('with no pending reference the contract-derived gap IS added (approve-to-fail stays closed)', () => {
    const proposal = createProposal({
      tenantId: TENANT,
      proposalType: 'update_catalog_item',
      payload: { catalogItemId: '33333333-3333-4333-8333-333333333333', newUnitPriceCents: 19900 },
      summary: 'Update price',
    });
    const added = applyContractGate(proposal);
    expect(added).toContain('currentUnitPriceCents');
    expect(missingFieldsFor(proposal)).toContain('currentUnitPriceCents');
  });
});

describe('appointmentProvablyAbsent — refusal only when the person proves it', () => {
  const proposal = { payload: {} as Record<string, unknown> };

  it('the named customer does not exist → absent (no customer, no appointment)', async () => {
    const resolver = resolverWith(({ reference }) => ({ kind: 'not_found', reference }));
    await expect(
      appointmentProvablyAbsent({ entityResolver: resolver }, TENANT, proposal, { customerName: 'Patel' }),
    ).resolves.toBe(true);
  });

  it('the customer exists and has an upcoming appointment → NOT absent, even though the reference missed', async () => {
    const resolver = resolverWith(({ kind, customerId, reference }) => {
      if (kind === 'customer') {
        return { kind: 'resolved', candidate: { id: CUSTOMER_ID, kind: 'customer', label: 'Jordan Lee', score: 1 } };
      }
      if (kind === 'appointment' && customerId === CUSTOMER_ID) {
        return { kind: 'resolved', candidate: { id: APPOINTMENT_ID, kind: 'appointment', label: 'Thu 10:00', score: 1 } };
      }
      return { kind: 'not_found', reference };
    });
    await expect(
      appointmentProvablyAbsent({ entityResolver: resolver }, TENANT, proposal, {
        customerName: 'Jordan Lee',
        appointmentReference: 'tune-up appointment',
      }),
    ).resolves.toBe(false);
  });

  it('the customer exists but has nothing upcoming → absent', async () => {
    const resolver = resolverWith(({ kind, reference }) =>
      kind === 'customer'
        ? { kind: 'resolved', candidate: { id: CUSTOMER_ID, kind: 'customer', label: 'Jordan Lee', score: 1 } }
        : { kind: 'not_found', reference },
    );
    await expect(
      appointmentProvablyAbsent({ entityResolver: resolver }, TENANT, proposal, { customerName: 'Jordan Lee' }),
    ).resolves.toBe(true);
  });

  it('a request naming nobody keeps its card (nothing proves the visit is not there)', async () => {
    const resolver = resolverWith(({ reference }) => ({ kind: 'not_found', reference }));
    await expect(
      appointmentProvablyAbsent({ entityResolver: resolver }, TENANT, proposal, {
        appointmentReference: 'the 2pm',
      }),
    ).resolves.toBe(false);
    expect((resolver.resolve as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });

  it('an ambiguous customer keeps its card (somebody may exist); a resolver error keeps it too', async () => {
    const ambiguous = resolverWith(() => ({
      kind: 'ambiguous',
      candidates: [
        { id: CUSTOMER_ID, kind: 'customer', label: 'Smith', score: 0.9 },
        { id: APPOINTMENT_ID, kind: 'customer', label: 'Smith', score: 0.9 },
      ],
    }));
    await expect(
      appointmentProvablyAbsent({ entityResolver: ambiguous }, TENANT, proposal, { customerName: 'Smith' }),
    ).resolves.toBe(false);
    const throwing = { resolve: vi.fn(async () => { throw new Error('boom'); }) } as unknown as EntityResolver;
    await expect(
      appointmentProvablyAbsent({ entityResolver: throwing }, TENANT, proposal, { customerName: 'Patel' }),
    ).resolves.toBe(false);
    await expect(
      appointmentProvablyAbsent({ entityResolver: undefined }, TENANT, proposal, { customerName: 'Patel' }),
    ).resolves.toBe(false);
  });

  it('a payload that already carries the customer id anchors directly on it', async () => {
    const resolver = resolverWith(({ kind, customerId, reference }) =>
      kind === 'appointment' && customerId === CUSTOMER_ID
        ? { kind: 'not_found', reference }
        : { kind: 'skipped' },
    );
    await expect(
      appointmentProvablyAbsent(
        { entityResolver: resolver },
        TENANT,
        { payload: { customerId: CUSTOMER_ID } },
        {},
      ),
    ).resolves.toBe(true);
  });
});

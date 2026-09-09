/**
 * U1 — unit pins for the shared customer-address hint decorator.
 *
 * The load-bearing claim is that the PRODUCER (`mergeHint`) and the CONSUMER
 * (`hintAddressPortion`, inside `matchDisambiguationFollowUp`) agree on the
 * `"phone · street, city"` shape, so an operator answering "104 Cedar" picks
 * the 104 Smith on every surface that holds a `LocationRepository`. That
 * round-trip is asserted directly here rather than described in a comment.
 */
import { describe, it, expect, vi } from 'vitest';
import { v4 as uuidv4 } from 'uuid';

import {
  mergeHint,
  pickHintLocation,
  formatHintAddress,
  withCustomerAddressHints,
  HINT_SEPARATOR,
  MAX_HINT_LOOKUPS,
} from '../../../src/ai/resolution/customer-address-hint';
import type {
  EntityCandidate,
  EntityResolver,
  EntityResolverResult,
} from '../../../src/ai/resolution/entity-resolver';
import {
  matchDisambiguationFollowUp,
  type PendingEntityAmbiguity,
} from '../../../src/ai/agents/customer-calling/entity-resolution';
import {
  InMemoryLocationRepository,
  type ServiceLocation,
} from '../../../src/locations/location';

const TENANT = uuidv4();
const SMITH_A = uuidv4();
const SMITH_B = uuidv4();

function location(overrides: Partial<ServiceLocation> & { customerId: string }): ServiceLocation {
  return {
    id: uuidv4(),
    tenantId: TENANT,
    street1: '104 QA Cedar Avenue',
    city: 'Phoenix',
    state: 'AZ',
    postalCode: '85001',
    country: 'US',
    isPrimary: true,
    addressType: 'service',
    isArchived: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

async function seeded(...locations: ServiceLocation[]): Promise<InMemoryLocationRepository> {
  const repo = new InMemoryLocationRepository();
  for (const l of locations) await repo.create(l);
  return repo;
}

/**
 * A resolver shaped exactly like `PgEntityResolver.resolveCustomer`: the hint
 * is the primary phone and NOTHING else. Deliberately not the pre-enriched
 * shape — enrichment is what is under test.
 */
function phoneOnlyResolver(result: EntityResolverResult): {
  resolver: EntityResolver;
  calls: () => number;
} {
  const resolve = vi.fn(async () => result);
  return { resolver: { resolve }, calls: () => resolve.mock.calls.length };
}

function customer(id: string, hint: string | undefined, score = 0.95): EntityCandidate {
  return { id, kind: 'customer', label: 'Smith', score, ...(hint ? { hint } : {}) };
}

describe('mergeHint', () => {
  it('joins phone and address with the separator the matcher parses', () => {
    expect(mergeHint('+14805550104', '104 QA Cedar Avenue, Phoenix')).toBe(
      `+14805550104${HINT_SEPARATOR}104 QA Cedar Avenue, Phoenix`,
    );
  });

  it('drops empty parts rather than emitting a dangling separator', () => {
    expect(mergeHint(undefined, '104 QA Cedar Avenue, Phoenix')).toBe('104 QA Cedar Avenue, Phoenix');
    expect(mergeHint('+14805550104', undefined)).toBe('+14805550104');
    expect(mergeHint('  ', '   ')).toBeUndefined();
    expect(mergeHint(undefined, undefined)).toBeUndefined();
  });

  it('is idempotent — an address already in the hint is never appended twice', () => {
    const once = mergeHint('+14805550104', '104 QA Cedar Avenue, Phoenix')!;
    expect(mergeHint(once, '104 QA Cedar Avenue, Phoenix')).toBe(once);
  });
});

describe('pickHintLocation / formatHintAddress', () => {
  it('prefers the primary active location', () => {
    const secondary = location({ customerId: SMITH_A, street1: '9 Other St', isPrimary: false });
    const primary = location({ customerId: SMITH_A, isPrimary: true });
    expect(pickHintLocation([secondary, primary])?.id).toBe(primary.id);
  });

  it('falls back to any active location when none is flagged primary', () => {
    const only = location({ customerId: SMITH_A, isPrimary: false });
    expect(pickHintLocation([only])?.id).toBe(only.id);
  });

  it('ignores archived rows entirely', () => {
    const archived = location({ customerId: SMITH_A, isArchived: true, isPrimary: true });
    expect(pickHintLocation([archived])).toBeUndefined();
  });

  it('formats "street1, city" and tolerates a blank city', () => {
    expect(formatHintAddress(location({ customerId: SMITH_A }))).toBe('104 QA Cedar Avenue, Phoenix');
    expect(formatHintAddress(location({ customerId: SMITH_A, city: '   ' }))).toBe('104 QA Cedar Avenue');
  });
});

describe('withCustomerAddressHints', () => {
  it('turns two phone-only Smiths into address-bearing candidates the matcher can pick from', async () => {
    const repo = await seeded(
      location({ customerId: SMITH_A, street1: '104 QA Cedar Avenue' }),
      location({ customerId: SMITH_B, street1: '105 QA Cedar Avenue' }),
    );
    const { resolver, calls } = phoneOnlyResolver({
      kind: 'ambiguous',
      candidates: [customer(SMITH_A, '+14805550104'), customer(SMITH_B, '+14805550105')],
    });

    const result = await withCustomerAddressHints(resolver, repo).resolve({
      tenantId: TENANT,
      reference: 'Smith',
      kind: 'customer',
    });

    expect(calls()).toBe(1);
    expect(result.kind).toBe('ambiguous');
    if (result.kind !== 'ambiguous') return;
    expect(result.candidates.map((c) => c.hint)).toEqual([
      '+14805550104 · 104 QA Cedar Avenue, Phoenix',
      '+14805550105 · 105 QA Cedar Avenue, Phoenix',
    ]);

    // THE ROUND TRIP: what this module produces is what the shipped matcher
    // parses. "104 Cedar" must pick the 104 Smith and nobody else.
    const pending: PendingEntityAmbiguity = {
      entityKind: 'customer',
      reference: 'Smith',
      refKey: 'customerId',
      candidates: result.candidates.map((c) => ({
        id: c.id,
        name: c.label,
        score: c.score,
        ...(c.hint ? { hint: c.hint } : {}),
      })),
      partialRefs: {},
      attemptCount: 0,
    };
    expect(matchDisambiguationFollowUp('104 Cedar', pending)).toEqual({
      status: 'resolved',
      candidateId: SMITH_A,
    });
    expect(matchDisambiguationFollowUp('105 QA Cedar Avenue', pending)).toEqual({
      status: 'resolved',
      candidateId: SMITH_B,
    });
  });

  it('leaves a candidate with no location — and one with only an archived location — untouched', async () => {
    const repo = await seeded(location({ customerId: SMITH_B, isArchived: true }));
    const { resolver } = phoneOnlyResolver({
      kind: 'ambiguous',
      candidates: [customer(SMITH_A, '+14805550104'), customer(SMITH_B, '+14805550105')],
    });

    const result = await withCustomerAddressHints(resolver, repo).resolve({
      tenantId: TENANT,
      reference: 'Smith',
      kind: 'customer',
    });

    expect(result.kind).toBe('ambiguous');
    if (result.kind !== 'ambiguous') return;
    expect(result.candidates.map((c) => c.hint)).toEqual(['+14805550104', '+14805550105']);
  });

  it('enriches a low_confidence candidate too — the confirm band shows the same address', async () => {
    const repo = await seeded(location({ customerId: SMITH_A }));
    const { resolver } = phoneOnlyResolver({
      kind: 'low_confidence',
      candidate: customer(SMITH_A, '+14805550104', 0.7),
    });

    const result = await withCustomerAddressHints(resolver, repo).resolve({
      tenantId: TENANT,
      reference: 'Smith',
      kind: 'customer',
    });

    expect(result).toEqual({
      kind: 'low_confidence',
      candidate: {
        id: SMITH_A,
        kind: 'customer',
        label: 'Smith',
        score: 0.7,
        hint: '+14805550104 · 104 QA Cedar Avenue, Phoenix',
      },
    });
  });

  it('a candidate with no hint at all gains the address as its whole hint', async () => {
    const repo = await seeded(location({ customerId: SMITH_A }));
    const { resolver } = phoneOnlyResolver({
      kind: 'ambiguous',
      candidates: [customer(SMITH_A, undefined), customer(SMITH_B, undefined)],
    });

    const result = await withCustomerAddressHints(resolver, repo).resolve({
      tenantId: TENANT,
      reference: 'Smith',
      kind: 'customer',
    });

    if (result.kind !== 'ambiguous') throw new Error('expected ambiguous');
    expect(result.candidates[0].hint).toBe('104 QA Cedar Avenue, Phoenix');
    // No location, no hint — and no `hint: undefined` key sprouted either.
    expect(Object.hasOwn(result.candidates[1], 'hint')).toBe(false);
  });

  it('a throwing repo returns the underlying result unchanged instead of failing the turn', async () => {
    const throwing = {
      findByCustomer: vi.fn(async () => {
        throw new Error('service_locations unavailable');
      }),
    };
    const { resolver } = phoneOnlyResolver({
      kind: 'ambiguous',
      candidates: [customer(SMITH_A, '+14805550104'), customer(SMITH_B, '+14805550105')],
    });

    const result = await withCustomerAddressHints(resolver, throwing).resolve({
      tenantId: TENANT,
      reference: 'Smith',
      kind: 'customer',
    });

    expect(result.kind).toBe('ambiguous');
    if (result.kind !== 'ambiguous') return;
    expect(result.candidates.map((c) => c.hint)).toEqual(['+14805550104', '+14805550105']);
  });

  it('re-asserts the tenant on every candidate lookup', async () => {
    const repo = await seeded(location({ customerId: SMITH_A }));
    const spy = vi.spyOn(repo, 'findByCustomer');
    const { resolver } = phoneOnlyResolver({
      kind: 'ambiguous',
      candidates: [customer(SMITH_A, '+14805550104'), customer(SMITH_B, '+14805550105')],
    });

    await withCustomerAddressHints(resolver, repo).resolve({
      tenantId: TENANT,
      reference: 'Smith',
      kind: 'customer',
    });

    expect(spy.mock.calls).toEqual([
      [TENANT, SMITH_A],
      [TENANT, SMITH_B],
    ]);
  });

  it('bounds the per-call lookups to the resolver candidate cap', async () => {
    const repo = new InMemoryLocationRepository();
    const spy = vi.spyOn(repo, 'findByCustomer');
    const overflow = Array.from({ length: MAX_HINT_LOOKUPS + 3 }, () =>
      customer(uuidv4(), '+14805550104'),
    );
    const { resolver } = phoneOnlyResolver({ kind: 'ambiguous', candidates: overflow });

    const result = await withCustomerAddressHints(resolver, repo).resolve({
      tenantId: TENANT,
      reference: 'Smith',
      kind: 'customer',
    });

    expect(spy).toHaveBeenCalledTimes(MAX_HINT_LOOKUPS);
    if (result.kind !== 'ambiguous') throw new Error('expected ambiguous');
    expect(result.candidates).toHaveLength(overflow.length);
  });

  describe('pass-through', () => {
    it('never touches a non-customer kind, even an ambiguous one', async () => {
      const repo = await seeded(location({ customerId: SMITH_A }));
      const spy = vi.spyOn(repo, 'findByCustomer');
      const jobResult: EntityResolverResult = {
        kind: 'ambiguous',
        candidates: [
          { id: SMITH_A, kind: 'job', label: 'Furnace maintenance', hint: 'scheduled', score: 0.9 },
        ],
      };
      const { resolver } = phoneOnlyResolver(jobResult);

      const result = await withCustomerAddressHints(resolver, repo).resolve({
        tenantId: TENANT,
        reference: 'Smith',
        kind: 'job',
      });

      expect(result).toBe(jobResult);
      expect(spy).not.toHaveBeenCalled();
    });

    for (const outcome of [
      { kind: 'resolved', candidate: customer(SMITH_A, '+14805550104') },
      { kind: 'not_found', reference: 'Smith' },
      { kind: 'skipped' },
    ] as EntityResolverResult[]) {
      it(`returns a customer '${outcome.kind}' result byte-identical`, async () => {
        const repo = await seeded(location({ customerId: SMITH_A }));
        const spy = vi.spyOn(repo, 'findByCustomer');
        const { resolver, calls } = phoneOnlyResolver(outcome);

        const result = await withCustomerAddressHints(resolver, repo).resolve({
          tenantId: TENANT,
          reference: 'Smith',
          kind: 'customer',
        });

        expect(result).toBe(outcome);
        expect(calls()).toBe(1);
        expect(spy).not.toHaveBeenCalled();
      });
    }

    it('forwards the whole input — anchors included — to the underlying resolver', async () => {
      const repo = new InMemoryLocationRepository();
      const resolve = vi.fn(async (): Promise<EntityResolverResult> => ({ kind: 'skipped' }));
      await withCustomerAddressHints({ resolve }, repo).resolve({
        tenantId: TENANT,
        reference: '',
        kind: 'appointment',
        jobId: 'job-1',
        customerId: SMITH_A,
      });
      expect(resolve).toHaveBeenCalledWith({
        tenantId: TENANT,
        reference: '',
        kind: 'appointment',
        jobId: 'job-1',
        customerId: SMITH_A,
      });
    });
  });
});

/**
 * Docker-gated integration tests — NOT run in web sessions. Requires the
 * testcontainer Postgres started by `npm run test:integration`.
 *
 * U3 — the customer address hint against REAL Postgres.
 *
 * WHY THIS FILE HAS TO EXIST. The unit suite for
 * `withCustomerAddressHints` injects an `InMemoryLocationRepository`, so it
 * proves the JOIN of resolver output and repo output and nothing about the
 * table underneath. This repo has already shipped an entity resolver whose
 * column names did not exist, because its Pool was mocked (`name` vs
 * `display_name`, `title` vs `summary` — see the header on
 * test/integration/entity-resolution.test.ts), and the enrichment this
 * decorator REPLACED was raw SQL naming `street1`, `city` and
 * `is_archived` directly. A hint that silently comes back phone-only is not a
 * crash: it is an ambiguous question the operator cannot answer, on every
 * surface at once. So the columns the hint reads are pinned here against the
 * real schema, through the real `PgLocationRepository`, over real seeded rows.
 *
 * What is pinned:
 *   - `service_locations.street1` / `.city` — the two columns the hint text is
 *     built from (`"phone · street1, city"`);
 *   - `.is_primary` — which of a customer's addresses is chosen;
 *   - `.is_archived` — an archived address is never offered;
 *   - and that `PgEntityResolver.resolveCustomer` really does hand over a
 *     PHONE-ONLY hint, which is the premise the whole decorator exists for.
 *
 * The end-to-end payoff is asserted too: the shipped follow-up matcher picks
 * the 104 Smith out of the two real candidates from the words "104 Cedar".
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';

import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgEntityResolver } from '../../src/ai/resolution/pg-entity-resolver';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgLocationRepository } from '../../src/locations/pg-location';
import { withCustomerAddressHints } from '../../src/ai/resolution/customer-address-hint';
import {
  matchDisambiguationFollowUp,
  type PendingEntityAmbiguity,
} from '../../src/ai/agents/customer-calling/entity-resolution';
import type { EntityResolver } from '../../src/ai/resolution/entity-resolver';

const SURNAME = 'qa-hint-Smithfield';

describe('Integration — customer address hint (real Postgres + real repos)', () => {
  let pool: Pool;
  let customerRepo: PgCustomerRepository;
  let locationRepo: PgLocationRepository;
  let raw: PgEntityResolver;
  let hinted: EntityResolver;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    customerRepo = new PgCustomerRepository(pool);
    locationRepo = new PgLocationRepository(pool);
    raw = new PgEntityResolver(pool);
    hinted = withCustomerAddressHints(raw, locationRepo);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  async function seedCustomer(
    tenantId: string,
    userId: string,
    phone: string,
  ): Promise<string> {
    const customerId = crypto.randomUUID();
    await customerRepo.create({
      id: customerId,
      tenantId,
      firstName: SURNAME,
      lastName: '',
      displayName: SURNAME,
      primaryPhone: phone,
      preferredChannel: 'phone',
      smsConsent: false,
      isArchived: false,
      createdBy: userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return customerId;
  }

  async function seedLocation(
    tenantId: string,
    customerId: string,
    street1: string,
    opts: { city?: string; isPrimary?: boolean; isArchived?: boolean } = {},
  ): Promise<string> {
    const id = crypto.randomUUID();
    await locationRepo.create({
      id,
      tenantId,
      customerId,
      street1,
      city: opts.city ?? 'Phoenix',
      state: 'AZ',
      postalCode: '85001',
      country: 'USA',
      isPrimary: opts.isPrimary ?? true,
      addressType: 'service',
      isArchived: opts.isArchived ?? false,
      ...(opts.isArchived ? { archivedAt: new Date() } : {}),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return id;
  }

  it('turns two same-name customers into address-bearing candidates a "104 Cedar" answer resolves', async () => {
    const t = await createTestTenant(pool);
    const smithA = await seedCustomer(t.tenantId, t.userId, '+14805550104');
    const smithB = await seedCustomer(t.tenantId, t.userId, '+14805550105');
    await seedLocation(t.tenantId, smithA, '104 QA Cedar Avenue');
    await seedLocation(t.tenantId, smithB, '105 QA Cedar Avenue');

    // PREMISE: production really does hand over a phone-only hint. If this
    // ever stops being true the decorator's contract changed underneath it.
    const bare = await raw.resolve({ tenantId: t.tenantId, reference: SURNAME, kind: 'customer' });
    expect(bare.kind).toBe('ambiguous');
    if (bare.kind !== 'ambiguous') return;
    expect(bare.candidates.map((c) => c.hint).sort()).toEqual(['+14805550104', '+14805550105']);

    const result = await hinted.resolve({
      tenantId: t.tenantId,
      reference: SURNAME,
      kind: 'customer',
    });
    expect(result.kind).toBe('ambiguous');
    if (result.kind !== 'ambiguous') return;
    expect(result.candidates.map((c) => c.hint).sort()).toEqual([
      '+14805550104 · 104 QA Cedar Avenue, Phoenix',
      '+14805550105 · 105 QA Cedar Avenue, Phoenix',
    ]);

    const pending: PendingEntityAmbiguity = {
      entityKind: 'customer',
      reference: SURNAME,
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
      candidateId: smithA,
    });
  });

  it('reads is_primary — the primary address is the one offered', async () => {
    const t = await createTestTenant(pool);
    const smithA = await seedCustomer(t.tenantId, t.userId, '+14805550104');
    const smithB = await seedCustomer(t.tenantId, t.userId, '+14805550105');
    // Insert the NON-primary first so "first row wins" would pick the wrong one.
    await seedLocation(t.tenantId, smithA, '7 Rental Row', { isPrimary: false });
    await seedLocation(t.tenantId, smithA, '104 QA Cedar Avenue', { isPrimary: true });
    await seedLocation(t.tenantId, smithB, '105 QA Cedar Avenue');

    const result = await hinted.resolve({
      tenantId: t.tenantId,
      reference: SURNAME,
      kind: 'customer',
    });
    if (result.kind !== 'ambiguous') throw new Error('expected ambiguous');
    const hint = result.candidates.find((c) => c.id === smithA)?.hint;
    expect(hint).toBe('+14805550104 · 104 QA Cedar Avenue, Phoenix');
  });

  it('reads is_archived — a retired address is never offered', async () => {
    const t = await createTestTenant(pool);
    const smithA = await seedCustomer(t.tenantId, t.userId, '+14805550104');
    const smithB = await seedCustomer(t.tenantId, t.userId, '+14805550105');
    await seedLocation(t.tenantId, smithA, '999 Old Address', {
      isPrimary: true,
      isArchived: true,
    });
    await seedLocation(t.tenantId, smithB, '105 QA Cedar Avenue');

    const result = await hinted.resolve({
      tenantId: t.tenantId,
      reference: SURNAME,
      kind: 'customer',
    });
    if (result.kind !== 'ambiguous') throw new Error('expected ambiguous');
    // Archived-only ⇒ the phone-only hint stands; nothing invented, nothing
    // offered that the tenant retired.
    expect(result.candidates.find((c) => c.id === smithA)?.hint).toBe('+14805550104');
    expect(result.candidates.find((c) => c.id === smithB)?.hint).toBe(
      '+14805550105 · 105 QA Cedar Avenue, Phoenix',
    );
  });

  it('never crosses tenants — another tenant\'s address is not borrowed', async () => {
    const home = await createTestTenant(pool);
    const other = await createTestTenant(pool);
    const smithA = await seedCustomer(home.tenantId, home.userId, '+14805550104');
    const smithB = await seedCustomer(home.tenantId, home.userId, '+14805550105');
    await seedLocation(home.tenantId, smithB, '105 QA Cedar Avenue');
    // Same customer id, different tenant — the row exists but must be invisible.
    await seedLocation(other.tenantId, smithA, '104 QA Cedar Avenue');

    const result = await hinted.resolve({
      tenantId: home.tenantId,
      reference: SURNAME,
      kind: 'customer',
    });
    if (result.kind !== 'ambiguous') throw new Error('expected ambiguous');
    expect(result.candidates.find((c) => c.id === smithA)?.hint).toBe('+14805550104');
  });

  it('leaves a single confident match alone — no question, no lookup needed', async () => {
    const t = await createTestTenant(pool);
    const only = await seedCustomer(t.tenantId, t.userId, '+14805550104');
    await seedLocation(t.tenantId, only, '104 QA Cedar Avenue');

    const result = await hinted.resolve({
      tenantId: t.tenantId,
      reference: SURNAME,
      kind: 'customer',
    });
    expect(result.kind).toBe('resolved');
    if (result.kind !== 'resolved') return;
    expect(result.candidate.id).toBe(only);
    expect(result.candidate.hint).toBe('+14805550104');
  });
});

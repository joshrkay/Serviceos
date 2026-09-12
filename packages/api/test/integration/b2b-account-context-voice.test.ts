/**
 * #1014 row 2.12 — B2B / property-manager routing, T3, at real Postgres.
 *
 * PR #1029 (landed on `origin/main`) wired the reader: `session.b2bAccountContext`
 * is read at classify time in `create-voice-turn-processor.ts` (~line 4391) and
 * turned into a `b2bAccountPromptSection` the classifier prompt carries only
 * when a business account was resolved — before that PR the field was written
 * once (twilio-adapter.ts:953) and read nowhere (map correction, #995).
 *
 * This drives the REAL inbound-call establishment path
 * (`TwilioGatherAdapter.handleInbound` → `establishInboundSession` →
 * `bootstrapCallEstablishment` → `loadB2bAccountContext` →
 * `assembleB2bAccountContext`) against REAL Postgres customer rows, then
 * calls the SAME production `buildAccountContextPromptSection` the turn
 * processor calls verbatim on `session.b2bAccountContext` (create-voice-turn
 * -processor.ts's own `session.b2bAccountContext ? buildAccountContextPromptSection(...)
 * : undefined` branch) to observe the exact classify-prompt section each
 * session produces — not a re-implementation, the literal function the
 * classify step invokes.
 *
 * T3, one run: tenant A's property-manager caller gets a PRIORITY section
 * naming its managed properties; tenant A's ordinary residential caller
 * (same tenant) gets none; tenant B — with no B2B account configured at
 * all — gets none either.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb, type TestTenant } from './shared';
import { TwilioGatherAdapter } from '../../src/telephony/twilio-adapter';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { VoiceSessionStore } from '../../src/ai/agents/customer-calling/voice-session-store';
import { buildAccountContextPromptSection } from '../../src/ai/agents/customer-calling/b2b-account-context';

describe('Postgres integration — B2B/property-manager account context reaches the classify prompt (T3)', () => {
  let pool: Pool;
  let customerRepo: PgCustomerRepository;
  let tenantA: TestTenant;
  let tenantB: TestTenant;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    customerRepo = new PgCustomerRepository(pool);
    tenantA = await createTestTenant(pool);
    tenantB = await createTestTenant(pool);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  function makeAdapter(tenantId: string, store: VoiceSessionStore): TwilioGatherAdapter {
    return new TwilioGatherAdapter({
      store,
      gateway: { complete: vi.fn() } as never,
      pool,
      customerRepo,
      businessName: 'Test Co',
    });
  }

  async function driveInboundCall(
    tenantId: string,
    callSid: string,
    fromPhone: string,
  ) {
    const store = new VoiceSessionStore({ startInterval: false });
    const adapter = makeAdapter(tenantId, store);
    await adapter.handleInbound({ callSid, from: fromPhone, to: '+15125550000', tenantId });
    return store.findByCallSid(callSid)!;
  }

  it("T3: a property_manager caller's session gets a PRIORITY classify-prompt section naming its managed properties; a residential caller on the SAME tenant gets none; a second tenant with no B2B account gets none", async () => {
    // --- Tenant A: a property-manager account with two managed sub-accounts.
    const pmId = crypto.randomUUID();
    await customerRepo.create({
      id: pmId,
      tenantId: tenantA.tenantId,
      firstName: 'Portfolio',
      lastName: 'Manager',
      displayName: 'Acme Property Management',
      primaryPhone: '+15125550801',
      accountType: 'property_manager',
      preferredChannel: 'phone',
      smsConsent: false,
      isArchived: false,
      createdBy: tenantA.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    for (const [suffix, name] of [
      ['A', 'Maple Street Apartments'],
      ['B', 'Oak Ridge Townhomes'],
    ] as const) {
      await customerRepo.create({
        id: crypto.randomUUID(),
        tenantId: tenantA.tenantId,
        firstName: 'Managed',
        lastName: `Property ${suffix}`,
        displayName: name,
        accountType: 'property_manager',
        parentAccountId: pmId,
        preferredChannel: 'phone',
        smsConsent: false,
        isArchived: false,
        createdBy: tenantA.userId,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    }

    // --- Tenant A: an ordinary residential customer, same tenant.
    await customerRepo.create({
      id: crypto.randomUUID(),
      tenantId: tenantA.tenantId,
      firstName: 'Homer',
      lastName: 'Owner',
      displayName: 'Homer Owner',
      primaryPhone: '+15125550802',
      preferredChannel: 'phone',
      smsConsent: false,
      isArchived: false,
      createdBy: tenantA.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // --- Tenant B: only a residential customer — no B2B account anywhere.
    await customerRepo.create({
      id: crypto.randomUUID(),
      tenantId: tenantB.tenantId,
      firstName: 'Bess',
      lastName: 'Renter',
      displayName: 'Bess Renter',
      primaryPhone: '+15125550803',
      preferredChannel: 'phone',
      smsConsent: false,
      isArchived: false,
      createdBy: tenantB.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const pmSession = await driveInboundCall(tenantA.tenantId, 'CA-b2b-pm', '+15125550801');
    const residentialSession = await driveInboundCall(tenantA.tenantId, 'CA-b2b-res', '+15125550802');
    const tenantBSession = await driveInboundCall(tenantB.tenantId, 'CA-b2b-tb', '+15125550803');

    // The property-manager caller resolved a real, Postgres-loaded B2B context.
    expect(pmSession.b2bAccountContext).toBeDefined();
    expect(pmSession.b2bAccountContext?.accountType).toBe('property_manager');
    expect(pmSession.b2bAccountContext?.priority).toBe(true);
    expect(pmSession.b2bAccountContext?.subAccounts.map((s) => s.displayName).sort()).toEqual([
      'Maple Street Apartments',
      'Oak Ridge Townhomes',
    ]);

    // The exact section create-voice-turn-processor.ts assembles at classify
    // time (session.b2bAccountContext ? buildAccountContextPromptSection(...)
    // : undefined) — the observable classify-prompt difference.
    const pmSection = pmSession.b2bAccountContext
      ? buildAccountContextPromptSection(pmSession.b2bAccountContext)
      : undefined;
    expect(pmSection).toBeDefined();
    expect(pmSection).toMatch(/PRIORITY/);
    expect(pmSection).toMatch(/property-management account/);
    expect(pmSection).toMatch(/Maple Street Apartments/);
    expect(pmSection).toMatch(/Oak Ridge Townhomes/);

    // Same tenant, residential caller: no B2B context, so the classify prompt
    // carries NO b2bAccountPromptSection at all (undefined, not an empty one).
    expect(residentialSession.b2bAccountContext).toBeUndefined();
    const residentialSection = residentialSession.b2bAccountContext
      ? buildAccountContextPromptSection(residentialSession.b2bAccountContext)
      : undefined;
    expect(residentialSection).toBeUndefined();

    // Tenant B — no B2B account exists on this tenant at all — gets nothing,
    // proving tenant A's property-manager row never leaks into tenant B's
    // classify context.
    expect(tenantBSession.b2bAccountContext).toBeUndefined();
    const tenantBSection = tenantBSession.b2bAccountContext
      ? buildAccountContextPromptSection(tenantBSession.b2bAccountContext)
      : undefined;
    expect(tenantBSection).toBeUndefined();
  });
});

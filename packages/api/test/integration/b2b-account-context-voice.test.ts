/**
 * #1014 row 2.12 — B2B / property-manager routing, T3, at real Postgres.
 *
 * PR #1029 (landed on `origin/main`) wired the reader: `session.b2bAccountContext`
 * is read at classify time in `create-voice-turn-processor.ts` (~line 4391) and
 * turned into a `b2bAccountPromptSection` the classifier prompt carries only
 * when a business account was resolved — before that PR the field was written
 * once (twilio-adapter.ts:953) and read nowhere (map correction, #995).
 *
 * Review finding (chatgpt-codex-connector, PR #1043): the previous version of
 * this test stopped after inbound session establishment and called
 * `buildAccountContextPromptSection` directly — it never invoked
 * `classifyIntent` or any proposal-producing turn, so it would still pass if
 * production stopped forwarding `session.b2bAccountContext` to the
 * classifier. Fixed: this now drives a REAL speech turn through
 * `TwilioGatherAdapter.processCallerUtterance` — the exact call
 * `attachMediaStreamServer`'s `speechTurn` hook makes in production
 * (app.ts:4389) — which delegates to `create-voice-turn-processor.ts`'s
 * `speechTurn`, the ONLY call path that reads `session.b2bAccountContext`
 * (line 4391) and forwards it into `classifyIntent`'s messages
 * (intent-classifier.ts:2737-2742, a `role: 'system'` message literally
 * prefixed `"Caller account context"`). The test spies on
 * `gateway.complete` and inspects the REAL system messages
 * `classifyIntent` built, not a re-implementation.
 *
 * IMPORTANT — production gap found while fixing this (not introduced by
 * lane A, out of scope to fix under this test-only lane): the classic
 * `<Gather>`/PSTN transport has its OWN, separate inline `classifyIntent`
 * call site in `twilio-adapter.ts`'s private `_handleGatherLocked` (~line
 * 2348, reached via `handleGather`, which is what `routes/telephony.ts`'s
 * `/gather` webhook — the production entry for every classic (non-media-
 * streams) inbound phone call — calls at line 650). That call site NEVER
 * reads `session.b2bAccountContext` and never builds a
 * `b2bAccountPromptSection` at all. PR #1029 only wired the media-streams
 * `speechTurn` path (create-voice-turn-processor.ts). So today, a REAL
 * property-manager caller on a classic Gather/PSTN call gets NO account
 * context in their classify prompt — only a media-streams call does. The
 * second test below drives `handleGather` on the identical PM session to
 * prove this negative at real Postgres rather than leaving it as an
 * assertion in a code comment; see the PR body for the flag to Josh/Fable.
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
import type { LLMGateway, LLMResponse } from '../../src/ai/gateway/gateway';

function makeGatewayReturning(content: string): LLMGateway {
  const response: LLMResponse = {
    content,
    model: 'mock-model',
    provider: 'mock',
    tokenUsage: { input: 1, output: 1, total: 2 },
    latencyMs: 1,
  };
  return { complete: vi.fn().mockResolvedValue(response) } as unknown as LLMGateway;
}

function systemMessageText(gateway: LLMGateway): string {
  const calls = (gateway.complete as ReturnType<typeof vi.fn>).mock.calls;
  expect(calls.length).toBeGreaterThanOrEqual(1);
  const { messages } = calls[calls.length - 1][0] as {
    messages: Array<{ role: string; content: string }>;
  };
  return messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n---\n');
}

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

  function makeAdapter(store: VoiceSessionStore, gateway: LLMGateway): TwilioGatherAdapter {
    return new TwilioGatherAdapter({
      store,
      gateway,
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
    const gateway = makeGatewayReturning('{"intentType":"unknown","confidence":0.2}');
    const adapter = makeAdapter(store, gateway);
    await adapter.handleInbound({ callSid, from: fromPhone, to: '+15125550000', tenantId });
    return { session: store.findByCallSid(callSid)!, adapter, gateway, callSid };
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

    const pm = await driveInboundCall(tenantA.tenantId, 'CA-b2b-pm', '+15125550801');
    const residential = await driveInboundCall(tenantA.tenantId, 'CA-b2b-res', '+15125550802');
    const tenantBCall = await driveInboundCall(tenantB.tenantId, 'CA-b2b-tb', '+15125550803');

    // The property-manager caller resolved a real, Postgres-loaded B2B context.
    expect(pm.session.b2bAccountContext).toBeDefined();
    expect(pm.session.b2bAccountContext?.accountType).toBe('property_manager');
    expect(pm.session.b2bAccountContext?.priority).toBe(true);
    expect(pm.session.b2bAccountContext?.subAccounts.map((s) => s.displayName).sort()).toEqual([
      'Maple Street Apartments',
      'Oak Ridge Townhomes',
    ]);
    expect(residential.session.b2bAccountContext).toBeUndefined();
    expect(tenantBCall.session.b2bAccountContext).toBeUndefined();

    // Sanity on the production function itself, in isolation, before trusting
    // it inside a full turn below.
    const pmSection = pm.session.b2bAccountContext
      ? buildAccountContextPromptSection(pm.session.b2bAccountContext)
      : undefined;
    expect(pmSection).toBeDefined();
    expect(pmSection).toMatch(/PRIORITY/);
    expect(pmSection).toMatch(/property-management account/);
    expect(pmSection).toMatch(/Maple Street Apartments/);
    expect(pmSection).toMatch(/Oak Ridge Townhomes/);

    // Drive a REAL speech turn through processCallerUtterance — the exact
    // media-streams `speechTurn` hook production wires (app.ts:4389) — and
    // inspect the REAL classifyIntent messages gateway.complete received.
    // Fixes the Codex finding: this is no longer a re-implementation check,
    // it is the literal classify-prompt content a live turn would send.
    await pm.adapter.processCallerUtterance({
      sessionId: pm.session.id,
      callSid: pm.callSid,
      speechResult: 'the kitchen faucet at Maple Street is leaking',
      tenantId: tenantA.tenantId,
    });
    const pmPromptText = systemMessageText(pm.gateway);
    expect(pmPromptText).toMatch(/Caller account context/);
    expect(pmPromptText).toMatch(/PRIORITY/);
    expect(pmPromptText).toMatch(/Maple Street Apartments/);
    expect(pmPromptText).toMatch(/Oak Ridge Townhomes/);

    // Same tenant, residential caller, same real turn path: NO account
    // context section at all (not an empty one — absent).
    await residential.adapter.processCallerUtterance({
      sessionId: residential.session.id,
      callSid: residential.callSid,
      speechResult: 'my water heater is making a weird noise',
      tenantId: tenantA.tenantId,
    });
    expect(systemMessageText(residential.gateway)).not.toMatch(/Caller account context/);

    // Tenant B — no B2B account anywhere on this tenant — same real turn
    // path, still nothing: tenant A's property-manager row never leaks into
    // tenant B's classify prompt.
    await tenantBCall.adapter.processCallerUtterance({
      sessionId: tenantBCall.session.id,
      callSid: tenantBCall.callSid,
      speechResult: 'my thermostat is not turning on',
      tenantId: tenantB.tenantId,
    });
    expect(systemMessageText(tenantBCall.gateway)).not.toMatch(/Caller account context/);
  });

  /**
   * Documents a real production gap discovered while fixing the Codex
   * finding above (out of scope to fix under this test-only lane — see file
   * header and the PR body). The classic `<Gather>`/PSTN transport
   * (`routes/telephony.ts` `/gather` → `TwilioGatherAdapter.handleGather` →
   * private `_handleGatherLocked`, twilio-adapter.ts ~line 2348) has its OWN
   * inline `classifyIntent` call that never reads `session.b2bAccountContext`
   * and never builds a `b2bAccountPromptSection` — unlike
   * `processCallerUtterance` (the media-streams path proven above). This
   * test drives the SAME property-manager session through `handleGather`
   * instead and proves the account-context section is absent there too,
   * at real Postgres — a negative result that IS the finding.
   */
  it('a REAL Gather/PSTN turn on the SAME property-manager session gets NO account-context section — a live production gap, not fixed here', async () => {
    const pmId = crypto.randomUUID();
    await customerRepo.create({
      id: pmId,
      tenantId: tenantA.tenantId,
      firstName: 'Portfolio',
      lastName: 'Manager',
      displayName: 'Gather Property Management',
      primaryPhone: '+15125550811',
      accountType: 'property_manager',
      preferredChannel: 'phone',
      smsConsent: false,
      isArchived: false,
      createdBy: tenantA.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await customerRepo.create({
      id: crypto.randomUUID(),
      tenantId: tenantA.tenantId,
      firstName: 'Managed',
      lastName: 'Property C',
      displayName: 'Cedar Lane Condos',
      accountType: 'property_manager',
      parentAccountId: pmId,
      preferredChannel: 'phone',
      smsConsent: false,
      isArchived: false,
      createdBy: tenantA.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const gatherPm = await driveInboundCall(tenantA.tenantId, 'CA-b2b-gather-pm', '+15125550811');
    expect(gatherPm.session.b2bAccountContext).toBeDefined();
    expect(gatherPm.session.b2bAccountContext?.accountType).toBe('property_manager');

    await gatherPm.adapter.handleGather({
      sessionId: gatherPm.session.id,
      callSid: gatherPm.callSid,
      speechResult: 'the roof at Cedar Lane is leaking',
      confidence: 0.95,
      tenantId: tenantA.tenantId,
    });

    const gatherPromptText = systemMessageText(gatherPm.gateway);
    // The real, Postgres-loaded B2B context exists on the session (proven
    // above) but never reaches this transport's classify call.
    expect(gatherPromptText).not.toMatch(/Caller account context/);
    expect(gatherPromptText).not.toMatch(/Cedar Lane/);
  });
});

/**
 * WS5 → #866 — `lookup_catalog` is gated on the ACTOR's role (`settings:view`:
 * owners and dispatchers), not on the caller-ID boolean.
 *
 * Before WS5 any identified caller could browse the price book. WS5 gated it
 * on `ownerSession`. #866 routes the phone through the shared dispatch, whose
 * RBAC gate mirrors the web route (GET /api/catalog-items): an owner or
 * dispatcher actor hears the catalog; a customer (no actor) or a technician
 * hears the office-level refusal and the repo is never read. Customer price
 * questions still flow through the grounded estimate path.
 */
import { describe, it, expect, vi } from 'vitest';
import { TwilioGatherAdapter } from '../../src/telephony/twilio-adapter';
import { VoiceSessionStore } from '../../src/ai/agents/customer-calling/voice-session-store';
import type { LLMGateway, LLMResponse } from '../../src/ai/gateway/gateway';
import type { CatalogItem, CatalogItemRepository } from '../../src/catalog/catalog-item';
import type { PhoneLookupDeps } from '../../src/ai/voice-turn/phone-lookup-surface';

const tenantId = 'tenant-cat';

function gatewayReturning(content: string): LLMGateway {
  const response: LLMResponse = {
    content,
    model: 'mock-model',
    provider: 'mock',
    tokenUsage: { input: 1, output: 1, total: 2 },
    latencyMs: 1,
  };
  return { complete: vi.fn().mockResolvedValue(response) } as unknown as LLMGateway;
}

function catalogItem(name: string, unitPriceCents: number): CatalogItem {
  const now = new Date().toISOString();
  return {
    id: `c-${name}`,
    tenantId,
    name,
    description: '',
    category: 'Parts',
    unit: 'each',
    unitPriceCents,
    productServiceType: 'product',
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

function makeAdapter(actor?: { userId: string; role: 'owner' | 'dispatcher' | 'technician' }) {
  const store = new VoiceSessionStore({ startInterval: false });
  const listByTenant = vi.fn(async () => [
    catalogItem('Water Heater Replacement', 185000),
    catalogItem('Gasket', 450),
  ]);
  const catalogRepo = { listByTenant } as unknown as CatalogItemRepository;
  const lookups: PhoneLookupDeps = {
    answers: {
      catalogRepo,
      resolveMemberRole: async (_t, userId) => (actor && userId === actor.userId ? actor.role : null),
    },
    shared: { proposalRepo: { findByTenant: vi.fn(async () => []) } as never },
  };
  const adapter = new TwilioGatherAdapter({
    store,
    gateway: gatewayReturning(JSON.stringify({ intentType: 'lookup_catalog', confidence: 0.96 })),
    businessName: 'Acme Plumbing',
    publicBaseUrl: 'https://example.com',
    lookups,
  });
  const callSid = `CA-cat-${actor?.role ?? 'cust'}`;
  const session = store.create(tenantId, 'telephony', { callSid });
  if (actor) session.actorUserId = actor.userId;
  session.machine.dispatch({ type: 'incoming_call', tenantId, callSid, from: '+15125550111', to: '+15125550000' });
  session.machine.dispatch({ type: 'greeted_ok' });
  session.machine.dispatch({ type: 'caller_known', customerId: 'cust-1' });
  // Even an identified CUSTOMER must not browse the catalog.
  session.customerId = 'cust-1';
  return { adapter, session, callSid, listByTenant };
}

const ask = (h: ReturnType<typeof makeAdapter>) =>
  h.adapter.handleGather({
    sessionId: h.session.id,
    callSid: h.callSid,
    speechResult: "what's in our catalog",
    confidence: 0.95,
    tenantId,
  });

describe('lookup_catalog — gated on the actor\'s role (settings:view)', () => {
  it.each(['owner', 'dispatcher'] as const)('a %s actor hears the catalog summary', async (role) => {
    const h = makeAdapter({ userId: `clerk-${role}`, role });
    const xml = await ask(h);
    expect(xml).toContain('catalog items');
    expect(xml).toContain('Water Heater Replacement');
    expect(h.listByTenant).toHaveBeenCalled();
  });

  it('a technician actor is refused with the office-level copy and the repo is never read', async () => {
    const h = makeAdapter({ userId: 'clerk-tech', role: 'technician' });
    const xml = await ask(h);
    expect(xml).toContain('office-level view');
    expect(xml).not.toContain('Water Heater Replacement');
    expect(h.listByTenant).not.toHaveBeenCalled();
  });

  it('an identified customer (no actor) is refused and never reads the catalog', async () => {
    const h = makeAdapter();
    const xml = await ask(h);
    expect(xml).toContain('office-level view');
    expect(xml).not.toContain('Water Heater Replacement');
    expect(h.listByTenant).not.toHaveBeenCalled();
  });
});

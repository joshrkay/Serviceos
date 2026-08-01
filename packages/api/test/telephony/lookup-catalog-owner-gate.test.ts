/**
 * WS5 — `lookup_catalog` is owner-only at runtime.
 *
 * Before WS5 the catalog browse was gated only on `session.customerId` (any
 * identified caller), contradicting the classifier doc (owner/dispatcher
 * only). WS5 gates it on the RV-070 `ownerSession` flag: an owner hears the
 * catalog; a customer gets the human fallback (their price questions flow
 * through the grounded estimate path instead).
 */
import { describe, it, expect, vi } from 'vitest';
import { TwilioGatherAdapter } from '../../src/telephony/twilio-adapter';
import { VoiceSessionStore } from '../../src/ai/agents/customer-calling/voice-session-store';
import type { LLMGateway, LLMResponse } from '../../src/ai/gateway/gateway';
import type { CatalogItem, CatalogItemRepository } from '../../src/catalog/catalog-item';

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

function makeAdapter(ownerSession: boolean) {
  const store = new VoiceSessionStore({ startInterval: false });
  const listByTenant = vi.fn(async () => [
    catalogItem('Water Heater Replacement', 185000),
    catalogItem('Gasket', 450),
  ]);
  const catalogRepo = { listByTenant } as unknown as CatalogItemRepository;
  const adapter = new TwilioGatherAdapter({
    store,
    gateway: gatewayReturning(JSON.stringify({ intentType: 'lookup_catalog', confidence: 0.96 })),
    businessName: 'Acme Plumbing',
    publicBaseUrl: 'https://example.com',
    catalogRepo,
  });
  const callSid = ownerSession ? 'CA-cat-owner' : 'CA-cat-cust';
  const session = store.create(tenantId, 'telephony', {
    callSid,
    ...(ownerSession ? { ownerSession: true } : {}),
  });
  session.machine.dispatch({ type: 'incoming_call', tenantId, callSid, from: '+15125550111', to: '+15125550000' });
  session.machine.dispatch({ type: 'greeted_ok' });
  session.machine.dispatch({ type: 'caller_known', customerId: 'cust-1' });
  // Even an identified CUSTOMER (non-owner) must not browse the catalog.
  session.customerId = 'cust-1';
  return { adapter, session, callSid, listByTenant };
}

describe('WS5 — lookup_catalog owner gate', () => {
  it('owner session hears the catalog summary', async () => {
    const { adapter, session, callSid, listByTenant } = makeAdapter(true);
    const xml = await adapter.handleGather({
      sessionId: session.id,
      callSid,
      speechResult: "what's in our catalog",
      confidence: 0.95,
      tenantId,
    });
    expect(xml).toContain('catalog items');
    expect(xml).toContain('Water Heater Replacement');
    expect(listByTenant).toHaveBeenCalled();
  });

  it('non-owner (customer) session is refused and never reads the catalog', async () => {
    const { adapter, session, callSid, listByTenant } = makeAdapter(false);
    const xml = await adapter.handleGather({
      sessionId: session.id,
      callSid,
      speechResult: "what's in your catalog",
      confidence: 0.95,
      tenantId,
    });
    expect(xml).toContain('I&apos;m having trouble pulling that up right now');
    expect(xml).not.toContain('Water Heater Replacement');
    expect(listByTenant).not.toHaveBeenCalled();
  });
});

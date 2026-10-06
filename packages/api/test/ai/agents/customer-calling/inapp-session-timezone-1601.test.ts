/**
 * #1601 step 2 — characterisation at the `InAppVoiceAdapter.handleInput`
 * seam BEFORE the once-per-session timezone read moves to
 * `ai/voice-turn/shared/session-timezone.ts`:
 *   - with the tenant's zone configured, "next Tuesday at 9 AM" is resolved
 *     onto the pending request as a concrete window at 09:00 IN THAT ZONE;
 *   - a failed settings read leaves the zone unset — no window is resolved
 *     (never a silent server-zone parse), and the request is still captured
 *     and read back (never a crash).
 * Harness: the #1476 in-app fixture (scripted gateway + resolver fake).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { InAppVoiceAdapter } from '../../../../src/ai/agents/customer-calling/inapp-adapter';
import { VoiceSessionStore } from '../../../../src/ai/agents/customer-calling/voice-session-store';
import { InMemoryProposalRepository } from '../../../../src/proposals/proposal';
import { InMemoryAuditRepository } from '../../../../src/audit/audit';
import { InMemoryOnCallRepository } from '../../../../src/oncall/rotation';
import { InMemoryCustomerRepository, createCustomer } from '../../../../src/customers/customer';
import type { LLMGateway, LLMResponse } from '../../../../src/ai/gateway/gateway';
import type { EntityResolver, EntityResolverResult } from '../../../../src/ai/resolution/entity-resolver';
import type { SettingsRepository } from '../../../../src/settings/settings';

const TENANT = 'tenant-1601-inapp-tz';
const OPERATOR = 'user-operator-1601';

const BOOKING_FOR_DANA = JSON.stringify({
  intentType: 'create_appointment',
  confidence: 0.92,
  extractedEntities: {
    customerName: 'Dana Whitfield',
    jobTitle: 'attic fan replacement',
    dateTimeDescription: 'next Tuesday at 9 AM',
  },
});

function gatewayAlways(content: string): LLMGateway {
  return {
    complete: vi.fn(async () => ({
      content,
      model: 'mock',
      provider: 'mock',
      tokenUsage: { input: 1, output: 1, total: 2 },
      latencyMs: 1,
    }) satisfies LLMResponse),
  } as unknown as LLMGateway;
}

function resolverFor(customerId: string) {
  const dana: EntityResolverResult = {
    kind: 'resolved',
    candidate: { id: customerId, kind: 'customer', label: 'Dana Whitfield', score: 0.97 },
  };
  const resolve = vi.fn(async (input: { kind: string }) =>
    input.kind === 'customer' ? dana : ({ kind: 'not_found' } as EntityResolverResult),
  );
  return { resolver: { resolve } as unknown as EntityResolver, resolve };
}

describe('#1601 — InAppVoiceAdapter: the tenant timezone on a booking turn', () => {
  let store: VoiceSessionStore;
  let customerRepo: InMemoryCustomerRepository;
  let danaId: string;

  beforeEach(async () => {
    store = new VoiceSessionStore({ startInterval: false });
    customerRepo = new InMemoryCustomerRepository();
    const dana = await createCustomer(
      { tenantId: TENANT, firstName: 'Dana', lastName: 'Whitfield', primaryPhone: '+14805550199', createdBy: OPERATOR },
      customerRepo,
    );
    danaId = dana.id;
  });
  afterEach(() => store.dispose());

  function adapterWith(settingsRepo: SettingsRepository) {
    const { resolver, resolve } = resolverFor(danaId);
    const adapter = new InAppVoiceAdapter({
      store,
      gateway: gatewayAlways(BOOKING_FOR_DANA),
      proposalRepo: new InMemoryProposalRepository(),
      auditRepo: new InMemoryAuditRepository(),
      onCallRepo: new InMemoryOnCallRepository(new Map()),
      entityResolver: resolver,
      customerRepo,
      settingsRepo,
    });
    return { adapter, resolve };
  }

  const pendingRequest = (sessionId: string) =>
    (store.snapshot(sessionId)?.context.extractedEntities ?? {}) as { scheduledStart?: string };

  it("the configured zone resolves the spoken time onto the pending request at 09:00 in the tenant's clock", async () => {
    const { adapter } = adapterWith({
      findByTenant: async () => ({ timezone: 'America/Phoenix' }),
    } as unknown as SettingsRepository);
    const { sessionId } = await adapter.startSession(TENANT, OPERATOR);

    const turn = await adapter.handleInput(sessionId, 'Book Dana Whitfield next Tuesday at 9 AM for the attic fan');

    expect(turn.state).toBe('intent_confirm');
    const { scheduledStart } = pendingRequest(sessionId);
    expect(typeof scheduledStart).toBe('string');
    expect(
      new Date(scheduledStart!).toLocaleTimeString('en-US', {
        timeZone: 'America/Phoenix',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }),
    ).toBe('09:00');
  });

  it('a failed settings read leaves the zone unset — no window is resolved, the booking is still captured and read back', async () => {
    const { adapter, resolve } = adapterWith({
      findByTenant: async () => {
        throw new Error('pg down');
      },
    } as unknown as SettingsRepository);
    const { sessionId } = await adapter.startSession(TENANT, OPERATOR);

    const turn = await adapter.handleInput(sessionId, 'Book Dana Whitfield next Tuesday at 9 AM for the attic fan');

    expect(turn.state).toBe('intent_confirm');
    expect(resolve).toHaveBeenCalled();
    expect(pendingRequest(sessionId).scheduledStart).toBeUndefined();
  });
});

/**
 * #1588 — `voice_extended_intents` was read by the app but never seeded for
 * any tenant, so on the live owner line the extended operator intents
 * (lookup_day_overview / lookup_digest / lookup_pending_items /
 * lookup_crew_schedule / lookup_timesheets) never ran by voice, while chat
 * set them unconditionally. The tenant flag is now DEFAULT-ON (the repo's
 * `isEnabledForTenantWithDefault` pattern): a tenant with no override row and
 * no platform flag resolves `true`, so the phone's session establishment
 * stamps `extendedIntents` on an owner session and "What's my day look like?"
 * is the owner's cross-crew day overview.
 *
 * Seam: createVoiceTurnProcessor().speechTurn on the owner line, with the
 * session established the way `establishInboundSession` composes it
 * (ownerSession && the production flag resolver), in-memory repos, and a
 * classifier stub that never names the intent — so the overview is reachable
 * only through the extended-intents path the flag unlocks.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

import { createVoiceTurnProcessor } from '../../../src/ai/voice-turn';
import { VoiceSessionStore } from '../../../src/ai/agents/customer-calling/voice-session-store';
import { InMemoryAuditRepository } from '../../../src/audit/audit';
import { InMemoryProposalRepository } from '../../../src/proposals/proposal';
import { InMemoryCustomerRepository, createCustomer } from '../../../src/customers/customer';
import { InMemoryAppointmentRepository } from '../../../src/appointments/appointment';
import { InMemoryJobRepository } from '../../../src/jobs/job';
import { InMemoryFeatureFlagRepository } from '../../../src/flags/feature-flags';
import { createVoiceFlagResolver } from '../../../src/flags/voice-flags';
import type { PhoneLookupDeps } from '../../../src/ai/voice-turn/phone-lookup-surface';
import type { LLMGateway } from '../../../src/ai/gateway/gateway';
import type { SideEffect } from '../../../src/ai/agents/customer-calling/types';

const TENANT = 'tenant-1588-owner-line';
const CALL_SID = 'CA-1588-owner';
const OWNER_PHONE = '+15125550100';
/** D-026 — the phone actor caller-ID minted at establishment. */
const OWNER_ACTOR = 'user-1588-owner';

/** A classifier that never names the intent: the model is not how the owner reaches the overview. */
function unknownClassifier(): LLMGateway {
  return {
    complete: vi.fn(async () => ({
      content: JSON.stringify({ intentType: 'unknown', confidence: 0.2, extractedEntities: {} }),
      model: 'mock',
      provider: 'mock',
      tokenUsage: { input: 1, output: 1, total: 2 },
      latencyMs: 1,
    })),
  } as unknown as LLMGateway;
}

const stores: VoiceSessionStore[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.dispose();
});

function lookupLines(fx: SideEffect[]): string[] {
  return fx
    .filter(
      (f) => f.type === 'tts_play' && (f.payload as { source?: string }).source === 'lookup_skill',
    )
    .map((f) => String((f.payload as { text?: string }).text ?? ''));
}

describe('#1588 — the owner line hears the extended lookups by default', () => {
  it('"What\'s my day look like?" on a tenant with no flag rows is answered as the day overview', async () => {
    const store = new VoiceSessionStore({ startInterval: false });
    stores.push(store);
    const proposalRepo = new InMemoryProposalRepository();
    const customerRepo = new InMemoryCustomerRepository();
    const appointmentRepo = new InMemoryAppointmentRepository();
    const jobRepo = new InMemoryJobRepository();
    const owner = await createCustomer(
      { tenantId: TENANT, firstName: 'Sam', lastName: 'Owner', primaryPhone: OWNER_PHONE, createdBy: 'test' },
      customerRepo,
    );

    // Production shape: no pool (no tenant_feature_flags table) and an empty
    // platform flag repo — exactly what every tenant has today.
    const voiceFlags = createVoiceFlagResolver({
      tenantFeatureFlags: null,
      featureFlagRepo: new InMemoryFeatureFlagRepository(),
    });

    // `establishInboundSession`'s composition: extended lookups stay owner + flag gated.
    const ownerSession = true;
    const extendedIntents = (await voiceFlags.extendedIntentsEnabled(TENANT)) && ownerSession;
    const session = store.create(TENANT, 'telephony', {
      callSid: CALL_SID,
      ownerSession: true,
      ...(extendedIntents ? { extendedIntents: true } : {}),
    });
    session.machine.dispatch({
      type: 'incoming_call',
      callSid: CALL_SID,
      from: OWNER_PHONE,
      to: '+15125550999',
      tenantId: TENANT,
    });
    session.machine.dispatch({ type: 'greeted_ok' });
    session.machine.dispatch({ type: 'caller_known', customerId: owner.id });
    session.customerId = owner.id;
    session.callerPhone = OWNER_PHONE;
    session.actorUserId = OWNER_ACTOR;

    const lookups: PhoneLookupDeps = {
      answers: {
        resolveMemberRole: async (_tenantId, userId) => (userId === OWNER_ACTOR ? 'owner' : null),
      },
      shared: { jobRepo, appointmentRepo, customerRepo, proposalRepo },
    };
    const processor = createVoiceTurnProcessor({
      store,
      gateway: unknownClassifier(),
      businessName: 'Acme Plumbing',
      systemActorId: 'test-actor',
      auditRepo: new InMemoryAuditRepository(),
      proposalRepo,
      customerRepo,
      appointmentRepo,
      jobRepo,
      lookups,
    });

    const fx = await processor.speechTurn({
      session,
      speechResult: "What's my day look like?",
      callSid: CALL_SID,
      tenantId: TENANT,
    });

    // RV-010 copy for a clear day — the overview, not a reprompt and not a guess.
    expect(lookupLines(fx)).toEqual([
      'Your day is clear — no appointments today and nothing is waiting on you.',
    ]);
    // Read-only: a lookup never mints a proposal.
    expect(await proposalRepo.findByTenant(TENANT)).toHaveLength(0);
  });
});

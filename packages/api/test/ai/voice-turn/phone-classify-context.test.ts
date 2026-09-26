/**
 * #897 / #890 — ONE assembly of the phone classifier's context.
 *
 * The Gather adapter and the processor's speechTurn each assembled the
 * classify context inline, and the voice-quality text-mode driver assembled
 * its own — without the vertical section, the plan section or the
 * customer-protection flag (#897). `buildPhoneClassifyContext` is the one
 * seam all three now call, so the harness cannot drift from production again,
 * and it is where the call language (#890) reaches the classifier.
 */
import { describe, expect, it } from 'vitest';
import { VoiceSessionStore } from '../../../src/ai/agents/customer-calling/voice-session-store';
import { createVoiceTurnProcessor } from '../../../src/ai/voice-turn/create-voice-turn-processor';
import { createMockLLMGateway } from '../../../src/ai/gateway/factory';

function build() {
  const store = new VoiceSessionStore({ startInterval: false });
  const processor = createVoiceTurnProcessor({
    store,
    gateway: createMockLLMGateway().gateway,
    verticalPromptResolver: async () => 'Equipment: furnace, heat pump',
    callerPlanResolver: async () => 'Active plan: Gold maintenance',
  });
  return { store, processor };
}

describe('buildPhoneClassifyContext', () => {
  it('carries the vertical + plan sections, the caller profile, protection and the call language', async () => {
    const { store, processor } = build();
    const session = store.create('t-897', 'telephony', {
      callSid: 'CA-897',
      customerProtectionIntents: true,
    });
    session.customerId = 'cust-897';
    session.language = 'es';

    const ctx = await processor.buildPhoneClassifyContext(session, 't-897');

    expect(ctx).toMatchObject({
      tenantId: 't-897',
      sessionId: session.id,
      callSid: 'CA-897',
      verticalPromptSection: 'Equipment: furnace, heat pump',
      planPromptSection: 'Active plan: Gold maintenance',
      classifierProfile: 'caller',
      customerProtectionIntents: true,
      language: 'es',
    });
    expect(ctx.ownerSession).toBeUndefined();
    store.dispose();
  });

  it('omits the language on an English call so the request stays byte-identical', async () => {
    const { store, processor } = build();
    const session = store.create('t-897', 'telephony', { ownerSession: true });
    session.language = 'en';

    const ctx = await processor.buildPhoneClassifyContext(session, 't-897');

    expect(ctx.language).toBeUndefined();
    expect(ctx.classifierProfile).toBe('owner_line');
    expect(ctx.ownerSession).toBe(true);
    // No customer identity → no plan section.
    expect(ctx.planPromptSection).toBeUndefined();
    store.dispose();
  });
});

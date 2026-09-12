/**
 * 2.12 — B2B account context prompt wiring.
 *
 * `buildAccountContextPromptSection` (b2b-account-context.ts) had zero
 * production callers: the twilio adapter assembles and stashes
 * `session.b2bAccountContext` (twilio-adapter.ts:953) but nothing ever reads
 * it back into the caller-facing classify prompt, so a property manager's
 * call is classified with no account-context signal at all — same taxonomy,
 * same priority (none), as a one-off residential caller.
 *
 * Mirrors the established §3B vertical-wire test idiom
 * (intent-classifier-vertical-wire.test.ts): drive `classifyIntent` directly
 * and inspect the messages handed to the gateway.
 */
import { describe, expect, it, vi } from 'vitest';
import { classifyIntent } from '../../../src/ai/orchestration/intent-classifier';
import {
  buildAccountContextPromptSection,
  type B2bAccountContext,
} from '../../../src/ai/agents/customer-calling/b2b-account-context';

function makeGateway() {
  return {
    complete: vi.fn().mockResolvedValue({
      content: JSON.stringify({ intent: 'unknown', confidence: 0.2, entities: {} }),
      usage: { inputTokens: 1, outputTokens: 1 },
    }),
  };
}

function serializedMessagesFrom(gateway: ReturnType<typeof makeGateway>): string {
  const call = gateway.complete.mock.calls[0]?.[0];
  const messages = call?.messages ?? call;
  return JSON.stringify(messages);
}

const propertyManagerCtx: B2bAccountContext = {
  customerId: 'cust-pm-1',
  accountType: 'property_manager',
  priority: true,
  parentMissing: false,
  subAccounts: [],
};

describe('intent classifier — B2B account context prompt wiring (2.12)', () => {
  it('includes the account-context section in system messages when b2bAccountPromptSection is provided (property_manager)', async () => {
    const gateway = makeGateway();
    const b2bAccountPromptSection = buildAccountContextPromptSection(propertyManagerCtx);

    await classifyIntent(
      'my tenant says the water heater is leaking',
      {
        tenantId: '00000000-0000-4000-8000-000000000099',
        b2bAccountPromptSection,
      },
      gateway as never,
    );

    const serialized = serializedMessagesFrom(gateway);
    expect(serialized).toContain('property-management account');
    expect(serialized).toContain('PRIORITY');
  });

  it('omits the account-context section entirely when no b2bAccountPromptSection is supplied (residential / unmatched caller)', async () => {
    const gateway = makeGateway();

    await classifyIntent(
      'my sink is leaking',
      { tenantId: '00000000-0000-4000-8000-000000000099' },
      gateway as never,
    );

    const serialized = serializedMessagesFrom(gateway);
    expect(serialized).not.toContain('property-management account');
    expect(serialized).not.toContain('business account');
    expect(serialized).not.toContain('PRIORITY');
  });
});

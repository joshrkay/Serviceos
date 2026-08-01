/**
 * WS18b — on-call SMS consent capture: the recordSmsConsentFromVoice seam, the
 * processor mini-dialogue (grant/decline), and the ledger-driven allow/block.
 */
import { describe, it, expect, vi } from 'vitest';

import { recordSmsConsentFromVoice } from '../../src/voice/outbound-consent';
import { createVoiceTurnProcessor } from '../../src/ai/voice-turn';
import { SMS_CONSENT_DECLINE_FALLBACK } from '../../src/ai/voice-turn/create-voice-turn-processor';
import { VoiceSessionStore } from '../../src/ai/agents/customer-calling/voice-session-store';
import { InMemoryConsentEventRepository } from '../../src/compliance/consent-events';
import { standingContactRevocation } from '../../src/compliance/resolve-outbound-consent';
import { InMemoryCustomerRepository } from '../../src/customers/customer';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import type { Customer } from '../../src/customers/customer';
import type { LLMGateway } from '../../src/ai/gateway/gateway';
import type { SideEffect } from '../../src/ai/agents/customer-calling/types';

function customerRow(smsConsent = false): Customer {
  return {
    id: 'cust-1',
    tenantId: 't1',
    firstName: 'Ada',
    lastName: 'Lovelace',
    displayName: 'Ada Lovelace',
    primaryPhone: '+15125550100',
    smsConsent,
    preferredChannel: 'sms',
    isArchived: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as unknown as Customer;
}

function yesNoGateway(answer: 'yes' | 'no'): LLMGateway {
  return {
    complete: vi.fn().mockResolvedValue({
      content: JSON.stringify({ answer, reasoning: 't' }),
      model: 'm', provider: 'p', tokenUsage: { input: 1, output: 1, total: 2 }, latencyMs: 1,
    }),
  } as unknown as LLMGateway;
}

function lastTts(fx: SideEffect[]): string | undefined {
  return [...fx].reverse().find((e) => e.type === 'tts_play')?.payload.text as string | undefined;
}

describe('recordSmsConsentFromVoice seam', () => {
  it('appends a voice-source sms grant to the ledger AND flips customers.sms_consent', async () => {
    const consentLedger = new InMemoryConsentEventRepository();
    const customerRepo = new InMemoryCustomerRepository();
    await customerRepo.create(customerRow(false));

    const res = await recordSmsConsentFromVoice(
      { consentLedger, customerRepo },
      { tenantId: 't1', customerId: 'cust-1', phone: '+15125550100', voiceSessionId: 'vs-1' },
    );

    expect(res.smsConsentChanged).toBe(true);
    expect((await customerRepo.findById('t1', 'cust-1'))!.smsConsent).toBe(true);
    expect(consentLedger.rows).toHaveLength(1);
    expect(consentLedger.rows[0]).toMatchObject({
      kind: 'sms',
      state: 'granted',
      source: 'voice',
      voiceSessionId: 'vs-1',
    });
  });

  it('is a no-op flip when already granted, but the ledger still appends (append-only)', async () => {
    const consentLedger = new InMemoryConsentEventRepository();
    const customerRepo = new InMemoryCustomerRepository();
    await customerRepo.create(customerRow(true));

    const res = await recordSmsConsentFromVoice(
      { consentLedger, customerRepo },
      { tenantId: 't1', customerId: 'cust-1', phone: '+15125550100' },
    );
    expect(res.smsConsentChanged).toBe(false);
    expect(consentLedger.rows).toHaveLength(1);
  });
});

describe('processor mini-dialogue', () => {
  function makeProcessor(answer: 'yes' | 'no') {
    const store = new VoiceSessionStore({ startInterval: false });
    const consentEventRepo = new InMemoryConsentEventRepository();
    const customerRepo = new InMemoryCustomerRepository();
    const auditRepo = new InMemoryAuditRepository();
    const session = store.create('t1', 'telephony', { callSid: 'CA-c' });
    session.pendingConsentCapture = { customerId: 'cust-1', phone: '+15125550100' };
    const processor = createVoiceTurnProcessor({
      store, gateway: yesNoGateway(answer), businessName: 'Acme', systemActorId: 'sys',
      consentEventRepo, customerRepo, auditRepo,
    });
    return { store, consentEventRepo, customerRepo, auditRepo, session, processor };
  }

  it('grant → records consent (ledger + sms_consent) and clears the pending capture', async () => {
    const ctx = makeProcessor('yes');
    await ctx.customerRepo.create(customerRow(false));
    const fx = await ctx.processor.speechTurn({ session: ctx.session, speechResult: 'yes that is fine', callSid: 'CA-c', tenantId: 't1' });
    expect(ctx.consentEventRepo.rows).toHaveLength(1);
    expect(ctx.consentEventRepo.rows[0]).toMatchObject({ kind: 'sms', state: 'granted', source: 'voice' });
    expect((await ctx.customerRepo.findById('t1', 'cust-1'))!.smsConsent).toBe(true);
    expect(ctx.session.pendingConsentCapture).toBeUndefined();
    expect(lastTts(fx)).toContain('text shortly');
    // audit: sms_consent_captured granted
    const captured = ctx.auditRepo.getAll().find((e) => e.eventType === 'agent.calling.sms_consent_captured');
    expect(captured!.metadata).toMatchObject({ outcome: 'granted' });
  });

  it('decline → no ledger row, hands the send to the owner (fallback copy)', async () => {
    const ctx = makeProcessor('no');
    await ctx.customerRepo.create(customerRow(false));
    const fx = await ctx.processor.speechTurn({ session: ctx.session, speechResult: 'no thanks', callSid: 'CA-c', tenantId: 't1' });
    expect(ctx.consentEventRepo.rows).toHaveLength(0);
    expect((await ctx.customerRepo.findById('t1', 'cust-1'))!.smsConsent).toBe(false);
    expect(ctx.session.pendingConsentCapture).toBeUndefined();
    expect(lastTts(fx)).toBe(SMS_CONSENT_DECLINE_FALLBACK);
  });
});

describe('ledger allow-after-grant / block-after-STOP (D-017 asymmetry)', () => {
  it('a lone voice grant carries no standing revocation (contact allowed)', () => {
    expect(standingContactRevocation([{ kind: 'sms', state: 'granted' }]).revoked).toBe(false);
  });

  it('a subsequent STOP (newest) is a standing revocation that blocks contact', () => {
    // newest-first: revoked came after the grant.
    const revocation = standingContactRevocation([
      { kind: 'sms', state: 'revoked' },
      { kind: 'sms', state: 'granted' },
    ]);
    expect(revocation.revoked).toBe(true);
    expect(revocation.via).toBe('sms');
  });
});

import { describe, it, expect, vi } from 'vitest';
import {
  renderSpeedToLeadMessage,
  shouldSendSpeedToLead,
  sendSpeedToLeadResponse,
  DEFAULT_SPEED_TO_LEAD_TEMPLATE,
  type SpeedToLeadSender,
} from '../../src/leads/speed-to-lead';
import type { Lead } from '../../src/leads/lead';
import type { LeadSource } from '../../src/leads/enums';

function lead(partial: Partial<Lead> = {}): Lead {
  // sendSpeedToLeadResponse only reads id/tenantId/source/primaryPhone/firstName.
  return {
    id: partial.id ?? 'lead-1',
    tenantId: partial.tenantId ?? 't-1',
    firstName: partial.firstName ?? 'Dana',
    source: partial.source ?? 'web_form',
    primaryPhone: partial.primaryPhone ?? '+15125550123',
    ...partial,
  } as unknown as Lead;
}

describe('renderSpeedToLeadMessage', () => {
  it('substitutes first_name and business_name in the default template', () => {
    const out = renderSpeedToLeadMessage(null, { businessName: "Bob's Plumbing", firstName: 'Dana' });
    expect(out).toContain('Hi Dana');
    expect(out).toContain("Bob's Plumbing");
    expect(out).toContain('Reply STOP'); // opt-out line preserved
  });

  it('uses a custom template when provided', () => {
    const out = renderSpeedToLeadMessage('{business_name}: hey {first_name}!', {
      businessName: 'Ace',
      firstName: 'Sam',
    });
    expect(out).toBe('Ace: hey Sam!');
  });

  it('falls back gracefully when name / business are missing', () => {
    const out = renderSpeedToLeadMessage('{first_name} @ {business_name}', { businessName: '', firstName: '' });
    expect(out).toBe('there @ our team');
  });

  it('blank template falls back to the built-in default', () => {
    const out = renderSpeedToLeadMessage('   ', { businessName: 'X', firstName: 'Y' });
    expect(out).toBe(DEFAULT_SPEED_TO_LEAD_TEMPLATE.replace('{first_name}', 'Y').replace('{business_name}', 'X'));
  });
});

describe('shouldSendSpeedToLead', () => {
  it('eligible: enabled + eligible source + phone', () => {
    expect(shouldSendSpeedToLead({ enabled: true, source: 'web_form', hasPhone: true })).toEqual({ send: true });
    expect(shouldSendSpeedToLead({ enabled: true, source: 'marketplace', hasPhone: true })).toEqual({ send: true });
  });

  it('off by default: disabled blocks regardless of source/phone', () => {
    expect(shouldSendSpeedToLead({ enabled: false, source: 'web_form', hasPhone: true })).toEqual({
      send: false,
      reason: 'disabled',
    });
  });

  it('phone-originated leads are ineligible (voice agent already spoke)', () => {
    expect(shouldSendSpeedToLead({ enabled: true, source: 'phone_call' as LeadSource, hasPhone: true })).toEqual({
      send: false,
      reason: 'ineligible_source',
    });
  });

  it('no phone → cannot SMS', () => {
    expect(shouldSendSpeedToLead({ enabled: true, source: 'web_form', hasPhone: false })).toEqual({
      send: false,
      reason: 'no_phone',
    });
  });
});

describe('sendSpeedToLeadResponse', () => {
  it('sends a rendered SMS for an eligible lead', async () => {
    const send = vi.fn<Parameters<SpeedToLeadSender>, ReturnType<SpeedToLeadSender>>(async () => undefined);
    const onResult = vi.fn();
    const res = await sendSpeedToLeadResponse(
      { send, onResult },
      {
        lead: lead({ id: 'l9', tenantId: 't9', firstName: 'Dana', primaryPhone: '+15125550123' }),
        businessName: "Bob's Plumbing",
        settings: { speedToLeadEnabled: true },
      },
    );

    expect(res).toEqual({ sent: true, reason: 'sent' });
    expect(send).toHaveBeenCalledTimes(1);
    const arg = send.mock.calls[0][0];
    expect(arg).toMatchObject({ tenantId: 't9', leadId: 'l9', toPhone: '+15125550123' });
    expect(arg.body).toContain('Hi Dana');
    expect(onResult).toHaveBeenCalledWith({ leadId: 'l9', sent: true, reason: 'sent' });
  });

  it('does not send when disabled (default), and reports the skip', async () => {
    const send = vi.fn(async () => undefined);
    const res = await sendSpeedToLeadResponse(
      { send },
      { lead: lead(), businessName: 'X', settings: {} }, // enabled defaults to false
    );
    expect(res).toEqual({ sent: false, reason: 'disabled' });
    expect(send).not.toHaveBeenCalled();
  });

  it('is best-effort: a DNC/transport failure does not throw — returns sent:false', async () => {
    const send = vi.fn(async () => {
      throw new Error('dnc_blocked');
    });
    const res = await sendSpeedToLeadResponse(
      { send },
      { lead: lead(), businessName: 'X', settings: { speedToLeadEnabled: true } },
    );
    expect(res.sent).toBe(false);
    expect(res.reason).toBe('send_failed:dnc_blocked');
  });
});

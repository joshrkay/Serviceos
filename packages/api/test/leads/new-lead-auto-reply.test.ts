import { describe, it, expect, vi, beforeEach } from 'vitest';

const { notifyOwner } = vi.hoisted(() => ({ notifyOwner: vi.fn(async () => undefined) }));
vi.mock('../../src/notifications/owner-notifications-instance', () => ({ notifyOwner }));

import { createNewLeadAutoReply } from '../../src/leads/new-lead-auto-reply';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { InMemorySettingsRepository, type TenantSettings } from '../../src/settings/settings';
import { ConversationReplyError } from '../../src/conversations/reply-service';
import { LeadTextUnconfirmedError } from '../../src/leads/lead-conversation-sender';
import type { Lead } from '../../src/leads/lead';

const TENANT = 'tenant-1';

function lead(over: Partial<Lead> = {}): Lead {
  return {
    id: 'lead-1', tenantId: TENANT, firstName: 'Sandra', lastName: 'Wu', primaryPhone: '+15125550100',
    source: 'web_form', stage: 'new', createdBy: 'public:intake', createdAt: new Date(), updatedAt: new Date(),
    ...over,
  } as Lead;
}

async function setup(opts: { enabled?: boolean; send?: ReturnType<typeof vi.fn> | null; template?: string } = {}) {
  const settingsRepo = new InMemorySettingsRepository();
  await settingsRepo.create({
    tenantId: TENANT,
    businessName: 'Cool Air',
    speedToLeadEnabled: opts.enabled ?? true,
    speedToLeadTemplate: opts.template,
  } as unknown as TenantSettings);
  const auditRepo = new InMemoryAuditRepository();
  const send = opts.send === null ? undefined : (opts.send ?? vi.fn(async () => undefined));
  const reply = createNewLeadAutoReply({ settingsRepo, auditRepo, ...(send ? { send } : {}) });
  const audits = async () => auditRepo.findByEntity(TENANT, 'lead', 'lead-1');
  return { reply, send, audits };
}

describe('createNewLeadAutoReply (#1738)', () => {
  beforeEach(() => notifyOwner.mockClear());

  it('texts a new, consenting lead and audits the send', async () => {
    const { reply, send, audits } = await setup();
    expect(await reply({ lead: lead(), outcome: 'created', smsConsent: true })).toBe('sent');
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: TENANT, leadId: 'lead-1', toPhone: '+15125550100',
      body: expect.stringContaining('Hi Sandra, thanks for reaching out to Cool Air'),
    }));
    expect((await audits()).map((e) => [e.eventType, e.metadata])).toEqual([
      ['lead.speed_to_lead', { source: 'web_form', sent: true, outcome: 'sent' }],
    ]);
    expect(notifyOwner).not.toHaveBeenCalled();
  });

  it("uses the owner's own template", async () => {
    const { reply, send } = await setup({ template: 'Hey {first_name}, {business_name} here.' });
    await reply({ lead: lead(), outcome: 'created', smsConsent: true });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ body: 'Hey Sandra, Cool Air here.' }));
  });

  it('does nothing, and records nothing, while the owner has it off', async () => {
    const { reply, send, audits } = await setup({ enabled: false });
    expect(await reply({ lead: lead(), outcome: 'created', smsConsent: true })).toBe('disabled');
    expect(send).not.toHaveBeenCalled();
    expect(await audits()).toEqual([]);
  });

  it('never texts without the ticked box, and says so on the lead', async () => {
    const { reply, send, audits } = await setup();
    expect(await reply({ lead: lead(), outcome: 'created', smsConsent: false })).toBe('no_sms_consent');
    expect(send).not.toHaveBeenCalled();
    expect((await audits())[0].metadata).toMatchObject({ sent: false, outcome: 'no_sms_consent' });
    expect(notifyOwner).not.toHaveBeenCalled();
  });

  it.each(['attached', 'reopened'] as const)('does not re-text a repeat submission (%s)', async (outcome) => {
    const { reply, send } = await setup();
    expect(await reply({ lead: lead(), outcome, smsConsent: true })).toBe('existing_lead');
    expect(send).not.toHaveBeenCalled();
  });

  it('skips a lead with no phone (email-only form)', async () => {
    const { reply, send } = await setup();
    expect(await reply({ lead: lead({ primaryPhone: undefined }), outcome: 'created', smsConsent: true })).toBe('no_phone');
    expect(send).not.toHaveBeenCalled();
  });

  it('records an opted-out number as dnc_blocked and does not page the owner', async () => {
    const send = vi.fn(async () => {
      throw new ConversationReplyError('dnc_blocked', 'Recipient has opted out (STOP/DNC); reply not sent');
    });
    const { reply, audits } = await setup({ send });
    expect(await reply({ lead: lead(), outcome: 'created', smsConsent: true })).toBe('send_failed:dnc_blocked');
    expect((await audits())[0].metadata).toMatchObject({ sent: false, outcome: 'send_failed:dnc_blocked' });
    expect(notifyOwner).not.toHaveBeenCalled();
  });

  it('tells the owner to call when an owed text fails to send', async () => {
    const send = vi.fn(async () => {
      throw new Error('twilio 500');
    });
    const { reply } = await setup({ send });
    expect(await reply({ lead: lead(), outcome: 'created', smsConsent: true })).toBe('send_failed:twilio 500');
    expect(notifyOwner).toHaveBeenCalledWith(TENANT, 'escalation', {
      reason: "Sandra Wu asked for a text back, but the automatic reply didn't go out. Give them a call.",
    });
  });

  it('asks the owner to check before calling when the send could not be confirmed', async () => {
    const send = vi.fn(async () => {
      throw new LeadTextUnconfirmedError(new Error('db down'));
    });
    const { reply, audits } = await setup({ send });
    expect(await reply({ lead: lead(), outcome: 'created', smsConsent: true })).toBe('send_failed:unconfirmed');
    expect((await audits())[0].metadata).toMatchObject({ sent: false, outcome: 'send_failed:unconfirmed' });
    expect(notifyOwner).toHaveBeenCalledWith(TENANT, 'escalation', {
      reason:
        "Sandra Wu asked for a text back. The automatic reply may have gone out, but it couldn't be confirmed. Check their messages before you call.",
    });
  });

  it('tells the owner to call when SMS is not configured at all', async () => {
    const { reply, audits } = await setup({ send: null });
    expect(await reply({ lead: lead(), outcome: 'created', smsConsent: true })).toBe('unavailable');
    expect((await audits())[0].metadata).toMatchObject({ outcome: 'unavailable' });
    expect(notifyOwner).toHaveBeenCalledTimes(1);
  });

  it('never throws: a settings outage means no text', async () => {
    const send = vi.fn();
    const reply = createNewLeadAutoReply({
      settingsRepo: { findByTenant: async () => { throw new Error('db down'); } },
      auditRepo: new InMemoryAuditRepository(),
      send,
    });
    expect(await reply({ lead: lead(), outcome: 'created', smsConsent: true })).toBe('settings_unavailable');
    expect(send).not.toHaveBeenCalled();
  });
});

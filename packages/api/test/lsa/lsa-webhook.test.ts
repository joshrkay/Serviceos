import { describe, it, expect, beforeEach, vi } from 'vitest';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { InMemoryLeadRepository } from '../../src/leads/in-memory-lead';
import { InMemoryWebhookEventRepository } from '../../src/webhooks/in-memory-webhook-event';
import { createWebhookSignature } from '../../src/webhooks/webhook-handler';
import { InMemoryLsaIntegrationRepository } from '../../src/lsa/lsa-integration';
import { handleLsaLeadEvent, type LsaWebhookDeps } from '../../src/lsa/lsa-webhook';

const TENANT = '11111111-1111-4111-8111-111111111111';

function body(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    lead_id: 'lsa-1',
    lead_type: 'message',
    customer_name: 'Jane Doe',
    phone: '+16025550142',
    message: 'AC not cooling',
    category: 'hvac',
    sms_consent: true,
    campaign_id: 'cmp-9',
    gclid: 'g-123',
    ...over,
  });
}

describe('handleLsaLeadEvent (#1738)', () => {
  let integrationRepo: InMemoryLsaIntegrationRepository;
  let leadRepo: InMemoryLeadRepository;
  let auditRepo: InMemoryAuditRepository;
  let webhookRepo: InMemoryWebhookEventRepository;
  let send: ReturnType<typeof vi.fn>;
  let deps: LsaWebhookDeps;
  let secret: string;

  beforeEach(async () => {
    integrationRepo = new InMemoryLsaIntegrationRepository();
    leadRepo = new InMemoryLeadRepository();
    auditRepo = new InMemoryAuditRepository();
    webhookRepo = new InMemoryWebhookEventRepository();
    send = vi.fn().mockResolvedValue(undefined);
    deps = {
      integrationRepo,
      leadRepo,
      auditRepo,
      webhookRepo,
      settingsRepo: { findByTenant: async () => ({ businessName: 'Cool Air' }) as never },
      sendSpeedToLead: send,
    };
    secret = (await integrationRepo.link({ tenantId: TENANT, linkedBy: 'owner-1' })).webhookSecret;
  });

  const signed = (raw: string, s = secret) => createWebhookSignature(raw, s);

  it('403s a tenant that is not linked (feature off by default)', async () => {
    const raw = body();
    const res = await handleLsaLeadEvent(deps, {
      tenantId: '22222222-2222-4222-8222-222222222222',
      rawBody: raw,
      signatureHeader: signed(raw),
    });
    expect(res.status).toBe(403);
  });

  it('403s a disabled link', async () => {
    await integrationRepo.update(TENANT, { enabled: false });
    const raw = body();
    const res = await handleLsaLeadEvent(deps, { tenantId: TENANT, rawBody: raw, signatureHeader: signed(raw) });
    expect(res.status).toBe(403);
  });

  it('fails closed on a bad signature, a stale timestamp, and no credential', async () => {
    const raw = body();
    expect((await handleLsaLeadEvent(deps, { tenantId: TENANT, rawBody: raw, signatureHeader: signed(raw, 'wrong') })).status).toBe(403);
    const stale = createWebhookSignature(raw, secret, Math.floor(Date.now() / 1000) - 3600);
    expect((await handleLsaLeadEvent(deps, { tenantId: TENANT, rawBody: raw, signatureHeader: stale })).status).toBe(403);
    expect((await handleLsaLeadEvent(deps, { tenantId: TENANT, rawBody: raw })).status).toBe(403);
    expect(await leadRepo.findByTenant(TENANT)).toHaveLength(0);
  });

  it('accepts a google_key body credential and strips it from the payload', async () => {
    const raw = body({ google_key: secret });
    const res = await handleLsaLeadEvent(deps, { tenantId: TENANT, rawBody: raw });
    expect(res.status).toBe(200);
    expect((await handleLsaLeadEvent(deps, { tenantId: TENANT, rawBody: body({ lead_id: 'x', google_key: 'nope' }) })).status).toBe(403);
  });

  it('400s invalid JSON and invalid payloads (after verification)', async () => {
    const bad = '{not json';
    expect((await handleLsaLeadEvent(deps, { tenantId: TENANT, rawBody: bad, signatureHeader: signed(bad) })).status).toBe(400);
    const noId = JSON.stringify({ customer_name: 'x' });
    expect((await handleLsaLeadEvent(deps, { tenantId: TENANT, rawBody: noId, signatureHeader: signed(noId) })).status).toBe(400);
  });

  it('creates a marketplace Lead with Google attribution and audits it', async () => {
    const raw = body();
    const res = await handleLsaLeadEvent(deps, { tenantId: TENANT, rawBody: raw, signatureHeader: signed(raw) });
    expect(res.status).toBe(200);
    const [lead] = await leadRepo.findByTenant(TENANT);
    expect(lead).toMatchObject({
      source: 'marketplace',
      sourceDetail: 'Google Local Services Ads',
      firstName: 'Jane',
      lastName: 'Doe',
      utmSource: 'google',
      utmMedium: 'lsa',
      utmCampaign: 'cmp-9',
      notes: 'AC not cooling',
    });
    expect(lead.attribution).toMatchObject({ lsa_lead_id: 'lsa-1', gclid: 'g-123', lsa_category: 'hvac' });
    const events = await auditRepo.findByEntity(TENANT, 'lead', lead.id);
    const types = events.map((e) => e.eventType);
    expect(types).toContain('lead.created');
    expect(types).toContain('lsa_lead.received');
    expect(JSON.stringify(events)).not.toContain('+16025550142');
  });

  it('is idempotent by lead id: a replay creates nothing and never re-texts', async () => {
    await integrationRepo.update(TENANT, { autoRespond: true });
    const raw = body();
    const sig = signed(raw);
    const first = await handleLsaLeadEvent(deps, { tenantId: TENANT, rawBody: raw, signatureHeader: sig });
    const replay = await handleLsaLeadEvent(deps, { tenantId: TENANT, rawBody: raw, signatureHeader: sig });
    expect(first.body.speedToLead).toBe('sent');
    expect(replay.body).toMatchObject({ received: true, duplicate: true });
    expect(await leadRepo.findByTenant(TENANT)).toHaveLength(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('reprocesses an unprocessed receipt without a second lead or second text', async () => {
    await integrationRepo.update(TENANT, { autoRespond: true });
    const raw = body();
    // An earlier delivery died after the receipt: receipt present, never marked processed.
    await webhookRepo.recordReceipt('lsa', `${TENANT}:lsa-1`, 'lead.received', {});
    const res = await handleLsaLeadEvent(deps, { tenantId: TENANT, rawBody: raw, signatureHeader: signed(raw) });
    expect(res.status).toBe(200);
    expect(await leadRepo.findByTenant(TENANT)).toHaveLength(1);
    // A second retry now short-circuits.
    const again = await handleLsaLeadEvent(deps, { tenantId: TENANT, rawBody: raw, signatureHeader: signed(raw) });
    expect(again.body.duplicate).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
  });

  describe('speed-to-lead', () => {
    it('does not text by default (owner has not opted in)', async () => {
      const raw = body();
      const res = await handleLsaLeadEvent(deps, { tenantId: TENANT, rawBody: raw, signatureHeader: signed(raw) });
      expect(res.body.speedToLead).toBe('disabled');
      expect(send).not.toHaveBeenCalled();
    });

    it('texts a message lead once opted in, with the business name', async () => {
      await integrationRepo.update(TENANT, { autoRespond: true });
      const raw = body();
      await handleLsaLeadEvent(deps, { tenantId: TENANT, rawBody: raw, signatureHeader: signed(raw) });
      expect(send).toHaveBeenCalledTimes(1);
      expect(send.mock.calls[0][0]).toMatchObject({ tenantId: TENANT, toPhone: '+16025550142' });
      expect(send.mock.calls[0][0].body).toContain('Cool Air');
      expect((await integrationRepo.listRecent(TENANT, 5))[0].speedToLeadOutcome).toBe('sent');
    });

    it('does not text without an asserted SMS consent', async () => {
      await integrationRepo.update(TENANT, { autoRespond: true });
      const raw = body({ sms_consent: undefined });
      const res = await handleLsaLeadEvent(deps, { tenantId: TENANT, rawBody: raw, signatureHeader: signed(raw) });
      expect(res.body.speedToLead).toBe('no_sms_consent');
      const raw2 = body({ lead_id: 'lsa-2', phone: '+16025550199', sms_consent: false });
      const res2 = await handleLsaLeadEvent(deps, { tenantId: TENANT, rawBody: raw2, signatureHeader: signed(raw2) });
      expect(res2.body.speedToLead).toBe('no_sms_consent');
      expect(send).not.toHaveBeenCalled();
    });

    it('skips phone-call leads (the caller was already spoken to)', async () => {
      await integrationRepo.update(TENANT, { autoRespond: true });
      const raw = body({ lead_type: 'phone_call' });
      const res = await handleLsaLeadEvent(deps, { tenantId: TENANT, rawBody: raw, signatureHeader: signed(raw) });
      expect(res.body.speedToLead).toBe('phone_lead');
      expect(send).not.toHaveBeenCalled();
    });

    it('records a consent/DNC refusal as the outcome and still keeps the lead', async () => {
      await integrationRepo.update(TENANT, { autoRespond: true });
      send.mockRejectedValue(new Error("This customer hasn't agreed to receive texts."));
      const raw = body();
      const res = await handleLsaLeadEvent(deps, { tenantId: TENANT, rawBody: raw, signatureHeader: signed(raw) });
      expect(res.status).toBe(200);
      expect(String(res.body.speedToLead)).toMatch(/^send_failed:/);
      expect(await leadRepo.findByTenant(TENANT)).toHaveLength(1);
    });

    it('reports unavailable when no consent-gated sender is wired', async () => {
      await integrationRepo.update(TENANT, { autoRespond: true });
      const raw = body();
      const res = await handleLsaLeadEvent(
        { ...deps, sendSpeedToLead: undefined },
        { tenantId: TENANT, rawBody: raw, signatureHeader: signed(raw) },
      );
      expect(res.body.speedToLead).toBe('unavailable');
    });
  });

  it('keeps an anonymous lead (no name, no phone) visible to the owner', async () => {
    const raw = JSON.stringify({ lead_id: 'anon-1', lead_type: 'message' });
    const res = await handleLsaLeadEvent(deps, { tenantId: TENANT, rawBody: raw, signatureHeader: signed(raw) });
    expect(res.status).toBe(200);
    expect((await leadRepo.findByTenant(TENANT))[0].companyName).toBe('Google LSA lead');
  });
});

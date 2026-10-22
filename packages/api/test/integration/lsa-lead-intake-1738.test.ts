/**
 * #1738 — Google Local Services Ads lead intake against real Postgres.
 *
 * Pins the real columns of migrations 342 (lsa_integrations) and 343
 * (lsa_leads) — the Pg repository and the webhook handler are exercised end to
 * end with the real lead, audit and webhook-receipt repositories.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgLsaIntegrationRepository } from '../../src/lsa/pg-lsa-integration';
import { handleLsaLeadEvent } from '../../src/lsa/lsa-webhook';
import { PgLeadRepository } from '../../src/leads/pg-lead';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { PgWebhookEventRepository } from '../../src/webhooks/pg-webhook-event';
import { createWebhookSignature } from '../../src/webhooks/webhook-handler';

const KEY = 'a'.repeat(64);

describe('Postgres integration — LSA lead intake (#1738)', () => {
  let pool: Pool;
  let repo: PgLsaIntegrationRepository;
  let tenant: { tenantId: string; userId: string };
  let other: { tenantId: string; userId: string };

  beforeAll(async () => {
    pool = await getSharedTestDb();
    repo = new PgLsaIntegrationRepository(pool, KEY);
    tenant = await createTestTenant(pool);
    other = await createTestTenant(pool);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('has the expected columns, with the feature off by default', async () => {
    const cols = await pool.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_name IN ('lsa_integrations', 'lsa_leads')`,
    );
    const names = new Set(cols.rows.map((r) => `${r.table_name}.${r.column_name}`));
    for (const c of [
      'lsa_integrations.enabled', 'lsa_integrations.auto_respond', 'lsa_integrations.webhook_secret_enc',
      'lsa_integrations.secret_hint', 'lsa_integrations.account_id', 'lsa_integrations.linked_by',
      'lsa_leads.external_lead_id', 'lsa_leads.lead_id', 'lsa_leads.lead_type', 'lsa_leads.received_at',
      'lsa_leads.speed_to_lead_outcome', 'lsa_leads.disposition', 'lsa_leads.disposition_reported_at',
    ]) {
      expect(names, c).toContain(c);
    }
    const defaults = await pool.query<{ column_name: string; column_default: string }>(
      `SELECT column_name, column_default FROM information_schema.columns
        WHERE table_name = 'lsa_integrations' AND column_name IN ('enabled', 'auto_respond')`,
    );
    expect(defaults.rows.every((r) => r.column_default === 'false')).toBe(true);
  });

  it('links with an encrypted secret that round-trips, rotates, and updates/unlinks', async () => {
    expect(await repo.get(tenant.tenantId)).toBeNull();
    const { integration, webhookSecret } = await repo.link({ tenantId: tenant.tenantId, linkedBy: tenant.userId, accountId: 'acct-7' });
    expect(integration).toMatchObject({ enabled: true, autoRespond: false, accountId: 'acct-7' });
    expect(await repo.getWebhookSecret(tenant.tenantId)).toBe(webhookSecret);

    const stored = await pool.query(`SELECT webhook_secret_enc FROM lsa_integrations WHERE tenant_id = $1`, [tenant.tenantId]);
    expect(stored.rows[0].webhook_secret_enc).not.toContain(webhookSecret);

    const rotated = await repo.link({ tenantId: tenant.tenantId, linkedBy: tenant.userId });
    expect(rotated.webhookSecret).not.toBe(webhookSecret);
    expect((await repo.get(tenant.tenantId))?.accountId).toBe('acct-7');

    expect((await repo.update(tenant.tenantId, { autoRespond: true }))?.autoRespond).toBe(true);
    expect((await repo.update(tenant.tenantId, { accountId: null }))?.accountId).toBeUndefined();
  });

  it('isolates tenants (RLS)', async () => {
    expect(await repo.get(other.tenantId)).toBeNull();
    expect(await repo.getWebhookSecret(other.tenantId)).toBeNull();
  });

  it('ingests a signed delivery end to end, idempotently, with attribution persisted', async () => {
    const leadRepo = new PgLeadRepository(pool);
    const auditRepo = new PgAuditRepository(pool);
    const secret = (await repo.link({ tenantId: tenant.tenantId, linkedBy: tenant.userId })).webhookSecret;
    const deps = {
      integrationRepo: repo,
      leadRepo,
      auditRepo,
      webhookRepo: new PgWebhookEventRepository(pool),
      settingsRepo: { findByTenant: async () => null },
    };
    const raw = JSON.stringify({
      lead_id: 'lsa-int-1', lead_type: 'message', customer_name: 'Rita Gomez',
      phone: '(602) 555-0188', category: 'plumber', campaign_id: 'cmp-1', gclid: 'gcl-1',
    });
    const req = { tenantId: tenant.tenantId, rawBody: raw, signatureHeader: createWebhookSignature(raw, secret) };

    const first = await handleLsaLeadEvent(deps, req);
    const replay = await handleLsaLeadEvent(deps, req);
    expect(first.status).toBe(200);
    expect(replay.body).toMatchObject({ duplicate: true });

    const leads = (await leadRepo.findByTenant(tenant.tenantId)).filter((l) => l.source === 'marketplace');
    expect(leads).toHaveLength(1);
    expect(leads[0]).toMatchObject({ utmSource: 'google', utmMedium: 'lsa', utmCampaign: 'cmp-1', sourceDetail: 'Google Local Services Ads' });
    expect(leads[0].attribution).toMatchObject({ lsa_lead_id: 'lsa-int-1', gclid: 'gcl-1' });

    const rows = await repo.listRecent(tenant.tenantId, 10);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ externalLeadId: 'lsa-int-1', leadId: leads[0].id, speedToLeadOutcome: 'no_sms_consent' });

    const audit = await pool.query(
      `SELECT event_type FROM audit_events WHERE tenant_id = $1 AND entity_id = $2`,
      [tenant.tenantId, leads[0].id],
    );
    expect(audit.rows.map((r) => r.event_type)).toContain('lsa_lead.received');

    await repo.markDisposition(tenant.tenantId, 'lsa-int-1', 'booked', false);
    expect((await repo.findLeadByLeadId(tenant.tenantId, leads[0].id))?.disposition).toBe('booked');

    expect((await repo.recordLead({ tenantId: tenant.tenantId, externalLeadId: 'lsa-int-1', leadId: leads[0].id, leadType: 'message' })).inserted).toBe(false);
  });
});

/**
 * The owner's cell on the "pick, don't build" draft, against real Postgres:
 * the migration-313 column and its CHECK, the repository under RLS, and the
 * full path first screen (or PUT /owner-phone) -> approve -> stored
 * onboarding_tenant_settings proposal -> the REAL execution handler ->
 * tenant_settings.owner_phone, the value the emergency/patch-through lane reads.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import express, { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb, RLS_APP_ROLE } from './shared';
import { createOnboardingDraftRouter } from '../../src/routes/onboarding-draft';
import {
  DraftNotFoundError,
  DraftVersionConflictError,
  PgOnboardingDraftRepository,
} from '../../src/onboarding/draft/repository';
import { assembleTypicalShop } from '../../src/onboarding/choices/assemble';
import { PgRegionalPriceTierRepository } from '../../src/onboarding/choices/price-tiers';
import { PgProposalRepository } from '../../src/proposals/pg-proposal';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { PgSettingsRepository } from '../../src/settings/pg-settings';
import { PgPackActivationRepository } from '../../src/settings/pg-pack-activation';
import { PgCatalogItemRepository } from '../../src/catalog/pg-catalog-item';
import { PgEstimateTemplateRepository } from '../../src/templates/pg-estimate-template';
import { OnboardingTenantSettingsExecutionHandler } from '../../src/proposals/execution/onboarding-handlers';
import { createSettingsOwnerPhoneResolver } from '../../src/settings/settings';
import { withTenantTransaction } from '../../src/middleware/tenant-context';
import type { AuthenticatedRequest } from '../../src/auth/clerk';

const BASE = '/api/onboarding/draft';
const CREATE = { packId: 'plumbing', businessName: 'Walsh Plumbing', ownerFirstName: 'Jenna', clientTimezone: 'America/New_York' };

describe('onboarding draft owner cell (real DB)', () => {
  let pool: Pool;
  let app: express.Express;
  let draftRepo: PgOnboardingDraftRepository;
  let proposalRepo: PgProposalRepository;
  let settingsRepo: PgSettingsRepository;
  let auditRepo: PgAuditRepository;
  let tenant: { tenantId: string; userId: string };

  beforeAll(async () => {
    pool = await getSharedTestDb();
    draftRepo = new PgOnboardingDraftRepository(pool);
    proposalRepo = new PgProposalRepository(pool);
    settingsRepo = new PgSettingsRepository(pool);
    auditRepo = new PgAuditRepository(pool);
    const tierRepo = new PgRegionalPriceTierRepository(pool);
    await tierRepo.upsert('plumbing', 'CLE', { standard: { tripFeeCents: 8900, hourlyRateCents: 15000 }, premium: { tripFeeCents: 12900, hourlyRateCents: 18500 } }, 'test');
    app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as AuthenticatedRequest).auth = { userId: tenant.userId, sessionId: 's', tenantId: tenant.tenantId, role: 'owner' };
      next();
    });
    app.use('/api', withTenantTransaction(pool));
    app.use(BASE, createOnboardingDraftRouter({ draftRepo, tierRepo, proposalRepo, auditRepo }));
  });

  beforeEach(async () => {
    tenant = await createTestTenant(pool);
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM regional_price_tiers WHERE trade = 'plumbing' AND metro_code = 'CLE' AND source = 'test'`);
    await closeSharedTestDb();
  });

  const rawDraft = async (tenantId = tenant.tenantId) =>
    (await pool.query<{ owner_phone: string | null; version: number }>('SELECT owner_phone, version FROM onboarding_drafts WHERE tenant_id = $1', [tenantId])).rows[0];

  async function assembled() {
    return assembleTypicalShop(new PgRegionalPriceTierRepository(pool), {
      packId: 'plumbing',
      businessName: 'Walsh Plumbing',
      ownerFirstName: 'Jenna',
      metro: { kind: 'metro', metroCode: 'CLE', name: 'Cleveland' },
    });
  }

  async function createRecord(extra: { ownerPhone?: string | null } = {}) {
    return {
      packId: 'plumbing',
      trade: 'plumbing',
      metroCode: 'CLE',
      metroName: 'Cleveland',
      businessName: 'Walsh Plumbing',
      ownerFirstName: 'Jenna',
      clientTimezone: 'America/New_York',
      assembled: await assembled(),
      ...extra,
    };
  }

  function handler() {
    const catalogRepo = new PgCatalogItemRepository(pool);
    const templateRepo = new PgEstimateTemplateRepository(pool);
    return new OnboardingTenantSettingsExecutionHandler(settingsRepo, new PgPackActivationRepository(pool), auditRepo, { catalogRepo, templateRepo }, pool);
  }

  /** Executes the stored onboarding_tenant_settings proposal through the real handler. */
  async function executeStoredSettingsProposal() {
    const stored = (await proposalRepo.findByTenant(tenant.tenantId)).find((p) => p.proposalType === 'onboarding_tenant_settings')!;
    expect(stored.status).toBe('approved');
    return handler().execute(stored, { tenantId: tenant.tenantId, executedBy: tenant.userId, executedByRole: 'owner' });
  }

  const ownerPhoneInSettings = async () =>
    (await pool.query<{ owner_phone: string | null }>('SELECT owner_phone FROM tenant_settings WHERE tenant_id = $1', [tenant.tenantId])).rows[0]?.owner_phone ?? null;

  describe('column and repository', () => {
    it('owner_phone is a nullable text column guarded by an E.164 CHECK', async () => {
      const col = await pool.query(
        `SELECT data_type, is_nullable FROM information_schema.columns WHERE table_name = 'onboarding_drafts' AND column_name = 'owner_phone'`,
      );
      expect(col.rows[0]).toEqual({ data_type: 'text', is_nullable: 'YES' });
      await draftRepo.create(tenant.tenantId, await createRecord());
      await expect(pool.query(`UPDATE onboarding_drafts SET owner_phone = '555' WHERE tenant_id = $1`, [tenant.tenantId])).rejects.toThrow(/owner_phone/);
      await pool.query(`UPDATE onboarding_drafts SET owner_phone = '+12165550142' WHERE tenant_id = $1`, [tenant.tenantId]);
      await pool.query(`UPDATE onboarding_drafts SET owner_phone = NULL WHERE tenant_id = $1`, [tenant.tenantId]);
    });

    it('round-trips through create, getForTenant and setOwnerPhone, and a create without a cell leaves NULL', async () => {
      const created = await draftRepo.create(tenant.tenantId, await createRecord({ ownerPhone: '+12165550142' }));
      expect(created.ownerPhone).toBe('+12165550142');
      expect(await rawDraft()).toEqual({ owner_phone: '+12165550142', version: 1 });
      expect((await draftRepo.getForTenant(tenant.tenantId))!.ownerPhone).toBe('+12165550142');

      const updated = await draftRepo.setOwnerPhone(tenant.tenantId, '+12165550199', created.version);
      expect(updated.ownerPhone).toBe('+12165550199');
      expect(updated.version).toBe(2);
      expect(await rawDraft()).toEqual({ owner_phone: '+12165550199', version: 2 });

      const other = await createTestTenant(pool);
      const bare = await draftRepo.create(other.tenantId, await createRecord());
      expect(bare.ownerPhone).toBeNull();
      expect(await rawDraft(other.tenantId)).toEqual({ owner_phone: null, version: 1 });
    });

    it('a stale version, a missing draft and a non-canonical value are refused without a write', async () => {
      await expect(draftRepo.setOwnerPhone(tenant.tenantId, '+12165550199', 1)).rejects.toBeInstanceOf(DraftNotFoundError);
      const d = await draftRepo.create(tenant.tenantId, await createRecord());
      await expect(draftRepo.setOwnerPhone(tenant.tenantId, '+12165550199', 7)).rejects.toBeInstanceOf(DraftVersionConflictError);
      await expect(draftRepo.setOwnerPhone(tenant.tenantId, '(216) 555-0199', d.version)).rejects.toThrow();
      expect(await rawDraft()).toEqual({ owner_phone: null, version: 1 });
    });

    it('is tenant-isolated: another tenant cannot read or write the number, in the repo or at the RLS role', async () => {
      const other = await createTestTenant(pool);
      await draftRepo.create(tenant.tenantId, await createRecord({ ownerPhone: '+12165550142' }));
      expect(await draftRepo.getForTenant(other.tenantId)).toBeNull();
      await expect(draftRepo.setOwnerPhone(other.tenantId, '+12165550199', 1)).rejects.toBeInstanceOf(DraftNotFoundError);

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SET LOCAL ROLE ${RLS_APP_ROLE}`);
        await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [other.tenantId]);
        const seen = await client.query('SELECT owner_phone FROM onboarding_drafts');
        expect(seen.rows).toEqual([]);
        const targeted = await client.query('SELECT owner_phone FROM onboarding_drafts WHERE tenant_id = $1', [tenant.tenantId]);
        expect(targeted.rows).toEqual([]);
        const touched = await client.query(`UPDATE onboarding_drafts SET owner_phone = '+12165550199' WHERE tenant_id = $1`, [tenant.tenantId]);
        expect(touched.rowCount).toBe(0);
        await client.query('ROLLBACK');
      } finally {
        client.release();
      }
      expect(await rawDraft()).toEqual({ owner_phone: '+12165550142', version: 1 });
    });

    it('two setOwnerPhone calls on the same version: exactly one wins', async () => {
      const d = await draftRepo.create(tenant.tenantId, await createRecord());
      const settled = await Promise.allSettled([
        draftRepo.setOwnerPhone(tenant.tenantId, '+12165550111', d.version),
        draftRepo.setOwnerPhone(tenant.tenantId, '+12165550122', d.version),
      ]);
      const won = settled.filter((s) => s.status === 'fulfilled');
      const lost = settled.filter((s) => s.status === 'rejected');
      expect(won).toHaveLength(1);
      expect(lost).toHaveLength(1);
      expect((lost[0] as PromiseRejectedResult).reason).toBeInstanceOf(DraftVersionConflictError);
      const winner = (won[0] as PromiseFulfilledResult<{ ownerPhone: string }>).value.ownerPhone;
      expect(await rawDraft()).toEqual({ owner_phone: winner, version: 2 });
    });
  });

  describe('HTTP flow to tenant_settings', () => {
    it('a cell on the first screen: draft has it, approve carries it, the real handler writes it, and the owner-phone resolver reads it', async () => {
      const created = await request(app).post(BASE).send({ ...CREATE, phone: '(216) 555-0142' });
      expect(created.status).toBe(201);
      expect(created.body.draft.ownerPhone).toBe('+12165550142');
      expect(created.body.draft.metroCode).toBe('CLE');
      expect(await rawDraft()).toEqual({ owner_phone: '+12165550142', version: 1 });

      const approved = await request(app).post(`${BASE}/approve`).send({});
      expect(approved.status).toBe(200);
      const stored = await pool.query(`SELECT payload->>'ownerPhone' AS p FROM proposals WHERE tenant_id = $1 AND proposal_type = 'onboarding_tenant_settings'`, [tenant.tenantId]);
      expect(stored.rows[0].p).toBe('+12165550142');
      expect(await ownerPhoneInSettings()).toBeNull();

      const result = await executeStoredSettingsProposal();
      expect(result.success, JSON.stringify(result)).toBe(true);
      expect(await ownerPhoneInSettings()).toBe('+12165550142');
      expect(await createSettingsOwnerPhoneResolver(settingsRepo)(tenant.tenantId)).toBe('+12165550142');
      const identity = await pool.query(`SELECT metadata FROM audit_events WHERE tenant_id = $1 AND event_type = 'tenant.identity_set'`, [tenant.tenantId]);
      expect(identity.rows).toHaveLength(1);
      expect(identity.rows[0].metadata.ownerPhoneSet).toBe(true);
    });

    it('no cell: approve succeeds with no gate, and the handler leaves a stored tenant_settings.owner_phone untouched', async () => {
      await pool.query(
        `INSERT INTO tenant_settings (id, tenant_id, business_name, estimate_prefix, invoice_prefix, next_estimate_number, next_invoice_number, default_payment_term_days, owner_phone)
         VALUES (gen_random_uuid(), $1, 'Walsh Plumbing', 'EST-', 'INV-', 1001, 1001, 30, '+12165550199')`,
        [tenant.tenantId],
      );
      await request(app).post(BASE).send(CREATE);
      const approved = await request(app).post(`${BASE}/approve`).send({});
      expect(approved.status).toBe(200);
      const stored = await pool.query(`SELECT (payload ? 'ownerPhone') AS has FROM proposals WHERE tenant_id = $1 AND proposal_type = 'onboarding_tenant_settings'`, [tenant.tenantId]);
      expect(stored.rows[0].has).toBe(false);

      const result = await executeStoredSettingsProposal();
      expect(result.success, JSON.stringify(result)).toBe(true);
      expect(await ownerPhoneInSettings()).toBe('+12165550199');
      const identity = await pool.query(`SELECT metadata FROM audit_events WHERE tenant_id = $1 AND event_type = 'tenant.identity_set'`, [tenant.tenantId]);
      expect(identity.rows[0].metadata).not.toHaveProperty('ownerPhoneSet');
    });

    it('no cell and no settings row yet: owner_phone stays NULL after execution', async () => {
      await request(app).post(BASE).send(CREATE);
      expect((await request(app).post(`${BASE}/approve`).send({})).status).toBe(200);
      expect((await executeStoredSettingsProposal()).success).toBe(true);
      expect(await ownerPhoneInSettings()).toBeNull();
    });

    it('a cell added with PUT /owner-phone before approval is carried and written; a later PUT replaces the first-screen one', async () => {
      const created = await request(app).post(BASE).send(CREATE);
      const put = await request(app).put(`${BASE}/owner-phone`).send({ ownerPhone: '216-555-0177', version: created.body.draft.version });
      expect(put.status).toBe(200);
      expect(put.body.draft.version).toBe(created.body.draft.version + 1);
      expect(put.body.draft.ownerPhone).toBe('+12165550177');
      expect((await request(app).post(`${BASE}/approve`).send({})).status).toBe(200);
      expect((await executeStoredSettingsProposal()).success).toBe(true);
      expect(await ownerPhoneInSettings()).toBe('+12165550177');
    });

    it('PUT replaces a first-screen cell, and the handler writes the replacement', async () => {
      const created = await request(app).post(BASE).send({ ...CREATE, phone: '(216) 555-0142' });
      const put = await request(app).put(`${BASE}/owner-phone`).send({ ownerPhone: '(216) 555-0188', version: created.body.draft.version });
      expect(put.status).toBe(200);
      expect((await request(app).post(`${BASE}/approve`).send({})).status).toBe(200);
      expect((await executeStoredSettingsProposal()).success).toBe(true);
      expect(await ownerPhoneInSettings()).toBe('+12165550188');
    });

    it('PUT on an approved draft is a 409 DRAFT_APPROVED and changes nothing', async () => {
      const created = await request(app).post(BASE).send({ ...CREATE, phone: '(216) 555-0142' });
      const approved = await request(app).post(`${BASE}/approve`).send({});
      const before = await rawDraft();
      const res = await request(app).put(`${BASE}/owner-phone`).send({ ownerPhone: '2165550199', version: created.body.draft.version });
      expect(res.status).toBe(409);
      expect(res.body.message).toMatch(/^DRAFT_APPROVED/);
      expect(approved.status).toBe(200);
      expect(await rawDraft()).toEqual(before);
      expect(before.owner_phone).toBe('+12165550142');
    });

    it('PUT with a stale version is a 409 VERSION_CONFLICT and changes nothing', async () => {
      const created = await request(app).post(BASE).send(CREATE);
      await request(app).put(`${BASE}/owner-phone`).send({ ownerPhone: '2165550111', version: created.body.draft.version });
      const res = await request(app).put(`${BASE}/owner-phone`).send({ ownerPhone: '2165550122', version: created.body.draft.version });
      expect(res.status).toBe(409);
      expect(res.body.message).toMatch(/^VERSION_CONFLICT/);
      expect(await rawDraft()).toEqual({ owner_phone: '+12165550111', version: 2 });
    });

    it('a value that does not normalise is a 400 naming the field, on PUT and on create (which makes no draft)', async () => {
      const created = await request(app).post(BASE).send(CREATE);
      const put = await request(app).put(`${BASE}/owner-phone`).send({ ownerPhone: '12345', version: created.body.draft.version });
      expect(put.status).toBe(400);
      expect(put.body.details.issues[0].path).toBe('ownerPhone');
      expect(await rawDraft()).toEqual({ owner_phone: null, version: 1 });

      const other = await createTestTenant(pool);
      tenant = other;
      const bad = await request(app).post(BASE).send({ ...CREATE, phone: 'abcdefgh' });
      expect(bad.status).toBe(400);
      expect(bad.body.details.issues[0].path).toBe('phone');
      const n = await pool.query(`SELECT count(*)::int AS n FROM onboarding_drafts WHERE tenant_id = $1`, [tenant.tenantId]);
      expect(n.rows[0].n).toBe(0);
      const audits = await pool.query(`SELECT count(*)::int AS n FROM audit_events WHERE tenant_id = $1 AND event_type = 'onboarding.draft_created'`, [tenant.tenantId]);
      expect(audits.rows[0].n).toBe(0);
    });

    it('audits the write and never puts the full number in audit metadata', async () => {
      const created = await request(app).post(BASE).send({ ...CREATE, phone: '(216) 555-0142' });
      const put = await request(app).put(`${BASE}/owner-phone`).send({ ownerPhone: '(216) 555-0177', version: created.body.draft.version });
      const rows = await pool.query(
        `SELECT event_type, entity_type, entity_id, metadata FROM audit_events WHERE tenant_id = $1 AND event_type IN ('onboarding.owner_phone_set', 'onboarding.draft_created')`,
        [tenant.tenantId],
      );
      const set = rows.rows.find((r) => r.event_type === 'onboarding.owner_phone_set');
      expect(set).toMatchObject({ entity_type: 'onboarding_draft', entity_id: put.body.draft.id });
      expect(rows.rows.find((r) => r.event_type === 'onboarding.draft_created').metadata.hasOwnerPhone).toBe(true);
      const leaked = await pool.query(
        `SELECT count(*)::int AS n FROM audit_events WHERE tenant_id = $1 AND (metadata::text LIKE '%2165550142%' OR metadata::text LIKE '%2165550177%')`,
        [tenant.tenantId],
      );
      expect(leaked.rows[0].n).toBe(0);
    });
  });
});

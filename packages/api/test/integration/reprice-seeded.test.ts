/**
 * Postgres integration — the seeded-price baseline (migration 324, U6).
 *
 * A re-run of setup may move a price only while the owner has not touched it.
 * That is decided per row from positive provenance the seeder writes in the
 * same statement as the row: `catalog_items.seed_key` +
 * `seeded_unit_price_cents` on the pack's two headline items, and
 * `seededUnitPriceCents` + `seededCatalogItemId` on the template lines seeded
 * from them. Every owner price save clears the item's baseline in the same
 * UPDATE as the price, even at the amount it already holds; an owner template
 * save drops the line keys. A null baseline is the owner's, for good.
 *
 * This file pins the real columns and every writer through the production
 * code: the seeder over the Pg repositories, `PUT /api/catalog/items/:id`,
 * `PUT /api/templates/:id`, the approved `update_catalog_item` handler and
 * the learned-price port. Never by writing the columns directly.
 *
 * Run: cd packages/api && RLS_RUNTIME_ROLE=true EXTERNAL_TEST_DB_URL=… \
 *   npx vitest run --config vitest.integration.config.mts test/integration/reprice-seeded.test.ts
 */
import express, { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeSharedTestDb, createTestTenant, getSharedTestDb, type TestTenant } from './shared';
import type { AuthenticatedRequest } from '../../src/auth/clerk';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { createCatalogItem } from '../../src/catalog/catalog-item';
import { PgCatalogItemRepository } from '../../src/catalog/pg-catalog-item';
import { PgEstimateTemplateRepository } from '../../src/templates/pg-estimate-template';
import { createCatalogItemsRouter } from '../../src/routes/catalog-items';
import { createTemplateRouter } from '../../src/routes/templates';
import { seedPackDefaults } from '../../src/packs/seed-pack-defaults';
import { UpdateCatalogItemExecutionHandler } from '../../src/proposals/execution/update-catalog-item-handler';
import { createProposal } from '../../src/proposals/proposal';
import { createPgConfigPorts } from '../../src/learning/corrections/pg-config-ports';
import { PgSettingsRepository } from '../../src/settings/pg-settings';

interface ItemRow {
  id: string;
  name: string;
  unit_price_cents: number;
  seed_key: string | null;
  seeded_unit_price_cents: number | null;
}

interface Line {
  description: string;
  defaultUnitPriceCents: number;
  seededUnitPriceCents?: number;
  seededCatalogItemId?: string;
}

describe('Postgres integration — seeded-price baseline (324)', () => {
  let pool: Pool;
  let catalogRepo: PgCatalogItemRepository;
  let templateRepo: PgEstimateTemplateRepository;
  let auditRepo: PgAuditRepository;
  let actor: TestTenant;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    catalogRepo = new PgCatalogItemRepository(pool);
    templateRepo = new PgEstimateTemplateRepository(pool);
    auditRepo = new PgAuditRepository(pool);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  /** The production catalog + templates routers, acting as the tenant's owner. */
  function ownerApi(): express.Express {
    const app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as AuthenticatedRequest).auth = {
        userId: actor.userId,
        sessionId: 'sess-reprice',
        tenantId: actor.tenantId,
        role: 'owner',
      };
      next();
    });
    app.use('/api/catalog/items', createCatalogItemsRouter(catalogRepo, auditRepo));
    app.use('/api/templates', createTemplateRouter(templateRepo, auditRepo));
    return app;
  }

  async function items(tenantId: string): Promise<ItemRow[]> {
    const { rows } = await pool.query<ItemRow>(
      `SELECT id, name, unit_price_cents, seed_key, seeded_unit_price_cents
         FROM catalog_items WHERE tenant_id = $1 ORDER BY name`,
      [tenantId],
    );
    return rows;
  }

  async function item(tenantId: string, name: string): Promise<ItemRow> {
    const row = (await items(tenantId)).find((r) => r.name === name);
    if (!row) throw new Error(`no catalog item named ${name}`);
    return row;
  }

  async function templateLines(tenantId: string, name: string): Promise<{ id: string; lines: Line[] }> {
    const { rows } = await pool.query<{ id: string; line_item_templates: Line[] }>(
      `SELECT id, line_item_templates FROM estimate_templates WHERE tenant_id = $1 AND name = $2`,
      [tenantId, name],
    );
    if (rows.length !== 1) throw new Error(`expected one template named ${name}, found ${rows.length}`);
    return { id: rows[0].id, lines: rows[0].line_item_templates };
  }

  async function seedHvac(tenantId: string, pricing?: { tripFeeCents: number; hourlyRateCents: number }) {
    return seedPackDefaults({ tenantId, packId: 'hvac', pricing }, { catalogRepo, templateRepo });
  }

  describe('real columns', () => {
    it('catalog_items carries a nullable seed_key (text) and seeded_unit_price_cents (integer)', async () => {
      const { rows } = await pool.query<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null }>(
        `SELECT column_name, data_type, is_nullable, column_default
           FROM information_schema.columns
          WHERE table_name = 'catalog_items' AND column_name IN ('seed_key', 'seeded_unit_price_cents')
          ORDER BY column_name`,
      );
      expect(rows).toEqual([
        { column_name: 'seed_key', data_type: 'text', is_nullable: 'YES', column_default: null },
        { column_name: 'seeded_unit_price_cents', data_type: 'integer', is_nullable: 'YES', column_default: null },
      ]);
    });

    it('one live headline item per (tenant, seed_key); an archived duplicate is allowed', async () => {
      const t = await createTestTenant(pool);
      const insert = (name: string, archived: boolean) =>
        pool.query(
          `INSERT INTO catalog_items (tenant_id, name, category, unit, unit_price_cents, product_service_type, seed_key, seeded_unit_price_cents, archived_at)
           VALUES ($1, $2, 'Labor', 'hour', 12500, 'service', 'hvac:labor', 12500, $3)`,
          [t.tenantId, name, archived ? new Date() : null],
        );
      await insert('HVAC Labor', false);
      await expect(insert('HVAC Labor (old)', true)).resolves.toBeDefined();
      await expect(insert('HVAC Labor (dup)', false)).rejects.toMatchObject({ code: '23505' });

      // Another tenant may hold the same seed key.
      const other = await createTestTenant(pool);
      await expect(
        pool.query(
          `INSERT INTO catalog_items (tenant_id, name, category, unit, unit_price_cents, product_service_type, seed_key)
           VALUES ($1, 'HVAC Labor', 'Labor', 'hour', 12500, 'service', 'hvac:labor')`,
          [other.tenantId],
        ),
      ).resolves.toBeDefined();
    });

    it('tenant_settings carries the seven forwarding columns with their types and defaults', async () => {
      const { rows } = await pool.query<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null }>(
        `SELECT column_name, data_type, is_nullable, column_default
           FROM information_schema.columns
          WHERE table_name = 'tenant_settings' AND column_name LIKE 'forwarding%'
          ORDER BY column_name`,
      );
      expect(rows).toEqual([
        { column_name: 'forwarding_carrier', data_type: 'text', is_nullable: 'YES', column_default: null },
        { column_name: 'forwarding_confirmed_at', data_type: 'timestamp with time zone', is_nullable: 'YES', column_default: null },
        { column_name: 'forwarding_generation', data_type: 'integer', is_nullable: 'NO', column_default: '0' },
        { column_name: 'forwarding_probe_at', data_type: 'timestamp with time zone', is_nullable: 'YES', column_default: null },
        { column_name: 'forwarding_probe_generation', data_type: 'integer', is_nullable: 'YES', column_default: null },
        { column_name: 'forwarding_source_number', data_type: 'text', is_nullable: 'YES', column_default: null },
        { column_name: 'forwarding_verified_at', data_type: 'timestamp with time zone', is_nullable: 'YES', column_default: null },
      ]);
    });

    it('the carrier CHECK takes the four carriers and refuses anything else', async () => {
      const t = await createTestTenant(pool);
      await pool.query(`INSERT INTO tenant_settings (tenant_id, business_name) VALUES ($1, 'Forwarding Co')`, [t.tenantId]);
      const { rows } = await pool.query<{ forwarding_generation: number }>(
        `SELECT forwarding_generation FROM tenant_settings WHERE tenant_id = $1`,
        [t.tenantId],
      );
      expect(rows[0].forwarding_generation).toBe(0);
      for (const carrier of ['verizon', 'att', 'tmobile', 'other']) {
        await pool.query(`UPDATE tenant_settings SET forwarding_carrier = $2 WHERE tenant_id = $1`, [t.tenantId, carrier]);
      }
      await expect(
        pool.query(`UPDATE tenant_settings SET forwarding_carrier = 'sprint' WHERE tenant_id = $1`, [t.tenantId]),
      ).rejects.toMatchObject({ code: '23514' });
    });
  });

  describe('the seeder writes provenance on the headline rows only', () => {
    it('a pack seeded now stamps seed_key and the baseline on exactly the visit and labor items', async () => {
      const t = await createTestTenant(pool);
      await seedHvac(t.tenantId, { tripFeeCents: 9900, hourlyRateCents: 11000 });

      const stamped = (await items(t.tenantId)).filter((r) => r.seed_key !== null || r.seeded_unit_price_cents !== null);
      expect(stamped.map((r) => [r.name, r.seed_key, r.unit_price_cents, r.seeded_unit_price_cents])).toEqual([
        ['HVAC Diagnostic Fee', 'hvac:visit', 9900, 9900],
        ['HVAC Labor', 'hvac:labor', 11000, 11000],
      ]);
    });

    it('template lines priced at a headline price carry the baseline and the link to that item; no other line does', async () => {
      const t = await createTestTenant(pool);
      await seedHvac(t.tenantId, { tripFeeCents: 9900, hourlyRateCents: 11000 });
      const visit = await item(t.tenantId, 'HVAC Diagnostic Fee');
      const labor = await item(t.tenantId, 'HVAC Labor');

      const repair = await templateLines(t.tenantId, 'Standard AC Repair');
      expect(repair.lines.map((l) => [l.description, l.defaultUnitPriceCents, l.seededUnitPriceCents, l.seededCatalogItemId])).toEqual([
        ['Diagnostic + trip fee', 9900, 9900, visit.id],
        ['AC repair labor', 11000, 11000, labor.id],
      ]);
      const thermostat = await templateLines(t.tenantId, 'Thermostat Install');
      expect(thermostat.lines[0]).toMatchObject({ seededUnitPriceCents: 11000, seededCatalogItemId: labor.id });

      for (const name of ['Seasonal Tune-Up', 'After-Hours Emergency Service']) {
        const { lines } = await templateLines(t.tenantId, name);
        for (const line of lines) {
          expect(line, `${name}: ${line.description}`).not.toHaveProperty('seededUnitPriceCents');
          expect(line, `${name}: ${line.description}`).not.toHaveProperty('seededCatalogItemId');
        }
      }
    });

    it('a headline item skipped because the owner already has that name leaves its lines keyless', async () => {
      const t = await createTestTenant(pool);
      // The owner's own "HVAC Labor", made before the pack: no seed key.
      await catalogRepo.create(
        createCatalogItem({ tenantId: t.tenantId, name: 'HVAC Labor', category: 'Labor', unit: 'hour', unitPriceCents: 13000 }),
      );
      await seedHvac(t.tenantId);

      const ownerLabor = await item(t.tenantId, 'HVAC Labor');
      expect(ownerLabor).toMatchObject({ unit_price_cents: 13000, seed_key: null, seeded_unit_price_cents: null });
      const visit = await item(t.tenantId, 'HVAC Diagnostic Fee');
      expect(visit.seed_key).toBe('hvac:visit');

      const repair = await templateLines(t.tenantId, 'Standard AC Repair');
      expect(repair.lines[0]).toMatchObject({ seededCatalogItemId: visit.id });
      expect(repair.lines[1]).not.toHaveProperty('seededCatalogItemId');
      expect(repair.lines[1]).not.toHaveProperty('seededUnitPriceCents');
    });

    it('a renamed headline item is still found by its seed key: a re-activation neither duplicates it nor fails', async () => {
      const t = await createTestTenant(pool);
      await seedHvac(t.tenantId);
      const labor = await item(t.tenantId, 'HVAC Labor');
      actor = t;
      const res = await request(ownerApi()).put(`/api/catalog/items/${labor.id}`).send({ name: 'Shop Labor' });
      expect(res.status).toBe(200);
      // A template the owner deleted comes back on the next activation.
      const repair = await templateLines(t.tenantId, 'Standard AC Repair');
      await pool.query(`DELETE FROM estimate_templates WHERE id = $1`, [repair.id]);

      await seedHvac(t.tenantId);

      const laborRows = (await items(t.tenantId)).filter((r) => r.seed_key === 'hvac:labor');
      expect(laborRows.map((r) => r.name)).toEqual(['Shop Labor']);
      expect((await items(t.tenantId)).some((r) => r.name === 'HVAC Labor')).toBe(false);
      const reseeded = await templateLines(t.tenantId, 'Standard AC Repair');
      expect(reseeded.lines[1]).toMatchObject({ seededUnitPriceCents: 12500, seededCatalogItemId: labor.id });
    });
  });

  describe('an owner price save ends repricing in the same statement as the price', () => {
    async function seededTenant(): Promise<{ t: TestTenant; labor: ItemRow }> {
      const t = await createTestTenant(pool);
      await seedHvac(t.tenantId, { tripFeeCents: 9900, hourlyRateCents: 11000 });
      actor = t;
      const labor = await item(t.tenantId, 'HVAC Labor');
      // The seeder's baseline is there before the owner touches anything.
      expect(labor).toMatchObject({ unit_price_cents: 11000, seed_key: 'hvac:labor', seeded_unit_price_cents: 11000 });
      return { t, labor };
    }

    it('(d) PUT with a new price clears the baseline', async () => {
      const { t, labor } = await seededTenant();
      const res = await request(ownerApi()).put(`/api/catalog/items/${labor.id}`).send({ unitPriceCents: 11500 });
      expect(res.status).toBe(200);
      expect(await item(t.tenantId, 'HVAC Labor')).toMatchObject({
        unit_price_cents: 11500,
        seed_key: 'hvac:labor',
        seeded_unit_price_cents: null,
      });
    });

    it('(d) PUT at the seeded amount still clears the baseline', async () => {
      const { t, labor } = await seededTenant();
      const res = await request(ownerApi()).put(`/api/catalog/items/${labor.id}`).send({ unitPriceCents: 11000 });
      expect(res.status).toBe(200);
      expect(await item(t.tenantId, 'HVAC Labor')).toMatchObject({ unit_price_cents: 11000, seeded_unit_price_cents: null });
    });

    it('(d) editing to a new price and back to the seeded one leaves the baseline cleared', async () => {
      const { t, labor } = await seededTenant();
      const api = ownerApi();
      expect((await request(api).put(`/api/catalog/items/${labor.id}`).send({ unitPriceCents: 11500 })).status).toBe(200);
      expect((await request(api).put(`/api/catalog/items/${labor.id}`).send({ unitPriceCents: 11000 })).status).toBe(200);
      expect(await item(t.tenantId, 'HVAC Labor')).toMatchObject({ unit_price_cents: 11000, seeded_unit_price_cents: null });
    });

    it('(e) a rename with no price keeps the baseline; the same rename with a price clears it', async () => {
      const { t, labor } = await seededTenant();
      const api = ownerApi();
      expect((await request(api).put(`/api/catalog/items/${labor.id}`).send({ name: 'Shop Labor' })).status).toBe(200);
      expect(await item(t.tenantId, 'Shop Labor')).toMatchObject({ seed_key: 'hvac:labor', seeded_unit_price_cents: 11000 });

      // The Price Book form resends the price with every save.
      const res = await request(api)
        .put(`/api/catalog/items/${labor.id}`)
        .send({ name: 'Shop Labor Rate', unitPriceCents: 11000, unit: 'hour', category: 'Labor', description: '' });
      expect(res.status).toBe(200);
      expect(await item(t.tenantId, 'Shop Labor Rate')).toMatchObject({ seed_key: 'hvac:labor', seeded_unit_price_cents: null });
    });

    it('the catalog API never exposes the provenance columns', async () => {
      const { labor } = await seededTenant();
      const api = ownerApi();
      const list = await request(api).get('/api/catalog/items');
      expect(list.status).toBe(200);
      const listed = JSON.stringify(list.body);
      expect(listed).toContain(labor.id);
      expect(listed).not.toContain('seedKey');
      expect(listed).not.toContain('seededUnitPriceCents');
      const put = await request(api).put(`/api/catalog/items/${labor.id}`).send({ name: 'Shop Labor' });
      expect(put.status).toBe(200);
      expect(put.body).not.toHaveProperty('seedKey');
      expect(put.body).not.toHaveProperty('seededUnitPriceCents');
    });

    it('(h) the approved update_catalog_item proposal clears the baseline', async () => {
      const { t, labor } = await seededTenant();
      const proposal = createProposal({
        tenantId: t.tenantId,
        proposalType: 'update_catalog_item',
        payload: { catalogItemId: labor.id, proposedUnitPriceCents: 11000 },
        summary: 'Set HVAC Labor to $110',
        createdBy: t.userId,
      });
      const handler = new UpdateCatalogItemExecutionHandler(catalogRepo, auditRepo);
      const result = await handler.execute(proposal, { tenantId: t.tenantId, executedBy: t.userId });
      expect(result.success).toBe(true);
      expect(await item(t.tenantId, 'HVAC Labor')).toMatchObject({ unit_price_cents: 11000, seeded_unit_price_cents: null });
    });

    it('(h) the learned-price port clears the baseline', async () => {
      const { t, labor } = await seededTenant();
      const ports = createPgConfigPorts({ settingsRepo: new PgSettingsRepository(pool), catalogRepo });
      await ports.setSkuPriceCents(t.tenantId, labor.id, 11000);
      expect(await item(t.tenantId, 'HVAC Labor')).toMatchObject({ unit_price_cents: 11000, seeded_unit_price_cents: null });
    });

    it('(b) PUT /api/templates/:id with lines stores them without the seed keys; a name-only PUT keeps them', async () => {
      const { t } = await seededTenant();
      const api = ownerApi();
      const repair = await templateLines(t.tenantId, 'Standard AC Repair');

      // A name-only save leaves the lines (and their keys) alone.
      expect((await request(api).put(`/api/templates/${repair.id}`).send({ name: 'AC Repair' })).status).toBe(200);
      const renamed = await templateLines(t.tenantId, 'AC Repair');
      expect(renamed.lines[1]).toHaveProperty('seededCatalogItemId');

      // Resending the very same lines (keys included) still makes them the owner's.
      const res = await request(api).put(`/api/templates/${repair.id}`).send({ lineItemTemplates: renamed.lines });
      expect(res.status).toBe(200);
      const saved = await templateLines(t.tenantId, 'AC Repair');
      expect(saved.lines.map((l) => l.defaultUnitPriceCents)).toEqual([9900, 11000]);
      for (const line of saved.lines) {
        expect(line).not.toHaveProperty('seededUnitPriceCents');
        expect(line).not.toHaveProperty('seededCatalogItemId');
      }
    });
  });
});

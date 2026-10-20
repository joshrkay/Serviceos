/**
 * Postgres integration — the migration corpus must replay cleanly over a
 * POPULATED database (the next deploy).
 *
 * The runner has no applied-migrations ledger: every deploy's Railway
 * `preDeployCommand` (db/migrate.ts → applyMigrations) re-executes the WHOLE
 * corpus, in registry order, as one implicit transaction. So an early
 * migration that builds a constraint which a LATER migration drops or relaxes
 * re-builds the stricter object over live data on every deploy, BEFORE the
 * later migration gets to drop it again. The first row that is legal under the
 * final schema but illegal under the early copy fails that build, the whole
 * corpus rolls back, and every later deploy (hotfixes included) is blocked
 * until someone hand-edits the database.
 *
 * Everything else in the integration suite migrates an EMPTY database exactly
 * once (global-setup.ts), so it can never see this class. This file applies
 * the corpus to a dedicated fresh database (deploy N), writes rows that are
 * legal under the final schema (production traffic), applies the corpus again
 * (deploy N+1), and requires it to succeed.
 */
import { createHmac } from 'crypto';
import express from 'express';
import request from 'supertest';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { applyMigrations } from '../../src/db/migrate';
import { createWebhookRouter } from '../../src/webhooks/routes';
import { InMemoryWebhookRepository } from '../../src/webhooks/webhook-handler';
import { PgTenantRepository } from '../../src/auth/pg-tenant';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import type { AppConfig } from '../../src/shared/config';
import { createUsersRouter } from '../../src/routes/users';
import type { AuthenticatedRequest } from '../../src/auth/clerk';
import { PgCallMeBackRepository } from '../../src/voice/call-me-back/pg-call-me-back';
import { PgVoiceApprovalPinLockAlertRepository } from '../../src/settings/pg-voice-approval-pin-lock-alert';
import { createPinLockAlertRetryWorker } from '../../src/workers/pin-lock-alert-retry';
import { PgUserRepository } from '../../src/users/pg-user';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { PgJobTimelineRepository } from '../../src/jobs/pg-job-lifecycle';
import { transitionJobStatus } from '../../src/jobs/job-lifecycle';
import { runReviewRequestSweep } from '../../src/workers/review-request-worker';
import type { QueueMessage } from '../../src/queues/queue';
import { createLogger } from '../../src/logging/logger';
import { packHeadlinePrices } from '../../src/packs/seed-pack-defaults';
import { createTestTenant, ensureRlsRuntimeRole, type TestTenant } from './shared';

const silentLogger = createLogger({ service: 'test', environment: 'test', level: 'error' });
const HOUR_MS = 60 * 60 * 1000;

/**
 * Every invariant the corpus RELAXED after first creating it: a row the final
 * schema accepts but an earlier (stricter) migration's copy would reject. The
 * class scan behind this list (2026-10-13) covered every CREATE UNIQUE INDEX,
 * ADD CONSTRAINT … UNIQUE/EXCLUDE/CHECK/FOREIGN KEY, SET/DROP NOT NULL, ALTER
 * COLUMN TYPE and DROP INDEX/CONSTRAINT in the corpus.
 *
 * When a migration relaxes an invariant (drops or widens a constraint, drops
 * NOT NULL, widens a type), add its row here. If the early copy is replayed in
 * a form that re-validates existing rows, the "next deploy" test below fails.
 */
interface RelaxedInvariant {
  /** The final-schema-legal row this entry writes. */
  row: string;
  /** Migration whose stricter copy would reject the row → the one that relaxed it. */
  strictAt: string;
  relaxedBy: string;
  seed: (db: Pool, tenant: TestTenant) => Promise<void>;
}

async function insertProposal(db: Pool, tenant: TestTenant, status = 'draft'): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO proposals (tenant_id, proposal_type, created_by, status)
     VALUES ($1, 'create_customer', $2, $3) RETURNING id`,
    [tenant.tenantId, tenant.userId, status],
  );
  return rows[0].id;
}

async function insertJob(db: Pool, tenant: TestTenant): Promise<string> {
  const n = crypto.randomUUID().slice(0, 8);
  const customer = await db.query<{ id: string }>(
    `INSERT INTO customers (tenant_id, display_name, created_by)
     VALUES ($1, 'Replay Customer', $2) RETURNING id`,
    [tenant.tenantId, tenant.userId],
  );
  const location = await db.query<{ id: string }>(
    `INSERT INTO service_locations (tenant_id, customer_id, street1, city, state, postal_code)
     VALUES ($1, $2, '1 Main St', 'Austin', 'TX', '78701') RETURNING id`,
    [tenant.tenantId, customer.rows[0].id],
  );
  const job = await db.query<{ id: string }>(
    `INSERT INTO jobs (tenant_id, customer_id, location_id, job_number, summary, created_by)
     VALUES ($1, $2, $3, $4, 'Replay job', $5) RETURNING id`,
    [tenant.tenantId, customer.rows[0].id, location.rows[0].id, `J-${n}`, tenant.userId],
  );
  return job.rows[0].id;
}

async function insertInvoice(db: Pool, tenant: TestTenant): Promise<string> {
  const jobId = await insertJob(db, tenant);
  const invoice = await db.query<{ id: string }>(
    `INSERT INTO invoices (tenant_id, job_id, invoice_number, created_by)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [tenant.tenantId, jobId, `INV-${crypto.randomUUID().slice(0, 8)}`, tenant.userId],
  );
  return invoice.rows[0].id;
}

const RELAXED_SINCE: RelaxedInvariant[] = [
  {
    row: 'two call_me_back_tasks for one session with different reasons',
    strictAt: '154_call_me_back_session_idempotency (unique tenant_id, session_id)',
    relaxedBy: '268_call_me_back_session_reason_idempotency',
    seed: async (db, t) => {
      const sessionId = `sess-${crypto.randomUUID()}`;
      await db.query(
        `INSERT INTO call_me_back_tasks (tenant_id, session_id, caller_phone, reason)
         VALUES ($1, $2, '+15125550100', 'transfer_failed'),
                ($1, $2, '+15125550100', 'emergency_unanswered')`,
        [t.tenantId, sessionId],
      );
    },
  },
  {
    row: "proposal with status 'executing'",
    strictAt: '039_proposals_v2 (proposals_status_check)',
    relaxedBy: '072_add_executing_status',
    seed: async (db, t) => {
      await insertProposal(db, t, 'executing');
    },
  },
  {
    row: 'proposal with NULL idempotency_key and a non-UUID claimed_by',
    strictAt: '027_create_proposals (NOT NULL) / 072 (claimed_by UUID)',
    relaxedBy: '039_proposals_v2 (DROP NOT NULL) / 215_proposals_claimed_by_text',
    seed: async (db, t) => {
      await db.query(
        `INSERT INTO proposals (tenant_id, proposal_type, created_by, status, idempotency_key, claimed_by)
         VALUES ($1, 'create_customer', $2, 'approved', NULL, 'execution-worker:replay')`,
        [t.tenantId, t.userId],
      );
    },
  },
  {
    row: "lead with source 'sms'",
    strictAt: '069_extend_leads_source_check',
    relaxedBy: '191_extend_leads_source_check_sms',
    seed: async (db, t) => {
      await db.query(
        `INSERT INTO leads (id, tenant_id, source, stage, created_by)
         VALUES (gen_random_uuid(), $1, 'sms', 'new', $2)`,
        [t.tenantId, t.userId],
      );
    },
  },
  {
    row: 'message_dispatches with every entity_type added after the first named check',
    strictAt: '092_extend_dispatch_entity_types (and 125/164/190/269)',
    relaxedBy: '125 → 164 → 190 → 269 → 270_dispatch_entity_custom_message',
    seed: async (db, t) => {
      for (const entityType of [
        'appointment_reschedule',
        'appointment_cancel',
        'payment_receipt',
        'invoice_overdue',
        'appointment_en_route',
        'daily_digest',
        'conversation_reply',
        'portal_session',
        'custom_message',
      ]) {
        await db.query(
          `INSERT INTO message_dispatches (tenant_id, entity_type, entity_id, channel, recipient, provider)
           VALUES ($1, $2, gen_random_uuid(), 'sms', '+15125550100', 'twilio')`,
          [t.tenantId, entityType],
        );
      }
    },
  },
  {
    row: "payment with payment_method 'card_present'",
    strictAt: '133_payments_reversal_tracking (payments_payment_method_check)',
    relaxedBy: '288_payments_card_present_method',
    seed: async (db, t) => {
      const invoiceId = await insertInvoice(db, t);
      await db.query(
        `INSERT INTO payments (tenant_id, invoice_id, amount_cents, created_by, payment_method)
         VALUES ($1, $2, 1500, $3, 'card_present')`,
        [t.tenantId, invoiceId, t.userId],
      );
    },
  },
  {
    row: "proposal_sms_events with kinds 'voice_reapproval' and 'digest_approve_all_rendered'",
    strictAt: '165_proposal_sms_events_review_required_kind (and 171)',
    relaxedBy: '171_proposal_sms_events_voice_reapproval_kind / 189_proposal_sms_events_digest_approve_all_kind',
    seed: async (db, t) => {
      const proposalId = await insertProposal(db, t);
      await db.query(
        `INSERT INTO proposal_sms_events (id, tenant_id, proposal_id, direction, kind, body)
         VALUES (gen_random_uuid(), $1, $2, 'outbound', 'voice_reapproval', 'x'),
                (gen_random_uuid(), $1, $2, 'outbound', 'digest_approve_all_rendered', 'x')`,
        [t.tenantId, proposalId],
      );
    },
  },
  {
    row: "oauth_states with provider 'google_business'",
    strictAt: '172_create_accounting_integrations (oauth_states_provider_check)',
    relaxedBy: '308_oauth_states_google_business_provider',
    seed: async (db, t) => {
      await db.query(
        `INSERT INTO oauth_states (tenant_id, user_id, provider) VALUES ($1, $2, 'google_business')`,
        [t.tenantId, t.userId],
      );
    },
  },
  {
    row: "tenant_settings with country 'US' and NULL region, NULL timezone, NULL job_buffer_minutes",
    strictAt: '070 (tenant_settings_us_region_check) / 013 + 098 (NOT NULL)',
    relaxedBy: '088_fix_schema_constraints / 263_tenant_settings_timezone_no_silent_default / 277_tenant_settings_job_buffer_nullable',
    seed: async (db, t) => {
      await db.query(
        `INSERT INTO tenant_settings (tenant_id, business_name, country, region, timezone, job_buffer_minutes)
         VALUES ($1, 'Replay Co', 'US', NULL, NULL, NULL)`,
        [t.tenantId],
      );
    },
  },
  {
    row: 'voice_recordings row with NULL file_id, and a call_transcript_turns row with NULL voice_recording_id',
    strictAt: '007_create_voice_recordings / 060_capture_schema (NOT NULL)',
    relaxedBy: '088_fix_schema_constraints / 278_call_transcript_turns_call_sid',
    seed: async (db, t) => {
      await db.query(
        `INSERT INTO voice_recordings (tenant_id, created_by, file_id) VALUES ($1, $2, NULL)`,
        [t.tenantId, t.userId],
      );
      await db.query(
        `INSERT INTO call_transcript_turns (tenant_id, turn_index, speaker, text, voice_recording_id, call_sid, session_id)
         VALUES ($1, 0, 'caller', 'hello', NULL, $2, $3)`,
        [t.tenantId, `CA${crypto.randomUUID().replace(/-/g, '')}`, `sess-${crypto.randomUUID()}`],
      );
    },
  },
  {
    row: 'tenant_dnc_list row with NULL added_by',
    strictAt: '052_p8_tenant_dnc_list (NOT NULL)',
    relaxedBy: '192_tenant_dnc_list_source',
    seed: async (db, t) => {
      await db.query(
        `INSERT INTO tenant_dnc_list (tenant_id, phone, added_by) VALUES ($1, '+15125550199', NULL)`,
        [t.tenantId],
      );
    },
  },
  {
    row: "vertical_packs row with a packId type ('replay-v1')",
    strictAt: "032_create_vertical_packs (CHECK type IN ('hvac','plumbing'))",
    relaxedBy: '089_drop_vertical_packs_type_check',
    seed: async (db) => {
      await db.query(
        `INSERT INTO vertical_packs (type, name, version) VALUES ($1, 'Replay pack', '1')`,
        [`replay-v1-${crypto.randomUUID().slice(0, 8)}`],
      );
    },
  },
  {
    row: 'brand_voice_versions row with a non-UUID changed_by (Clerk user id)',
    strictAt: '237_brand_voice_versions (changed_by UUID)',
    relaxedBy: '243_brand_voice_versions_changed_by_text',
    seed: async (db, t) => {
      await db.query(
        `INSERT INTO brand_voice_versions (tenant_id, version, snapshot, change_reason, changed_by)
         VALUES ($1, 1, '{}'::jsonb, 'replay', 'user_2replayClerkId')`,
        [t.tenantId],
      );
    },
  },
];

const CLERK_WEBHOOK_SECRET = 'whsec_dGVzdC1zZWNyZXQ='; // base64("test-secret")

/**
 * A real owner signup: a signed Clerk `user.created` through the production
 * `/webhooks/clerk` route, which bootstraps the tenant and inserts the owner's
 * membership row.
 */
async function signUpOwner(db: Pool): Promise<TestTenant> {
  const app = express();
  app.use(express.json());
  app.use(
    '/webhooks',
    createWebhookRouter(
      { CLERK_WEBHOOK_SECRET, CLERK_SECRET_KEY: undefined } as unknown as AppConfig,
      {
        tenantRepo: new PgTenantRepository(db),
        pool: db,
        webhookRepo: new InMemoryWebhookRepository(),
        auditRepo: new PgAuditRepository(db),
      },
    ),
  );
  const clerkUserId = `user_owner_${crypto.randomUUID()}`;
  const payload = {
    type: 'user.created',
    data: { id: clerkUserId, email_addresses: [{ email_address: `${crypto.randomUUID()}@example.com` }] },
  };
  const svixId = `evt_${crypto.randomUUID()}`;
  const ts = String(Math.floor(Date.now() / 1000));
  const signed = `${svixId}.${ts}.${JSON.stringify(payload)}`;
  const secret = Buffer.from(CLERK_WEBHOOK_SECRET.replace(/^whsec_/, ''), 'base64');
  const res = await request(app)
    .post('/webhooks/clerk')
    .set('svix-id', svixId)
    .set('svix-timestamp', ts)
    .set('svix-signature', `v1,${createHmac('sha256', secret).update(signed).digest('base64')}`)
    .send(payload);
  expect(res.status).toBe(200);

  const tenant = await new PgTenantRepository(db).findByOwner(clerkUserId);
  if (!tenant) throw new Error('signup did not bootstrap a tenant');
  const [owner] = await new PgUserRepository(db).findByTenant(tenant.id, { role: 'owner' });
  if (!owner) throw new Error('signup did not create the owner membership row');
  return { tenantId: tenant.id, userId: owner.id };
}

/** The production /api/users router, acting as `actor` (an owner of its tenant). */
function usersApi(db: Pool, actor: TestTenant): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as AuthenticatedRequest).auth = {
      userId: actor.userId,
      sessionId: 'sess-replay',
      tenantId: actor.tenantId,
      role: 'owner',
    };
    next();
  });
  app.use('/api/users', createUsersRouter(new PgUserRepository(db), {}, new PgAuditRepository(db)));
  return app;
}

/** One deploy: the exact entrypoint the Railway preDeployCommand runs. */
async function deploy(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await applyMigrations(client, { maxAttempts: 1 });
  } finally {
    await client.query('RESET ALL').catch(() => undefined);
    client.release();
  }
}

describe('Postgres integration — migration corpus replays over a populated database', () => {
  const dbName = `replay_${crypto.randomUUID().replace(/-/g, '')}`;
  let admin: Pool;
  let pool: Pool;

  beforeAll(async () => {
    const baseUri = process.env.TEST_DB_URL;
    if (!baseUri) throw new Error('TEST_DB_URL not set — run via the integration config');
    admin = new Pool({ connectionString: baseUri, max: 1 });
    await admin.query(`CREATE DATABASE ${dbName}`);
    const uri = new URL(baseUri);
    uri.pathname = `/${dbName}`;
    pool = new Pool({ connectionString: uri.toString(), max: 4 });

    // Deploy N against an empty database (what every other test already covers).
    await deploy(pool);
    await ensureRlsRuntimeRole(pool);
  });

  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      await admin.end();
    }
  });

  it('a call session that filed two different call-me-back reasons does not block the next deploy', async () => {
    // Production traffic between deploys, through the real repository: one
    // E1 call that both left a live booking AND could not reach the tenant
    // (migration 268's motivating case) files two tasks for ONE session.
    const tenant = await createTestTenant(pool);
    const repo = new PgCallMeBackRepository(pool);
    const sessionId = `sess-${crypto.randomUUID()}`;
    await repo.create({
      tenantId: tenant.tenantId,
      sessionId,
      callerPhone: '+15125550100',
      reason: 'life_safety_e1_booking_live',
    });
    await repo.create({
      tenantId: tenant.tenantId,
      sessionId,
      callerPhone: '+15125550100',
      reason: 'life_safety_e1',
    });

    // Deploy N+1.
    await expect(deploy(pool)).resolves.toBeUndefined();

    const pending = await repo.listPending(tenant.tenantId);
    expect(pending.filter((t) => t.sessionId === sessionId).map((t) => t.reason).sort()).toEqual([
      'life_safety_e1',
      'life_safety_e1_booking_live',
    ]);
  });

  it('the next deploy succeeds over a row for EVERY relaxed-since invariant', async () => {
    const tenant = await createTestTenant(pool);
    for (const inv of RELAXED_SINCE) {
      // A seed failing here means the row is no longer legal under the FINAL
      // schema — fix the seed, not the migration.
      await inv.seed(pool, tenant).catch((err: unknown) => {
        throw new Error(`seed for "${inv.row}" failed: ${String(err)}`);
      });
    }

    // Deploy N+1. A failure names the constraint/index the stale early copy
    // rebuilt; find it in RELAXED_SINCE (strictAt → relaxedBy) to see which
    // early migration needs to stop re-validating existing rows.
    await expect(deploy(pool)).resolves.toBeUndefined();
  });

  it('call_me_back_tasks ends every deploy with exactly the (tenant, session, reason) unique key', async () => {
    // 154 is a no-op now; 268 alone must still produce the final key on a
    // fresh database and leave an already-migrated one untouched.
    await deploy(pool);
    const { rows } = await pool.query<{ indexname: string; indexdef: string }>(
      `SELECT i.relname AS indexname, pg_get_indexdef(i.oid) AS indexdef
         FROM pg_index x
         JOIN pg_class i ON i.oid = x.indexrelid
        WHERE x.indrelid = 'call_me_back_tasks'::regclass
          AND x.indisunique AND NOT x.indisprimary`,
    );
    expect(rows).toEqual([
      {
        indexname: 'idx_cmb_session_reason_unique',
        indexdef:
          'CREATE UNIQUE INDEX idx_cmb_session_reason_unique ON public.call_me_back_tasks ' +
          'USING btree (tenant_id, session_id, reason) WHERE (session_id IS NOT NULL)',
      },
    ]);
  });

  it('rows written before 324 keep no seed provenance through the migration and the next replay (324)', async () => {
    // Back to the pre-324 shape: the columns 324 adds do not exist yet, so
    // production rows written then carry nothing that could become a baseline.
    await pool.query(`ALTER TABLE catalog_items DROP COLUMN IF EXISTS seed_key, DROP COLUMN IF EXISTS seeded_unit_price_cents`);
    await pool.query(
      `ALTER TABLE tenant_settings
         DROP COLUMN IF EXISTS forwarding_confirmed_at, DROP COLUMN IF EXISTS forwarding_verified_at,
         DROP COLUMN IF EXISTS forwarding_source_number, DROP COLUMN IF EXISTS forwarding_carrier,
         DROP COLUMN IF EXISTS forwarding_generation, DROP COLUMN IF EXISTS forwarding_probe_generation,
         DROP COLUMN IF EXISTS forwarding_probe_at`,
    );

    // A legacy HVAC tenant: its pack's headline items (one priced exactly at
    // the national labor price a tier would show), a non-headline item, and a
    // job type whose lines carry the same prices, all in the old column set.
    const tenant = await createTestTenant(pool);
    const laborCents = packHeadlinePrices('hvac')!.laborCents;
    const visitCents = packHeadlinePrices('hvac')!.visitCents;
    await pool.query(
      `INSERT INTO catalog_items (tenant_id, name, category, unit, unit_price_cents, product_service_type)
       VALUES ($1, 'HVAC Labor', 'Labor', 'hour', $2, 'service'),
              ($1, 'HVAC Diagnostic Fee', 'Labor', 'each', $3, 'service'),
              ($1, 'Filter Replacement', 'Parts', 'each', 3900, 'product')`,
      [tenant.tenantId, laborCents, visitCents],
    );
    const legacyLines = [
      { description: 'Diagnostic + trip fee', category: 'labor', defaultQuantity: 1, defaultUnitPriceCents: visitCents, taxable: false, sortOrder: 0, isOptional: false },
      { description: 'AC repair labor', category: 'labor', defaultQuantity: 1, defaultUnitPriceCents: laborCents, taxable: false, sortOrder: 1, isOptional: false },
    ];
    await pool.query(
      `INSERT INTO estimate_templates (tenant_id, vertical_type, category_id, name, line_item_templates, created_by)
       VALUES ($1, 'hvac', 'ac-repair', 'Standard AC Repair', $2::jsonb, $3)`,
      [tenant.tenantId, JSON.stringify(legacyLines), tenant.userId],
    );
    await pool.query(`INSERT INTO tenant_settings (tenant_id, business_name) VALUES ($1, 'Legacy Co')`, [tenant.tenantId]);

    async function expectNoProvenance(): Promise<void> {
      const catalog = await pool.query<{ name: string; seed_key: string | null; seeded_unit_price_cents: number | null }>(
        `SELECT name, seed_key, seeded_unit_price_cents FROM catalog_items WHERE tenant_id = $1 ORDER BY name`,
        [tenant.tenantId],
      );
      expect(catalog.rows).toEqual([
        { name: 'Filter Replacement', seed_key: null, seeded_unit_price_cents: null },
        { name: 'HVAC Diagnostic Fee', seed_key: null, seeded_unit_price_cents: null },
        { name: 'HVAC Labor', seed_key: null, seeded_unit_price_cents: null },
      ]);
      const templates = await pool.query<{ line_item_templates: unknown }>(
        `SELECT line_item_templates FROM estimate_templates WHERE tenant_id = $1`,
        [tenant.tenantId],
      );
      expect(templates.rows[0].line_item_templates).toEqual(legacyLines);
      const settings = await pool.query(
        `SELECT forwarding_confirmed_at, forwarding_verified_at, forwarding_source_number, forwarding_carrier,
                forwarding_generation, forwarding_probe_generation, forwarding_probe_at
           FROM tenant_settings WHERE tenant_id = $1`,
        [tenant.tenantId],
      );
      expect(settings.rows[0]).toEqual({
        forwarding_confirmed_at: null,
        forwarding_verified_at: null,
        forwarding_source_number: null,
        forwarding_carrier: null,
        forwarding_generation: 0,
        forwarding_probe_generation: null,
        forwarding_probe_at: null,
      });
    }

    // Deploy N+1 applies 324 over them; deploy N+2 replays it.
    await deploy(pool);
    await expectNoProvenance();
    await deploy(pool);
    await expectNoProvenance();
  });

  /**
   * The same no-ledger replay re-executes every one-off DATA backfill
   * (UPDATE / INSERT … SELECT written to settle pre-migration rows ONCE) on
   * every deploy, against rows users and workers wrote since. Each case
   * below is production traffic between deploy N and deploy N+1 that a
   * re-run backfill would overwrite.
   */
  describe('one-shot backfills do not re-run against data written since', () => {
    it('a PIN-lock owner alert claimed but not yet delivered is still sent after the next deploy (292)', async () => {
      // The tenant-wide PIN lock engaged and the alert was claimed, but the
      // first SMS failed, so the durable retry is queued with sent_at NULL.
      const tenant = await createTestTenant(pool);
      const alerts = new PgVoiceApprovalPinLockAlertRepository(pool);
      const episodeKey = `episode-${crypto.randomUUID()}`;
      expect(await alerts.claim({ tenantId: tenant.tenantId, episodeKey, strikeCount: 5 })).toBe(true);

      // Deploy N+1 lands before the retry fires.
      await deploy(pool);

      const texted: string[] = [];
      const retry = createPinLockAlertRetryWorker({
        queue: { send: async () => 'queued' },
        alertRepo: alerts,
        sendSms: async (to) => {
          texted.push(to);
        },
        resolveOwnerPhone: async () => '+15125550142',
      });
      await retry.handle(
        {
          id: 'm-1',
          type: retry.type,
          payload: { tenantId: tenant.tenantId, episodeKey, strikeCount: 5, attempt: 1 },
          attempts: 0,
          maxAttempts: 3,
          idempotencyKey: `pin-lock-retry:${episodeKey}:1`,
          createdAt: new Date().toISOString(),
        } as QueueMessage<unknown>,
        silentLogger,
      );

      // The owner is told their PIN was brute-forced into a lock.
      expect(texted).toEqual(['+15125550142']);
      expect(await alerts.isSent(tenant.tenantId, episodeKey)).toBe(true);
    });

    it('an owner created by Clerk signup is field-capable, and still is after the next deploy (066 + 309)', async () => {
      // 066's owner backfill no longer re-runs, so it no longer quietly
      // turns new owners field-capable at the next deploy — creation must.
      const owner = await signUpOwner(pool);
      const users = new PgUserRepository(pool);
      expect((await users.findById(owner.tenantId, owner.userId))?.canFieldServe).toBe(true);

      await deploy(pool);

      expect((await users.findById(owner.tenantId, owner.userId))?.canFieldServe).toBe(true);
    });

    it("an owner who turned field-serving off keeps it off across the next deploy (066)", async () => {
      // PATCH /api/users/:id { canFieldServe: false } — an office-only owner
      // opting out of being counted as a sendable field tech.
      const owner = await signUpOwner(pool);
      const res = await request(usersApi(pool, owner))
        .patch(`/api/users/${owner.userId}`)
        .send({ canFieldServe: false });
      expect(res.status).toBe(200);

      await deploy(pool);

      const after = await new PgUserRepository(pool).findById(owner.tenantId, owner.userId);
      expect(after?.role).toBe('owner');
      expect(after?.canFieldServe).toBe(false);
    });

    it('a job completed before a deploy still gets its 24h review request (214)', async () => {
      const tenant = await createTestTenant(pool);
      await pool.query(
        `INSERT INTO tenant_settings (tenant_id, business_name) VALUES ($1, 'Replay Co')`,
        [tenant.tenantId],
      );
      const jobId = await insertJob(pool, tenant);
      const jobs = new PgJobRepository(pool);
      const timeline = new PgJobTimelineRepository(pool);
      // A tech works the job through the governed lifecycle and completes it.
      for (const status of ['scheduled', 'in_progress', 'completed'] as const) {
        await transitionJobStatus(tenant.tenantId, jobId, status, tenant.userId, 'owner', jobs, timeline);
      }

      // Deploy N+1 lands inside the 24h window.
      await deploy(pool);

      const enqueued: Array<{ type: string; payload: unknown }> = [];
      await runReviewRequestSweep({
        pool,
        jobRepo: jobs,
        queue: {
          send: async (type: string, payload: unknown) => {
            enqueued.push({ type, payload });
            return 'queued';
          },
        },
        logger: silentLogger,
        now: () => new Date(Date.now() + 25 * HOUR_MS),
      });

      expect(enqueued).toContainEqual({
        type: 'feedback_send',
        payload: { tenantId: tenant.tenantId, jobId },
      });
    });

    it('a job marked completed by a raw status write is not stamped completed-and-thanked by the next deploy (194)', async () => {
      // The approved update_job correction / PUT /api/jobs/:id status write:
      // status only, no completion timestamp, no thank-you yet.
      const tenant = await createTestTenant(pool);
      const jobId = await insertJob(pool, tenant);
      const jobs = new PgJobRepository(pool);
      await jobs.update(tenant.tenantId, jobId, { status: 'completed' });

      await deploy(pool);

      const job = await jobs.findById(tenant.tenantId, jobId);
      expect(job?.status).toBe('completed');
      expect(job?.completedAt).toBeUndefined();
      expect(job?.thankYouSmsSentAt).toBeUndefined();
    });
  });
});

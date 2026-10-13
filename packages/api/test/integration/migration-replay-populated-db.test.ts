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
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { applyMigrations } from '../../src/db/migrate';
import { PgCallMeBackRepository } from '../../src/voice/call-me-back/pg-call-me-back';
import { PgVoiceApprovalPinLockAlertRepository } from '../../src/settings/pg-voice-approval-pin-lock-alert';
import { createPinLockAlertRetryWorker } from '../../src/workers/pin-lock-alert-retry';
import { PgUserRepository } from '../../src/users/pg-user';
import type { QueueMessage } from '../../src/queues/queue';
import { createLogger } from '../../src/logging/logger';
import { createTestTenant, ensureRlsRuntimeRole, type TestTenant } from './shared';

const silentLogger = createLogger({ service: 'test', environment: 'test', level: 'error' });

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

async function insertInvoice(db: Pool, tenant: TestTenant): Promise<string> {
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
  const invoice = await db.query<{ id: string }>(
    `INSERT INTO invoices (tenant_id, job_id, invoice_number, created_by)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [tenant.tenantId, job.rows[0].id, `INV-${n}`, tenant.userId],
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

    it("an owner who turned field-serving off keeps it off across the next deploy (066)", async () => {
      // PUT /api/users/:id { canFieldServe: false } — an office-only owner
      // opting out of being counted as a sendable field tech.
      const tenant = await createTestTenant(pool);
      const users = new PgUserRepository(pool);
      await users.update(tenant.tenantId, tenant.userId, { canFieldServe: true });
      await users.update(tenant.tenantId, tenant.userId, { canFieldServe: false });

      await deploy(pool);

      const owner = await users.findById(tenant.tenantId, tenant.userId);
      expect(owner?.role).toBe('owner');
      expect(owner?.canFieldServe).toBe(false);
    });
  });
});

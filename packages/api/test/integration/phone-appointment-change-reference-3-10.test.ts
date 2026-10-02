/**
 * #1015 §8.3 row 3.10 — "As M, I want to book, move and cancel by talking".
 *
 * The frontier the 2026-09-27 re-grade (PR #1432) recorded: #1119's anchored,
 * entity-free openings ("I need to cancel my appointment") classify, confirm
 * and draft — but the draft names NO appointment, and the owner's natural
 * follow-up ("The Garcia appointment") is answered "can you say that again?".
 * So a spoken move/cancel could never become an approvable proposal.
 *
 * Proven here at REAL Postgres, through the REAL `createApp()` Express app
 * with self-signed Twilio webhooks (`/api/telephony/voice` →
 * `/api/telephony/gather`), on the tenant's owner line:
 *
 *   - an entity-free move/cancel opening is followed by ONE question — which
 *     appointment — instead of a readback of a request that can't be acted on;
 *   - the owner's answer goes through the shared entity resolver
 *     (`PgEntityResolver`, the same one every other reference uses), and the
 *     drafted proposal carries the VERIFIED `appointmentId`;
 *   - when the name matches two upcoming appointments the call asks (the
 *     existing `entity_ambiguous` question) — never a guess (CLAUDE.md);
 *   - T1: tenant B holds its OWN "Garcia" appointment; it is never the one
 *     tenant A's call resolves to, and tenant B's rows are untouched.
 *
 * Deterministic without a model: the opening is `matchAppointmentChangeOpening`
 * (#1119), the reference is resolved by pg_trgm, and the confirm "yes" is the
 * hermetic gateway's closed affirmative list (#1119).
 *
 * Run (Docker-gated):
 *   cd packages/api && RLS_RUNTIME_ROLE=true EXTERNAL_TEST_DB_URL=… npx vitest run \
 *     --config vitest.integration.config.mts --reporter=verbose \
 *     test/integration/phone-appointment-change-reference-3-10.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import crypto from 'node:crypto';
import { Pool } from 'pg';
import twilio from 'twilio';
import type { Express } from 'express';
import { getSharedTestDb, closeSharedTestDb } from './shared';
import { encrypt } from '../../src/integrations/crypto';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgLocationRepository } from '../../src/locations/pg-location';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { PgAppointmentRepository } from '../../src/appointments/pg-appointment';

const ENCRYPTION_KEY = 'c'.repeat(64);
const PUBLIC_API_URL = 'http://127.0.0.1:3997';

const RUN = crypto.randomInt(100000, 999999);
const A_DID = `+1737${RUN}1`;
const B_DID = `+1737${RUN}2`;
const A_SUBACCOUNT = 'AC1015cccccccccccccccccccccccccccc';
const B_SUBACCOUNT = 'AC1015dddddddddddddddddddddddddddd';
const DEPLOYMENT_SUBACCOUNT = 'AC10150000000000000000000000000310';
const A_TOKEN = 'tenant-a-twilio-auth-token-1015-310r';
const B_TOKEN = 'tenant-b-twilio-auth-token-1015-310r';
const DEPLOYMENT_TOKEN = 'deployment-master-twilio-auth-token-1015-310r';
const A_OWNER_PHONE = `+1737${RUN}7`;
const B_OWNER_PHONE = `+1737${RUN}8`;

const WHICH_APPOINTMENT = 'which appointment';
const DAY_MS = 24 * 60 * 60 * 1000;

interface TenantFixture {
  tenantId: string;
  userId: string;
  did: string;
  subaccountSid: string;
  authToken: string;
  ownerPhone: string;
}

describe('#1015 row 3.10 — a spoken move/cancel names its appointment through the resolver (phone, real Postgres)', () => {
  let pool: Pool;
  let app: Express;
  let gracefulDrain: ((reason: string) => Promise<void>) | undefined;
  let tenantA: TenantFixture;
  let tenantB: TenantFixture;
  const savedEnv: Record<string, string | undefined> = {};

  function setEnv(key: string, value: string): void {
    if (!(key in savedEnv)) savedEnv[key] = process.env[key];
    process.env[key] = value;
  }

  async function provision(opts: {
    did: string;
    subaccountSid: string;
    authToken: string;
    ownerPhone: string;
  }): Promise<TenantFixture> {
    const tenantId = crypto.randomUUID();
    const userId = crypto.randomUUID();
    const email = `owner+${tenantId.slice(0, 8)}@example.com`;
    await pool.query(
      `INSERT INTO tenants (id, owner_id, owner_email, name, subscription_status)
       VALUES ($1, $2, $3, $4, 'active')`,
      [tenantId, userId, email, '1015 Move Cancel Shop'],
    );
    await pool.query(
      `INSERT INTO users (id, tenant_id, clerk_user_id, email, role, first_name, last_name)
       VALUES ($1, $2, $3, $4, 'owner', 'Dev', 'Owner')`,
      [userId, tenantId, userId, email],
    );
    await pool.query(
      `INSERT INTO tenant_settings
         (id, tenant_id, business_name, timezone, region, voice_agent_live_at, owner_phone)
       VALUES ($1, $2, '1015 Move Cancel Shop', 'America/Chicago', 'TX', NOW(), $3)`,
      [crypto.randomUUID(), tenantId, opts.ownerPhone],
    );
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
      await client.query(
        `INSERT INTO tenant_integrations
           (tenant_id, provider, status, provider_data, subaccount_sid, auth_token_primary_enc)
         VALUES ($1, 'twilio', 'full_readiness', $2::jsonb, $3, $4)`,
        [
          tenantId,
          JSON.stringify({ phoneE164: opts.did }),
          opts.subaccountSid,
          encrypt(opts.authToken, ENCRYPTION_KEY),
        ],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
    return { tenantId, userId, ...opts };
  }

  /** A customer with one job and `appointmentCount` upcoming appointments. */
  async function seedCustomerAppointments(
    t: TenantFixture,
    firstName: string,
    lastName: string,
    appointmentCount: number,
  ): Promise<string[]> {
    const customerId = crypto.randomUUID();
    await new PgCustomerRepository(pool).create({
      id: customerId,
      tenantId: t.tenantId,
      firstName,
      lastName,
      displayName: `${firstName} ${lastName}`,
      preferredChannel: 'phone',
      smsConsent: false,
      isArchived: false,
      createdBy: t.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const locationId = crypto.randomUUID();
    await new PgLocationRepository(pool).create({
      id: locationId,
      tenantId: t.tenantId,
      customerId,
      street1: `${RUN % 900} ${lastName} Way`,
      city: 'Austin',
      state: 'TX',
      postalCode: '78701',
      country: 'USA',
      isPrimary: true,
      isArchived: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const jobId = crypto.randomUUID();
    await new PgJobRepository(pool).create({
      id: jobId,
      tenantId: t.tenantId,
      customerId,
      locationId,
      jobNumber: `JOB-${lastName.toUpperCase()}-${jobId.slice(0, 8)}`,
      summary: `${lastName} furnace service`,
      status: 'scheduled',
      priority: 'normal',
      createdBy: t.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const ids: string[] = [];
    for (let i = 0; i < appointmentCount; i++) {
      const start = new Date(Date.now() + (3 + i) * DAY_MS);
      start.setUTCHours(15, 0, 0, 0);
      const id = crypto.randomUUID();
      await new PgAppointmentRepository(pool).create({
        id,
        tenantId: t.tenantId,
        jobId,
        scheduledStart: start,
        scheduledEnd: new Date(start.getTime() + 2 * 60 * 60 * 1000),
        timezone: 'America/Chicago',
        status: 'scheduled',
        holdPendingApproval: false,
        createdBy: t.userId,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      ids.push(id);
    }
    return ids;
  }

  function signedPost(path: string, params: Record<string, string>, authToken: string) {
    const signature = twilio.getExpectedTwilioSignature(
      authToken,
      `${PUBLIC_API_URL}${path}`,
      params,
    );
    return request(app).post(path).set('X-Twilio-Signature', signature).type('form').send(params);
  }

  function sessionIdFromTwiml(twiml: string): string {
    const m = /[?&]sid=([0-9a-f-]{36})/i.exec(twiml);
    expect(m, `no ?sid= in TwiML: ${twiml}`).not.toBeNull();
    return m![1]!;
  }

  /** One owner-line call: /voice, then each utterance as a signed Gather turn. */
  async function ownerCall(t: TenantFixture, utterances: string[]): Promise<{ sid: string; twimls: string[] }> {
    const callSid = `CA-1015-310r-${crypto.randomUUID().slice(0, 8)}`;
    const voice = await signedPost(
      '/api/telephony/voice',
      { CallSid: callSid, AccountSid: t.subaccountSid, From: t.ownerPhone, To: t.did, StirVerstat: 'TN-Validation-Passed-A' },
      t.authToken,
    );
    expect(voice.status).toBe(200);
    const sid = sessionIdFromTwiml(voice.text);
    const twimls: string[] = [];
    for (const speech of ['This is the owner calling', ...utterances]) {
      const res = await signedPost(
        `/api/telephony/gather?sid=${sid}`,
        { CallSid: callSid, AccountSid: t.subaccountSid, From: t.ownerPhone, To: t.did, SpeechResult: speech, Confidence: '0.95' },
        t.authToken,
      );
      expect(res.status).toBe(200);
      twimls.push(res.text);
    }
    return { sid, twimls: twimls.slice(1) };
  }

  async function proposalsOf(tenantId: string, type: string) {
    const { rows } = await pool.query<{ status: string; payload: Record<string, unknown> }>(
      `SELECT status, payload FROM proposals WHERE tenant_id = $1 AND proposal_type = $2`,
      [tenantId, type],
    );
    return rows;
  }

  beforeAll(async () => {
    pool = await getSharedTestDb();
    tenantA = await provision({ did: A_DID, subaccountSid: A_SUBACCOUNT, authToken: A_TOKEN, ownerPhone: A_OWNER_PHONE });
    tenantB = await provision({ did: B_DID, subaccountSid: B_SUBACCOUNT, authToken: B_TOKEN, ownerPhone: B_OWNER_PHONE });

    setEnv('NODE_ENV', 'test');
    setEnv('DATABASE_URL', process.env.TEST_DB_URL!);
    setEnv('DB_SSL', 'false');
    setEnv('PROCESS_ROLE', 'web');
    setEnv('TENANT_ENCRYPTION_KEY', ENCRYPTION_KEY);
    setEnv('PUBLIC_API_URL', PUBLIC_API_URL);
    setEnv('TWILIO_ACCOUNT_SID', DEPLOYMENT_SUBACCOUNT);
    setEnv('TWILIO_AUTH_TOKEN', DEPLOYMENT_TOKEN);
    setEnv('TWILIO_FROM_NUMBER', '+15125550000');
    setEnv('TWILIO_DEFAULT_TENANT_ID', tenantA.tenantId);
    setEnv('TWILIO_MEDIA_STREAMS_ENABLED', 'false');

    const { createApp } = await import('../../src/app');
    const built = createApp();
    app = built;
    gracefulDrain = built.gracefulDrain;
  });

  afterAll(async () => {
    await gracefulDrain?.('test-teardown').catch(() => undefined);
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await closeSharedTestDb();
  });

  it('CANCEL: "I need to cancel my appointment" asks which one; "The Garcia appointment" resolves; "Yes" drafts a cancel carrying that appointmentId', async () => {
    const [garciaAppt] = await seedCustomerAppointments(tenantA, 'Maria', 'Garcia', 1);

    const { twimls } = await ownerCall(tenantA, [
      'I need to cancel my appointment',
      'The Garcia appointment',
      'Yes',
    ]);

    // One question — which appointment — instead of a readback of a request
    // nothing could act on.
    expect(twimls[0]!.toLowerCase()).toContain(WHICH_APPOINTMENT);
    expect(twimls[0]!.toLowerCase()).not.toContain('is that right');
    // The answer resolved: the call reads the cancel back.
    expect(twimls[1]!.toLowerCase()).toContain('you&apos;d like to cancel the garcia appointment. is that right'); // #1539 per-intent readback

    const rows = await proposalsOf(tenantA.tenantId, 'cancel_appointment');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload.appointmentId).toBe(garciaAppt);
  });

  it('MOVE: "I need to reschedule my appointment" → "The Okafor appointment" → "Yes" drafts a reschedule carrying that appointmentId', async () => {
    const [okaforAppt] = await seedCustomerAppointments(tenantA, 'Ada', 'Okafor', 1);

    const { twimls } = await ownerCall(tenantA, [
      'I need to reschedule my appointment',
      'The Okafor appointment',
      'Yes',
    ]);

    expect(twimls[0]!.toLowerCase()).toContain(WHICH_APPOINTMENT);
    expect(twimls[1]!.toLowerCase()).toContain('you&apos;d like to move the okafor appointment. is that right'); // #1539 per-intent readback

    const rows = await proposalsOf(tenantA.tenantId, 'reschedule_appointment');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload.appointmentId).toBe(okaforAppt);
  });

  it('never a guess: a name with TWO upcoming appointments is asked about (entity_ambiguous), and nothing is drafted on that turn', async () => {
    await seedCustomerAppointments(tenantA, 'Priya', 'Nair', 2);
    const before = (await proposalsOf(tenantA.tenantId, 'cancel_appointment')).length;

    const { sid, twimls } = await ownerCall(tenantA, [
      'I need to cancel my appointment',
      'The Nair appointment',
    ]);

    expect(twimls[0]!.toLowerCase()).toContain(WHICH_APPOINTMENT);
    // The answer matched two appointments: the call asks again — which of
    // the two — rather than reading back (or drafting) either one.
    expect(twimls[1]!.toLowerCase()).not.toContain('is that right');
    const { rows: ambiguous } = await pool.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM audit_events WHERE tenant_id = $1 AND entity_id = $2
          AND event_type = 'agent.calling.entity_resolution.entity_ambiguous'`,
      [tenantA.tenantId, sid],
    );
    expect(ambiguous).toHaveLength(1);
    expect(ambiguous[0]!.metadata.candidateCount).toBe(2);
    expect((await proposalsOf(tenantA.tenantId, 'cancel_appointment')).length).toBe(before);
  });

  it('T1: tenant B\'s own "Reyes" appointment is never the one tenant A\'s call resolves to, and tenant B\'s rows are untouched', async () => {
    const [aReyes] = await seedCustomerAppointments(tenantA, 'Luis', 'Reyes', 1);
    const [bReyes] = await seedCustomerAppointments(tenantB, 'Luis', 'Reyes', 1);

    await ownerCall(tenantA, ['I need to cancel my appointment', 'The Reyes appointment', 'Yes']);

    const aRows = (await proposalsOf(tenantA.tenantId, 'cancel_appointment')).filter(
      (r) => r.payload.appointmentId === aReyes || r.payload.appointmentId === bReyes,
    );
    expect(aRows).toHaveLength(1);
    expect(aRows[0]!.payload.appointmentId).toBe(aReyes);
    expect(await proposalsOf(tenantB.tenantId, 'cancel_appointment')).toHaveLength(0);
    const { rows } = await pool.query<{ status: string }>(
      `SELECT status FROM appointments WHERE tenant_id = $1 AND id = $2`,
      [tenantB.tenantId, bReyes],
    );
    expect(rows[0]!.status).toBe('scheduled');
  });
});

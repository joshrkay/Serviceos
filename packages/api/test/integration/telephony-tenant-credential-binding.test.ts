/**
 * #1072 — the inbound telephony webhooks must verify the X-Twilio-Signature
 * with the credential of the TENANT THAT OWNS THE DIALLED NUMBER.
 *
 * The defect (found by #1014 lane B, proven at a real API + real Postgres):
 * `/api/telephony/*` resolved the signing credential and the tenant from two
 * INDEPENDENT body fields and never checked they agree —
 *
 *   - the auth token came from the body's `AccountSid`
 *     (`resolveTwilioAuthTokenForSubaccount`, app.ts:3756);
 *   - the tenant came from the body's `To`
 *     (`resolveTenantIdByPhoneNumber`, app.ts:3791).
 *
 * So the middleware answered "is this signed by SOME tenant", never "is this
 * signed by THE tenant that owns the dialled number". A tenant holding its own
 * Twilio credential could drive inbound calls into any other tenant by putting
 * the victim's DID (public information — it is their business number) in `To`:
 * voice sessions, leads, customers and audit rows landed under the victim.
 *
 * This file is the regression pin, at REAL Postgres through the REAL
 * `createApp()` Express app (CLAUDE.md: a mocked Pool is never the only proof
 * a query works — the DID → credential lookup reads
 * `tenant_integrations.provider_data->>'phoneE164'`, `subaccount_sid` and
 * `auth_token_primary_enc`, and those column names are pinned here).
 *
 * Two tenants are provisioned exactly as the Twilio onboarding flow leaves
 * them — a DID, a subaccount SID and their own encrypted auth token — and the
 * attacker (tenant A) uses ONLY credentials it legitimately owns. The single
 * hostile field is `To`.
 *
 * Run (Docker-gated):
 *   cd packages/api && RLS_RUNTIME_ROLE=true npx vitest run \
 *     --config vitest.integration.config.ts --reporter=verbose \
 *     test/integration/telephony-tenant-credential-binding.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import crypto from 'node:crypto';
import { Pool } from 'pg';
import twilio from 'twilio';
import type { Express } from 'express';
import { getSharedTestDb, closeSharedTestDb } from './shared';
import { encrypt } from '../../src/integrations/crypto';

/** 64 hex chars — the shape every deployment already sets to hold tenant creds. */
const ENCRYPTION_KEY = 'a'.repeat(64);
/** The URL the app signs against; `requireTwilioSignature` reconstructs it from PUBLIC_API_URL. */
const PUBLIC_API_URL = 'http://127.0.0.1:3999';

/**
 * The DID → tenant lookup is a `LIMIT 1` with no uniqueness constraint on
 * `provider_data->>'phoneE164'` (#1014 lane report, "not done" item 6), so a
 * per-run number keeps repeat runs against the same container independent.
 */
const RUN = crypto.randomInt(100000, 999999);
const A_DID = `+1512${RUN}1`;
const B_DID = `+1512${RUN}2`;
/** A number no tenant has provisioned — the deployment-fallback leg. */
const UNOWNED_DID = `+1512${RUN}9`;
const A_SUBACCOUNT = 'AC1072aaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const B_SUBACCOUNT = 'AC1072bbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const A_TOKEN = 'tenant-a-twilio-auth-token-1072';
const B_TOKEN = 'tenant-b-twilio-auth-token-1072';
/** The deployment's own master account — `TWILIO_AUTH_TOKEN`. */
const DEPLOYMENT_SUBACCOUNT = 'AC10720000000000000000000000000000';
const DEPLOYMENT_TOKEN = 'deployment-master-twilio-auth-token-1072';
const CALLER = '+15125557199';

interface TenantFixture {
  tenantId: string;
  did: string;
  subaccountSid: string;
  authToken: string;
}

/** Row counts for every table a forged inbound call could write under a victim. */
interface VictimCounts {
  voiceSessions: number;
  leads: number;
  customers: number;
  auditEvents: number;
}

describe('#1072 — telephony webhooks verify with the dialled number owner\'s credential', () => {
  let pool: Pool;
  let app: Express;
  let gracefulDrain: ((reason: string) => Promise<void>) | undefined;
  let tenantA: TenantFixture;
  let tenantB: TenantFixture;
  /** Where an unowned DID lands in dev/test via TWILIO_DEFAULT_TENANT_ID. */
  let tenantDefault: TenantFixture;
  const savedEnv: Record<string, string | undefined> = {};

  function setEnv(key: string, value: string): void {
    if (!(key in savedEnv)) savedEnv[key] = process.env[key];
    process.env[key] = value;
  }

  /**
   * Provision a tenant the way the Twilio onboarding flow leaves it: an owner,
   * business settings with the go-live stamp + active subscription the real
   * voice gate requires, and ONE `tenant_integrations` row carrying the DID,
   * the subaccount SID and the encrypted auth token. No test-only columns.
   */
  async function provision(opts: {
    did: string;
    subaccountSid: string;
    authToken: string | null;
  }): Promise<TenantFixture> {
    const tenantId = crypto.randomUUID();
    const userId = crypto.randomUUID();
    const email = `owner+${tenantId.slice(0, 8)}@example.com`;
    await pool.query(
      `INSERT INTO tenants (id, owner_id, owner_email, name, subscription_status)
       VALUES ($1, $2, $3, $4, 'active')`,
      [tenantId, userId, email, '1072 Credential Binding Shop'],
    );
    await pool.query(
      `INSERT INTO users (id, tenant_id, clerk_user_id, email, role)
       VALUES ($1, $2, $3, $4, 'owner')`,
      [userId, tenantId, userId, email],
    );
    await pool.query(
      `INSERT INTO tenant_settings (id, tenant_id, business_name, timezone, region, voice_agent_live_at)
       VALUES ($1, $2, '1072 Credential Binding Shop', 'America/Chicago', 'TX', NOW())`,
      [crypto.randomUUID(), tenantId],
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
          opts.authToken ? encrypt(opts.authToken, ENCRYPTION_KEY) : null,
        ],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
    return { tenantId, did: opts.did, subaccountSid: opts.subaccountSid, authToken: opts.authToken ?? '' };
  }

  /**
   * A Twilio-shaped, self-signed webhook POST through the real Express app.
   * The signature is computed offline with the SAME HMAC-SHA1 algorithm
   * Twilio's servers use, keyed on whichever auth token the caller holds.
   */
  function signedPost(path: string, params: Record<string, string>, authToken: string) {
    const signature = twilio.getExpectedTwilioSignature(
      authToken,
      `${PUBLIC_API_URL}${path}`,
      params,
    );
    return request(app)
      .post(path)
      .set('X-Twilio-Signature', signature)
      .type('form')
      .send(params);
  }

  async function victimCounts(tenantId: string): Promise<VictimCounts> {
    const q = async (sql: string): Promise<number> => {
      const { rows } = await pool.query<{ n: number }>(sql, [tenantId]);
      return Number(rows[0]!.n);
    };
    return {
      voiceSessions: await q(`SELECT count(*)::int AS n FROM voice_sessions WHERE tenant_id = $1`),
      leads: await q(`SELECT count(*)::int AS n FROM leads WHERE tenant_id = $1`),
      customers: await q(`SELECT count(*)::int AS n FROM customers WHERE tenant_id = $1`),
      auditEvents: await q(`SELECT count(*)::int AS n FROM audit_events WHERE tenant_id = $1`),
    };
  }

  /** The rows the recording/voicemail callbacks would plant under a victim. */
  async function recordingCount(tenantId: string): Promise<number> {
    const { rows } = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM voice_recordings WHERE tenant_id = $1`,
      [tenantId],
    );
    return Number(rows[0]!.n);
  }

  async function sessionsForCall(callSid: string): Promise<Array<{ tenant_id: string }>> {
    const { rows } = await pool.query<{ tenant_id: string }>(
      `SELECT tenant_id FROM voice_sessions WHERE call_sid = $1`,
      [callSid],
    );
    return rows;
  }

  /**
   * `voice_sessions` is written fire-and-forget by the adapter
   * (twilio-adapter.ts:1073), so a positive assertion has to wait for the row
   * rather than read immediately after the HTTP response.
   */
  async function waitForSession(callSid: string, timeoutMs = 10000): Promise<Array<{ tenant_id: string }>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const rows = await sessionsForCall(callSid);
      if (rows.length > 0) return rows;
      if (Date.now() > deadline) return rows;
      await new Promise((resolve) => { setTimeout(resolve, 100); });
    }
  }

  /** Settle window for the same fire-and-forget writes on a NEGATIVE assertion. */
  async function settle(ms = 1500): Promise<void> {
    await new Promise((resolve) => { setTimeout(resolve, ms); });
  }

  /** The `<Gather action="…?sid=X">` the /voice TwiML hands back to Twilio. */
  function sessionIdFromTwiml(twiml: string): string | undefined {
    const m = /[?&]sid=([0-9a-f-]{36})/i.exec(twiml);
    return m?.[1];
  }

  beforeAll(async () => {
    pool = await getSharedTestDb();

    tenantA = await provision({ did: A_DID, subaccountSid: A_SUBACCOUNT, authToken: A_TOKEN });
    tenantB = await provision({ did: B_DID, subaccountSid: B_SUBACCOUNT, authToken: B_TOKEN });
    tenantDefault = await provision({
      did: `+1512${RUN}3`,
      subaccountSid: DEPLOYMENT_SUBACCOUNT,
      authToken: null,
    });

    // The deployment's own Twilio config — the four env vars config.ts's
    // feature gate requires whenever TELEPHONY_ENABLED is not 'false', plus
    // the encryption key every deployment already sets to hold tenant
    // credentials. None of them is a test-only seam.
    setEnv('NODE_ENV', 'test');
    setEnv('DATABASE_URL', process.env.TEST_DB_URL!);
    setEnv('DB_SSL', 'false');
    setEnv('PROCESS_ROLE', 'web');
    setEnv('TENANT_ENCRYPTION_KEY', ENCRYPTION_KEY);
    setEnv('PUBLIC_API_URL', PUBLIC_API_URL);
    setEnv('TWILIO_ACCOUNT_SID', DEPLOYMENT_SUBACCOUNT);
    setEnv('TWILIO_AUTH_TOKEN', DEPLOYMENT_TOKEN);
    setEnv('TWILIO_FROM_NUMBER', '+15125550000');
    setEnv('TWILIO_DEFAULT_TENANT_ID', tenantDefault.tenantId);
    // Gather is the proven transport and needs no STT/TTS stack; the
    // media-streams branch is not what this file is about.
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

  it('(b) tenant A\'s own credential dialling tenant A\'s DID is accepted and lands under A', async () => {
    const callSid = `CA-1072-a-${crypto.randomUUID().slice(0, 8)}`;
    const res = await signedPost(
      '/api/telephony/voice',
      { CallSid: callSid, AccountSid: A_SUBACCOUNT, From: CALLER, To: A_DID },
      A_TOKEN,
    );

    expect(res.status).toBe(200);
    expect(res.text).toContain('<Say');

    const rows = await waitForSession(callSid);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tenant_id).toBe(tenantA.tenantId);
  });

  it('(c) tenant B\'s own credential dialling tenant B\'s DID is accepted and lands under B', async () => {
    const callSid = `CA-1072-b-${crypto.randomUUID().slice(0, 8)}`;
    const res = await signedPost(
      '/api/telephony/voice',
      { CallSid: callSid, AccountSid: B_SUBACCOUNT, From: CALLER, To: B_DID },
      B_TOKEN,
    );

    expect(res.status).toBe(200);

    const rows = await waitForSession(callSid);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tenant_id).toBe(tenantB.tenantId);
  });

  it('(a) THE ATTACK — A\'s own AccountSid + A\'s own token + To=B\'s DID is refused 403 and writes NOTHING under B', async () => {
    const before = await victimCounts(tenantB.tenantId);
    const callSid = `CA-1072-forged-${crypto.randomUUID().slice(0, 8)}`;

    // Tenant A uses ONLY credentials it legitimately owns. The one hostile
    // field is `To` — the victim's public business number.
    const forged = await signedPost(
      '/api/telephony/voice',
      { CallSid: callSid, AccountSid: A_SUBACCOUNT, From: CALLER, To: B_DID },
      A_TOKEN,
    );

    expect(forged.status).toBe(403);

    await settle();
    expect(await sessionsForCall(callSid)).toHaveLength(0);
    expect(await victimCounts(tenantB.tenantId)).toEqual(before);
  });

  it('(a2) the attack is refused even with the AccountSid omitted entirely', async () => {
    const before = await victimCounts(tenantB.tenantId);
    const callSid = `CA-1072-forged-nosid-${crypto.randomUUID().slice(0, 8)}`;

    // With no AccountSid there is nothing to cross-check — the refusal has to
    // come from verifying against the DID owner's token, not from the SID
    // comparison alone.
    const forged = await signedPost(
      '/api/telephony/voice',
      { CallSid: callSid, From: CALLER, To: B_DID },
      A_TOKEN,
    );

    expect(forged.status).toBe(403);
    await settle();
    expect(await sessionsForCall(callSid)).toHaveLength(0);
    expect(await victimCounts(tenantB.tenantId)).toEqual(before);
  });

  it('(d1) /gather — a forged callback carrying the victim\'s DID is refused 403 and writes nothing under B', async () => {
    // A real session under B first, so the forged /gather names a LIVE sid
    // and the only thing standing between it and tenant B is the credential
    // binding.
    const callSid = `CA-1072-gather-b-${crypto.randomUUID().slice(0, 8)}`;
    const voice = await signedPost(
      '/api/telephony/voice',
      { CallSid: callSid, AccountSid: B_SUBACCOUNT, From: CALLER, To: B_DID },
      B_TOKEN,
    );
    expect(voice.status).toBe(200);
    const sid = sessionIdFromTwiml(voice.text);
    expect(sid, `no ?sid= in TwiML: ${voice.text}`).toBeDefined();

    const before = await victimCounts(tenantB.tenantId);

    const forged = await signedPost(
      `/api/telephony/gather?sid=${sid}`,
      {
        CallSid: callSid,
        AccountSid: A_SUBACCOUNT,
        From: CALLER,
        To: B_DID,
        SpeechResult: 'I would like to book an appointment',
        Confidence: '0.95',
      },
      A_TOKEN,
    );

    expect(forged.status).toBe(403);
    await settle();
    expect(await victimCounts(tenantB.tenantId)).toEqual(before);
  });

  it('(d2) /gather — tenant B\'s own credential on its own DID still works', async () => {
    const callSid = `CA-1072-gather-ok-${crypto.randomUUID().slice(0, 8)}`;
    const voice = await signedPost(
      '/api/telephony/voice',
      { CallSid: callSid, AccountSid: B_SUBACCOUNT, From: CALLER, To: B_DID },
      B_TOKEN,
    );
    expect(voice.status).toBe(200);
    const sid = sessionIdFromTwiml(voice.text);

    const gather = await signedPost(
      `/api/telephony/gather?sid=${sid}`,
      {
        CallSid: callSid,
        AccountSid: B_SUBACCOUNT,
        From: CALLER,
        To: B_DID,
        SpeechResult: 'I smell gas in my kitchen and it is getting stronger',
        Confidence: '0.95',
      },
      B_TOKEN,
    );

    // The credential is accepted (the point of this leg); the deterministic
    // E1 safety scan runs before any LLM call, so no AI key is needed.
    expect(gather.status).toBe(200);
    expect(gather.text).toContain('911');
  });

  it('(d3) the recording status callback — A\'s credential naming B\'s DID is refused 403', async () => {
    const before = await victimCounts(tenantB.tenantId);
    const callSid = `CA-1072-rec-${crypto.randomUUID().slice(0, 8)}`;

    // `Called` is the field Twilio uses on the recording callback's tenant
    // fallback path (recording-webhook.ts:253).
    const forged = await signedPost(
      '/api/telephony/recording',
      {
        CallSid: callSid,
        AccountSid: A_SUBACCOUNT,
        Called: B_DID,
        Caller: CALLER,
        RecordingSid: `RE-1072-${crypto.randomUUID().slice(0, 8)}`,
        RecordingUrl: 'https://api.twilio.com/2010-04-01/Recordings/RE-1072',
        RecordingDuration: '7',
      },
      A_TOKEN,
    );

    expect(forged.status).toBe(403);
    await settle();
    expect(await victimCounts(tenantB.tenantId)).toEqual(before);
  });

  it('(d4) the voicemail status callback — A\'s credential naming B\'s DID is refused 403', async () => {
    const before = await victimCounts(tenantB.tenantId);
    const callSid = `CA-1072-vm-${crypto.randomUUID().slice(0, 8)}`;

    const forged = await signedPost(
      '/api/telephony/voicemail-status',
      {
        CallSid: callSid,
        AccountSid: A_SUBACCOUNT,
        Called: B_DID,
        Caller: CALLER,
        RecordingSid: `RE-1072-vm-${crypto.randomUUID().slice(0, 8)}`,
        RecordingUrl: 'https://api.twilio.com/2010-04-01/Recordings/RE-1072-vm',
        RecordingStatus: 'completed',
        RecordingDuration: '9',
      },
      A_TOKEN,
    );

    expect(forged.status).toBe(403);
    await settle();
    expect(await victimCounts(tenantB.tenantId)).toEqual(before);
  });

  /**
   * (f) — the second half of the binding, found by review on PR #1082.
   *
   * Binding the credential to the DIALLED NUMBER proves the caller owns SOME
   * number; on the session-scoped callbacks (`?sid=`) it does NOT prove the
   * caller owns THE CALL. An attacker signing with its OWN DID and its OWN
   * token clears the credential check and then names the victim's live session
   * id, driving the victim's in-flight call: the utterance lands in their
   * transcript, their FSM advances, and the TwiML the victim's caller hears is
   * the attacker's to shape.
   *
   * `sid` is a random UUID, so this needs the session id rather than being
   * trivially reachable — but an unguessable identifier is not authorization,
   * which is the whole premise of #1072.
   */
  it('(f1) /gather — the attacker\'s OWN DID and token cannot drive the VICTIM\'s live session', async () => {
    const callSid = `CA-1072-hijack-${crypto.randomUUID().slice(0, 8)}`;
    const voice = await signedPost(
      '/api/telephony/voice',
      { CallSid: callSid, AccountSid: B_SUBACCOUNT, From: CALLER, To: B_DID },
      B_TOKEN,
    );
    expect(voice.status).toBe(200);
    const victimSid = sessionIdFromTwiml(voice.text);
    expect(victimSid, `no ?sid= in TwiML: ${voice.text}`).toBeDefined();

    const before = await victimCounts(tenantB.tenantId);

    // Every credential here is one tenant A legitimately owns — its own DID in
    // `To`, its own AccountSid, its own token. The only hostile field is `sid`.
    const forged = await signedPost(
      `/api/telephony/gather?sid=${victimSid}`,
      {
        CallSid: callSid,
        AccountSid: A_SUBACCOUNT,
        From: CALLER,
        To: A_DID,
        SpeechResult: 'I smell gas in my kitchen and it is getting stronger',
        Confidence: '0.95',
      },
      A_TOKEN,
    );

    expect(forged.status).toBe(403);
    await settle();
    expect(await victimCounts(tenantB.tenantId)).toEqual(before);
  });

  it('(f2) /dial-result — the same session-scoped hijack is refused', async () => {
    const callSid = `CA-1072-hijack-dial-${crypto.randomUUID().slice(0, 8)}`;
    const voice = await signedPost(
      '/api/telephony/voice',
      { CallSid: callSid, AccountSid: B_SUBACCOUNT, From: CALLER, To: B_DID },
      B_TOKEN,
    );
    expect(voice.status).toBe(200);
    const victimSid = sessionIdFromTwiml(voice.text);

    const before = await victimCounts(tenantB.tenantId);

    const forged = await signedPost(
      `/api/telephony/dial-result?sid=${victimSid}`,
      {
        CallSid: callSid,
        AccountSid: A_SUBACCOUNT,
        From: CALLER,
        To: A_DID,
        DialCallStatus: 'no-answer',
      },
      A_TOKEN,
    );

    expect(forged.status).toBe(403);
    await settle();
    expect(await victimCounts(tenantB.tenantId)).toEqual(before);
  });

  it('(f3) a tenant driving its OWN session through /gather is untouched by the session check', async () => {
    const callSid = `CA-1072-own-session-${crypto.randomUUID().slice(0, 8)}`;
    const voice = await signedPost(
      '/api/telephony/voice',
      { CallSid: callSid, AccountSid: A_SUBACCOUNT, From: CALLER, To: A_DID },
      A_TOKEN,
    );
    expect(voice.status).toBe(200);
    const ownSid = sessionIdFromTwiml(voice.text);

    const gather = await signedPost(
      `/api/telephony/gather?sid=${ownSid}`,
      {
        CallSid: callSid,
        AccountSid: A_SUBACCOUNT,
        From: CALLER,
        To: A_DID,
        SpeechResult: 'I smell gas in my kitchen and it is getting stronger',
        Confidence: '0.95',
      },
      A_TOKEN,
    );

    expect(gather.status).toBe(200);
    expect(gather.text).toContain('911');
  });

  /**
   * (f4)/(f5) — the third leg of the same shape, found by the Fable gate on
   * PR #1082.
   *
   * `/recording` and `/voicemail-status` resolve the tenant from the session
   * the payload's `CallSid` names ("immune to forged payloads" — true about
   * WHICH tenant, but the caller picks the session). So an attacker signing
   * with its OWN DID and OWN token, naming the VICTIM's live CallSid, gets its
   * attacker-supplied `RecordingUrl` attached to the victim's call: stored
   * under the victim's storage key, written into the victim's rows, and — on
   * the voicemail leg — minted into a lead under the victim from
   * attacker-controlled content. That is a write INTO the victim, not just a
   * hijack of their call.
   */
  it('(f4) /recording — the attacker\'s OWN credential cannot attach a recording to the VICTIM\'s call', async () => {
    const callSid = `CA-1072-rec-hijack-${crypto.randomUUID().slice(0, 8)}`;
    const voice = await signedPost(
      '/api/telephony/voice',
      { CallSid: callSid, AccountSid: B_SUBACCOUNT, From: CALLER, To: B_DID },
      B_TOKEN,
    );
    expect(voice.status).toBe(200);

    const before = await victimCounts(tenantB.tenantId);

    // A's own DID in `Called`, A's own AccountSid, A's own token — every
    // credential legitimately A's. The hostile field is the victim's CallSid.
    const forged = await signedPost(
      '/api/telephony/recording',
      {
        CallSid: callSid,
        AccountSid: A_SUBACCOUNT,
        Called: A_DID,
        Caller: CALLER,
        RecordingSid: `RE-1072-hijack-${crypto.randomUUID().slice(0, 8)}`,
        RecordingUrl: 'https://api.twilio.com/2010-04-01/Recordings/RE-attacker',
        RecordingDuration: '11',
      },
      A_TOKEN,
    );

    expect(forged.status).toBe(403);
    await settle();
    expect(await victimCounts(tenantB.tenantId)).toEqual(before);
    expect(await recordingCount(tenantB.tenantId)).toBe(0);
  });

  it('(f5) /voicemail-status — the same hijack cannot mint a lead under the VICTIM', async () => {
    const callSid = `CA-1072-vm-hijack-${crypto.randomUUID().slice(0, 8)}`;
    const voice = await signedPost(
      '/api/telephony/voice',
      { CallSid: callSid, AccountSid: B_SUBACCOUNT, From: CALLER, To: B_DID },
      B_TOKEN,
    );
    expect(voice.status).toBe(200);

    const before = await victimCounts(tenantB.tenantId);

    const forged = await signedPost(
      '/api/telephony/voicemail-status',
      {
        CallSid: callSid,
        AccountSid: A_SUBACCOUNT,
        Called: A_DID,
        Caller: CALLER,
        RecordingSid: `RE-1072-vm-hijack-${crypto.randomUUID().slice(0, 8)}`,
        RecordingUrl: 'https://api.twilio.com/2010-04-01/Recordings/RE-attacker-vm',
        RecordingStatus: 'completed',
        RecordingDuration: '13',
      },
      A_TOKEN,
    );

    expect(forged.status).toBe(403);
    await settle();
    // The lead leg is what this callback mints; it must not have run under B.
    expect(await victimCounts(tenantB.tenantId)).toEqual(before);
  });

  /**
   * (g) — whisper must NOT be bound to the dialled number, found by Codex
   * review on PR #1082.
   *
   * `GET /api/telephony/whisper/:escalationId` is the OUTBOUND dispatcher leg
   * of an escalation: Twilio dials the dispatcher and fetches this TwiML to
   * play in their ear. Its `To` is therefore the DISPATCHER's number, not the
   * tenant's inbound DID — and Twilio sends the standard call params as QUERY
   * parameters on a GET, so the binding sees it.
   *
   * If that dispatcher number happens to be another tenant's DID (two
   * businesses under one owner, a sister branch, an answering service that is
   * itself a tenant), the binding picks THAT tenant, finds the originating
   * subaccount foreign, and refuses — killing the whisper on an escalation.
   * The route's own header says an error here risks dropping the call
   * ("NEVER 404 — that would drop the call"), and escalation is the safety
   * path, so this must resolve by AccountSid as it did before #1072.
   *
   * Note the mount order this pins: the telephony router's signature
   * middleware runs for ANY `/api/telephony/*` request, matched route or not,
   * so exempting whisper at its own mount alone would not have worked — the
   * main router refuses first.
   */
  it('(g1) whisper — a dispatcher leg whose To belongs to another tenant is NOT refused', async () => {
    const escalationId = crypto.randomUUID();
    const path =
      `/api/telephony/whisper/${escalationId}` +
      `?AccountSid=${encodeURIComponent(A_SUBACCOUNT)}` +
      `&To=${encodeURIComponent(B_DID)}` +
      `&From=${encodeURIComponent(A_DID)}` +
      `&CallSid=${encodeURIComponent(`CA-1072-whisper-${crypto.randomUUID().slice(0, 8)}`)}`;

    // Twilio signs a GET over the full URL (query string included) with no
    // params object — the same way it will in production.
    const signature = twilio.getExpectedTwilioSignature(
      A_TOKEN,
      `${PUBLIC_API_URL}${path}`,
      {},
    );
    const res = await request(app).get(path).set('X-Twilio-Signature', signature);

    // 200 with empty TwiML (the escalation id is not in this process's cache)
    // is the correct answer; a 403 means tenant A's own escalation was killed
    // because the number it dialled happens to belong to tenant B.
    expect(res.status).toBe(200);
  });

  /**
   * (f6)/(f7) — the alias-precedence gap, found by Codex review on PR #1082.
   *
   * The credential binding reads the dialled number as `To` first, then
   * `Called`; both status-callback handlers resolve their FALLBACK tenant as
   * `Called` first, then `To`. Send both, pointing at different tenants, and
   * the two disagree: the credential is checked against the attacker's own DID
   * in `To` (so it verifies), while the handler acts as the tenant owning
   * `Called` — the victim. #1072's original defect in a narrower form.
   *
   * It needs no session, which is exactly the path the fallback exists for: a
   * callback landing on a fresh instance, after a restart, or past the reap
   * window. `sessionBelongsToAnotherTenant` deliberately permits a missing
   * session, so nothing else stood in the way.
   */
  it('(f6) /recording — To and Called naming different tenants cannot write under the one in Called', async () => {
    const before = await victimCounts(tenantB.tenantId);
    // A CallSid with no in-process session, so the handler takes the fallback path.
    const callSid = `CA-1072-alias-rec-${crypto.randomUUID().slice(0, 8)}`;

    const forged = await signedPost(
      '/api/telephony/recording',
      {
        CallSid: callSid,
        AccountSid: A_SUBACCOUNT,
        To: A_DID, // binds the credential to the attacker…
        Called: B_DID, // …while the handler resolves the victim
        Caller: CALLER,
        RecordingSid: `RE-1072-alias-${crypto.randomUUID().slice(0, 8)}`,
        RecordingUrl: 'https://api.twilio.com/2010-04-01/Recordings/RE-attacker-alias',
        RecordingDuration: '17',
      },
      A_TOKEN,
    );

    expect(forged.status).toBe(403);
    await settle();
    expect(await victimCounts(tenantB.tenantId)).toEqual(before);
    expect(await recordingCount(tenantB.tenantId)).toBe(0);
  });

  it('(f7) /voicemail-status — the same alias split cannot mint a lead under the tenant in Called', async () => {
    const before = await victimCounts(tenantB.tenantId);
    const callSid = `CA-1072-alias-vm-${crypto.randomUUID().slice(0, 8)}`;

    const forged = await signedPost(
      '/api/telephony/voicemail-status',
      {
        CallSid: callSid,
        AccountSid: A_SUBACCOUNT,
        To: A_DID,
        Called: B_DID,
        Caller: CALLER,
        RecordingSid: `RE-1072-alias-vm-${crypto.randomUUID().slice(0, 8)}`,
        RecordingUrl: 'https://api.twilio.com/2010-04-01/Recordings/RE-attacker-alias-vm',
        RecordingStatus: 'completed',
        RecordingDuration: '19',
      },
      A_TOKEN,
    );

    expect(forged.status).toBe(403);
    await settle();
    // The lead leg runs before any fetch, so a lead under B is the sharp tell.
    expect(await victimCounts(tenantB.tenantId)).toEqual(before);
  });

  it('(e) a number with NO tenant integration row still verifies with the deployment fallback token', async () => {
    const callSid = `CA-1072-fallback-${crypto.randomUUID().slice(0, 8)}`;
    const res = await signedPost(
      '/api/telephony/voice',
      { CallSid: callSid, AccountSid: DEPLOYMENT_SUBACCOUNT, From: CALLER, To: UNOWNED_DID },
      DEPLOYMENT_TOKEN,
    );

    // The signature is accepted (a 403 here would mean the fallback path was
    // dropped); an unowned DID then resolves through the dev seam.
    expect(res.status).toBe(200);
  });

  it('(e2) the fallback token does NOT open a path into a tenant that owns its own credential', async () => {
    const before = await victimCounts(tenantB.tenantId);
    const callSid = `CA-1072-fallback-forged-${crypto.randomUUID().slice(0, 8)}`;

    // The deployment's master token is not tenant B's token: once B owns a
    // credential, only B's credential may drive B's DID.
    const forged = await signedPost(
      '/api/telephony/voice',
      { CallSid: callSid, AccountSid: DEPLOYMENT_SUBACCOUNT, From: CALLER, To: B_DID },
      DEPLOYMENT_TOKEN,
    );

    expect(forged.status).toBe(403);
    await settle();
    expect(await sessionsForCall(callSid)).toHaveLength(0);
    expect(await victimCounts(tenantB.tenantId)).toEqual(before);
  });
});

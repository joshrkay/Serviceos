/**
 * #1014 row 2.5, phone-surface leg (lane B) — hermetic reachability on the
 * phone surface, per the definition research ticket #1004 recorded verbatim
 * on map #995:
 *
 *   "a Playwright test process, with no live Twilio call, no SQL [beyond
 *   ordinary tenant provisioning], no platform-admin action, and no
 *   environment variable beyond what a normally-provisioned tenant's own
 *   Twilio integration already supplies, drives the story by constructing a
 *   Twilio-shaped HTTP request … and computing its X-Twilio-Signature header
 *   itself via the same offline HMAC-SHA1 algorithm Twilio's servers use —
 *   getExpectedTwilioSignature(authToken, url, params), keyed on the
 *   tenant's own auth token already sitting encrypted in
 *   tenant_integrations — then POSTs that request through the real Express
 *   route (requireTwilioSignature → TwilioGatherAdapter)".
 *
 * The E1 life-safety story is the one phone row that can be driven this way
 * with nothing stubbed at all: the deterministic safety scan runs BEFORE any
 * LLM call (twilio-adapter.ts:2185), so no AI provider key is needed for the
 * capability under test. (The row 2.4 stranger case cannot: its whole point
 * is an intent CLASSIFICATION, which needs a live model on this surface.
 * 2.4 is proven at the handler seam instead —
 * packages/api/test/integration/stranger-owner-capability.test.ts.)
 *
 * Deliberately NOT the `chromium-devauth` project: per the correction on
 * #1014, that project forces InMemory repositories and TELEPHONY_ENABLED=false,
 * so a claim on it would fail "mocked is not proven". This spec runs in the
 * default `chromium` project against the legacy webServer pair, whose API
 * process receives DATABASE_URL from the E2E_USE_TEST_DB testcontainer that
 * e2e/global-setup.ts bootstraps.
 *
 * No browser is used — the `request` fixture is the whole point: the caller
 * here is Twilio, not a person at a screen.
 *
 * HOW TO RUN (see the lane report for the recorded invocation):
 *   DATABASE_URL=postgres://test:test@localhost:<port>/serviceos_test \
 *   E2E_DEV_AUTH=0 \
 *   TWILIO_ACCOUNT_SID=AC00000000000000000000000000000001 \
 *   TWILIO_AUTH_TOKEN=<any> TWILIO_FROM_NUMBER=+15125550000 \
 *   TWILIO_DEFAULT_TENANT_ID=<uuid> \
 *   TENANT_ENCRYPTION_KEY=<64 hex chars> \
 *   PUBLIC_API_URL=http://localhost:3000 \
 *   npx playwright test --project=chromium e2e/telephony-e1-signed-webhook.spec.ts
 *
 * The four env vars are the deployment's own Twilio config (config.ts's
 * feature gate requires them whenever TELEPHONY_ENABLED is not 'false') plus
 * the encryption key every deployment already sets to hold tenant
 * credentials — not a test-only seam, and the signature is keyed on the
 * TENANT's token from tenant_integrations, not on any of them.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { Pool } from 'pg';
import crypto from 'node:crypto';
import twilio from 'twilio';
import { encrypt } from '../packages/api/src/integrations/crypto';

/**
 * Trailing slashes are stripped exactly as `reconstructWebhookUrl`
 * (packages/api/src/telephony/twilio-signature.ts:61) strips them. Without
 * this, a `PUBLIC_API_URL` ending in `/` makes the spec sign
 * `http://host//api/telephony/voice` while the server verifies
 * `http://host/api/telephony/voice` — the HMACs differ, every signed request
 * comes back 403, and it reads as the product rejecting valid signatures
 * rather than as a test bug. (Codex review, PR #1054.)
 */
const stripTrailingSlash = (url: string): string => url.replace(/\/+$/, '');

const API_URL = stripTrailingSlash(process.env.E2E_API_URL ?? 'http://localhost:3000');
/**
 * The URL the API itself signs against — `requireTwilioSignature`
 * reconstructs it from PUBLIC_API_URL, so the spec must compute the HMAC over
 * exactly that string, not over API_URL, when the two differ.
 */
const SIGNING_BASE = stripTrailingSlash(process.env.PUBLIC_API_URL ?? API_URL);

/**
 * The DID → tenant lookup (`PgPhoneNumberRepository.findByNumber`) is a
 * `LIMIT 1` with no ORDER BY, so two tenants provisioned with the SAME DID
 * make routing non-deterministic. A per-run number keeps each invocation
 * independent; the beforeAll below also clears any earlier run's rows for
 * these two numbers so a retry re-provisions cleanly.
 */
const RUN = crypto.randomInt(1000, 9999);
const A_DID = `+1512${RUN}101`;
const B_DID = `+1512${RUN}102`;
const A_SUBACCOUNT = 'AC1014aaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const B_SUBACCOUNT = 'AC1014bbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const A_TOKEN = 'tenant-a-twilio-auth-token-1014';
const B_TOKEN = 'tenant-b-twilio-auth-token-1014';
const CALLER = '+15125557199';
const EN_GAS = 'I smell gas in my kitchen and it is getting stronger';

const enc = process.env.TENANT_ENCRYPTION_KEY;
/**
 * A real Postgres is the requirement — either the ephemeral testcontainer
 * e2e/global-setup.ts bootstraps (E2E_USE_TEST_DB=true) or an externally
 * provisioned test DB passed in as DATABASE_URL. The latter is what a run
 * needs in practice: Playwright evaluates playwright.config.ts (and with it
 * `apiWebServerEnv`) BEFORE globalSetup runs, so a DATABASE_URL that
 * globalSetup sets never reaches the API webServer's env — the API would fall
 * back to InMemory repositories and the tenant's own Twilio credential would
 * not be found. Provision the DB first and pass DATABASE_URL in.
 */
const dbReady = !!process.env.DATABASE_URL;

let pool: Pool;
let tenantA: string;
let tenantB: string;

interface Tenant {
  tenantId: string;
  did: string;
  subaccountSid: string;
  authToken: string;
}

test.describe.configure({ mode: 'serial' });

test.describe('#1014 row 2.5 — E1 reachable on the phone surface via a self-signed Twilio webhook', () => {
  test.skip(
    !dbReady || !enc,
    'Needs a real Postgres (DATABASE_URL, migrated) and TENANT_ENCRYPTION_KEY ' +
      'so the tenant Twilio credential can be stored the way a provisioned ' +
      'tenant stores it. See the header for the invocation.',
  );

  /**
   * Provision a tenant exactly as the Twilio onboarding flow leaves it: an
   * owner, business settings, and ONE `tenant_integrations` row carrying the
   * DID, the subaccount SID, and the encrypted auth token. Nothing here is a
   * test-only column.
   */
  async function provision(t: Omit<Tenant, 'tenantId'>): Promise<string> {
    const tenantId = crypto.randomUUID();
    const userId = crypto.randomUUID();
    // `subscription_status` and `voice_agent_live_at` below are what a
    // subscribed tenant that has flipped its own go-live switch already
    // carries — the real `createVoiceGate` (voice/voice-gate.ts:30) runs for
    // this call and answers with voicemail TwiML for any tenant missing
    // either, so provisioning them is part of being a normal tenant, not a
    // test seam.
    await pool.query(
      `INSERT INTO tenants (id, owner_id, owner_email, name, subscription_status)
       VALUES ($1, $2, $3, $4, 'active')`,
      [tenantId, userId, `owner+${tenantId.slice(0, 8)}@example.com`, 'E1 Surface Shop'],
    );
    await pool.query(
      `INSERT INTO users (id, tenant_id, clerk_user_id, email, role) VALUES ($1, $2, $3, $4, 'owner')`,
      [userId, tenantId, userId, `owner+${tenantId.slice(0, 8)}@example.com`],
    );
    await pool.query(
      `INSERT INTO tenant_settings (id, tenant_id, business_name, timezone, region, voice_agent_live_at)
       VALUES ($1, $2, 'E1 Surface Shop', 'America/Chicago', 'TX', NOW())`,
      [crypto.randomUUID(), tenantId],
    );
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL app.current_tenant_id = '${tenantId}'`);
      await client.query(
        `INSERT INTO tenant_integrations
           (tenant_id, provider, status, provider_data, subaccount_sid, auth_token_primary_enc)
         VALUES ($1, 'twilio', 'full_readiness', $2::jsonb, $3, $4)`,
        [
          tenantId,
          JSON.stringify({ phoneE164: t.did }),
          t.subaccountSid,
          encrypt(t.authToken, enc!),
        ],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    return tenantId;
  }

  /**
   * A Twilio-shaped, self-signed webhook POST. The signature is computed
   * offline with the SAME algorithm Twilio's servers use, keyed on the
   * tenant's own auth token — the one piece that makes this hermetic rather
   * than mocked.
   */
  async function signedPost(
    request: APIRequestContext,
    path: string,
    params: Record<string, string>,
    authToken: string,
  ) {
    const signature = twilio.getExpectedTwilioSignature(
      authToken,
      `${SIGNING_BASE}${path}`,
      params,
    );
    return request.post(`${API_URL}${path}`, {
      headers: {
        'X-Twilio-Signature': signature,
        'content-type': 'application/x-www-form-urlencoded',
      },
      form: params,
    });
  }

  /** The `<Gather action="…?sid=X">` the /voice TwiML hands back to Twilio. */
  function sessionIdFromTwiml(twiml: string): string {
    const m = /[?&]sid=([0-9a-f-]{36})/i.exec(twiml);
    expect(m, `no ?sid= in TwiML: ${twiml}`).not.toBeNull();
    return m![1]!;
  }

  const emergencyRows = (tenantId: string) =>
    pool.query<{ event_type: string; metadata: Record<string, unknown> }>(
      `SELECT event_type, metadata FROM audit_events
        WHERE tenant_id = $1 AND event_type LIKE '%.emergency_detected'`,
      [tenantId],
    );

  test.beforeAll(async () => {
    if (!dbReady || !enc) return;
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    await pool.query(
      `DELETE FROM tenant_integrations
        WHERE provider = 'twilio' AND provider_data->>'phoneE164' = ANY($1)`,
      [[A_DID, B_DID]],
    );
    tenantA = await provision({
      did: A_DID,
      subaccountSid: A_SUBACCOUNT,
      authToken: A_TOKEN,
    });
    tenantB = await provision({
      did: B_DID,
      subaccountSid: B_SUBACCOUNT,
      authToken: B_TOKEN,
    });
  });

  test.afterAll(async () => {
    await pool?.end();
  });

  test('an UNSIGNED inbound webhook is rejected — the signature genuinely gates the surface', async ({
    request,
  }) => {
    const res = await request.post(`${API_URL}/api/telephony/voice`, {
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      form: {
        CallSid: `CA-unsigned-${crypto.randomUUID().slice(0, 8)}`,
        AccountSid: A_SUBACCOUNT,
        From: CALLER,
        To: A_DID,
      },
    });
    expect(res.status()).toBe(403);
  });

  test('a self-signed Twilio webhook reaches the E1 life-safety path through the real /api/telephony routes', async ({
    request,
  }) => {
    const callSid = `CA-e1-surface-${crypto.randomUUID().slice(0, 8)}`;

    // 1. The inbound call, signed with tenant A's own Twilio auth token and
    //    routed to tenant A purely by its DID (`To`).
    const voice = await signedPost(
      request,
      '/api/telephony/voice',
      { CallSid: callSid, AccountSid: A_SUBACCOUNT, From: CALLER, To: A_DID },
      A_TOKEN,
    );
    expect(voice.status()).toBe(200);
    const greeting = await voice.text();
    const sid = sessionIdFromTwiml(greeting);

    // 2. The caller reports a gas leak. No AI key is configured for this run —
    //    if E1 recognition needed a model, this turn could not produce the
    //    life-safety TwiML.
    const gather = await signedPost(
      request,
      `/api/telephony/gather?sid=${sid}`,
      // `To`/`From` ride EVERY Twilio webhook for a call, the <Gather>
      // action callback included — and the /gather route resolves the tenant
      // from `To` through the legacy resolver (routes/telephony.ts:622 →
      // app.ts:3791), never through `phoneNumberRepo`. Omitting them is what
      // makes a hand-rolled replay fall back to TWILIO_DEFAULT_TENANT_ID.
      {
        CallSid: callSid,
        AccountSid: A_SUBACCOUNT,
        From: CALLER,
        To: A_DID,
        SpeechResult: EN_GAS,
        Confidence: '0.95',
      },
      A_TOKEN,
    );
    expect(gather.status()).toBe(200);
    const twiml = await gather.text();

    // The caller is directed to 911 and the call CLOSES — no further <Gather>,
    // no dispatcher bridge.
    expect(twiml).toContain('911');
    expect(twiml).toContain('<Hangup/>');
    expect(twiml).not.toContain('<Gather');

    // 3. The durable record, read straight out of the ephemeral Postgres the
    //    API process is itself writing to.
    const rows = await emergencyRows(tenantA);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]!.metadata).toMatchObject({
      tier: 'E1',
      reason: 'life_safety_e1',
      keyword: 'smell gas',
    });
  });

  test("T1: the same caller signed with tenant B's token and dialling tenant B's DID lands only in tenant B", async ({
    request,
  }) => {
    const beforeA = (await emergencyRows(tenantA)).rows.length;
    const callSid = `CA-e1-surface-b-${crypto.randomUUID().slice(0, 8)}`;

    const voice = await signedPost(
      request,
      '/api/telephony/voice',
      { CallSid: callSid, AccountSid: B_SUBACCOUNT, From: CALLER, To: B_DID },
      B_TOKEN,
    );
    expect(voice.status()).toBe(200);
    const sid = sessionIdFromTwiml(await voice.text());

    const gather = await signedPost(
      request,
      `/api/telephony/gather?sid=${sid}`,
      {
        CallSid: callSid,
        AccountSid: B_SUBACCOUNT,
        From: CALLER,
        To: B_DID,
        SpeechResult: EN_GAS,
        Confidence: '0.95',
      },
      B_TOKEN,
    );
    expect(await gather.text()).toContain('<Hangup/>');

    // Tenant B got its own E1 row; tenant A's count did not move.
    expect((await emergencyRows(tenantB)).rows).toHaveLength(1);
    expect((await emergencyRows(tenantA)).rows).toHaveLength(beforeA);
  });

  test('a payload signed with the wrong tenant\'s token is refused', async ({ request }) => {
    // Declares tenant B's AccountSid (so the middleware fetches B's token)
    // but is signed with A's. This is the ordinary bad-signature case — NOT
    // the cross-tenant boundary; see the GAP test below for why.
    const res = await signedPost(
      request,
      '/api/telephony/voice',
      {
        CallSid: `CA-wrong-token-${crypto.randomUUID().slice(0, 8)}`,
        AccountSid: B_SUBACCOUNT,
        From: CALLER,
        To: B_DID,
      },
      A_TOKEN,
    );
    expect(res.status()).toBe(403);
  });

  /**
   * ─── SECURITY GAP FOUND, NOT FIXED ────────────────────────────────────
   *
   * `/api/telephony/voice` resolves the signing credential and the tenant
   * from two INDEPENDENT body fields, and never checks that they agree:
   *
   *   - `resolveTwilioAuthTokenForSubaccount` (packages/api/src/app.ts:3756)
   *     picks the auth token by the body's `AccountSid`;
   *   - `resolveTenantIdByPhoneNumber` (app.ts:3791) picks the tenant by the
   *     body's `To`.
   *
   * So `requireTwilioSignature` verifies "is this signed by SOME tenant",
   * never "is this signed by THE tenant that owns the dialled number". A
   * tenant that legitimately holds its own Twilio credential can therefore
   * drive inbound calls into ANY other tenant by sending its OWN `AccountSid`
   * and a valid signature from its OWN token, with `To` set to the victim's
   * DID — which is public information, being their business phone number.
   *
   * That creates voice sessions, leads and customers under the victim tenant,
   * consumes their trial minutes, and writes into their audit trail. The
   * signature check is the only auth on this surface.
   *
   * The test above is the ordinary bad-signature case and does NOT cover
   * this: declaring B's `AccountSid` while signing with A's token makes the
   * middleware verify an A-signed payload with B's token, so its 403 is
   * guaranteed by construction and proves nothing about the boundary.
   * (Codex review caught exactly this, PR #1054.)
   *
   * NOT FIXED HERE: lane B is test-only and explicitly forbidden from
   * changing auth code. Pinned both ways, as with the Spanish E1 gap — the
   * current behaviour as a passing characterization, and the required
   * refusal as an `it.fails` that breaks loudly the day it is fixed.
   */
  test('SECURITY GAP (surfaced on #1014, NOT fixed here): a tenant can forge an inbound call into another tenant', async ({
    request,
  }) => {
    const callSid = `CA-forged-${crypto.randomUUID().slice(0, 8)}`;

    // Tenant A uses ONLY credentials it legitimately owns: its own
    // AccountSid, its own auth token. The one hostile field is `To`.
    const forged = await signedPost(
      request,
      '/api/telephony/voice',
      { CallSid: callSid, AccountSid: A_SUBACCOUNT, From: CALLER, To: B_DID },
      A_TOKEN,
    );

    // Today: accepted, and answered with tenant B's real greeting.
    expect(forged.status()).toBe(200);
    expect(await forged.text()).toContain('<Say');

    // …and the session is persisted under the VICTIM tenant.
    const session = await pool.query<{ tenant_id: string }>(
      `SELECT tenant_id FROM voice_sessions WHERE call_sid = $1`,
      [callSid],
    );
    expect(session.rows).toHaveLength(1);
    expect(session.rows[0]!.tenant_id).toBe(tenantB);
    expect(session.rows[0]!.tenant_id).not.toBe(tenantA);
  });

  /**
   * DESIRED behaviour — NOT met today. `.fails` for the same reason as the
   * Spanish E1 case: this lane may not fix auth, and a red CI would not be
   * this lane's to cause. The day the credential and the tenant are checked
   * against each other, this starts failing and is the signal to delete it,
   * promote the assertions into the test above, and re-grade.
   */
  test(
    'SECURITY DESIRED (currently FAILS, see the GAP above): a tenant-owned signature must not authorise a call to another tenant\'s DID',
    async ({ request }) => {
      // Playwright's `test.fail()` — its documented way to acknowledge that
      // functionality is broken until it is fixed. The test still RUNS, and
      // Playwright fails the run if it ever starts passing.
      test.fail();
      const callSid = `CA-forged-desired-${crypto.randomUUID().slice(0, 8)}`;

      const forged = await signedPost(
        request,
        '/api/telephony/voice',
        { CallSid: callSid, AccountSid: A_SUBACCOUNT, From: CALLER, To: B_DID },
        A_TOKEN,
      );

      // The credential belongs to tenant A; the dialled number belongs to
      // tenant B. The route must refuse rather than route it into B.
      expect(forged.status()).toBe(403);

      const session = await pool.query(
        `SELECT tenant_id FROM voice_sessions WHERE call_sid = $1`,
        [callSid],
      );
      expect(session.rows).toHaveLength(0);
    },
  );
});

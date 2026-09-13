/**
 * §8.5 row 5.3 (ticket #1018) — rung-5 reachability: "log my hours by
 * talking" on the phone surface, per the hermetic-phone-surface definition
 * from research #1004 (recorded on map #995) and the pattern already proven
 * by `e2e/telephony-e1-signed-webhook.spec.ts` (#1014 row 2.5): a self-signed
 * Twilio-shaped webhook, keyed on the tenant's OWN Twilio auth token, driven
 * through the real `/api/telephony/*` routes against real Postgres — no
 * mocked Twilio client, no platform-admin action, no env var beyond what a
 * normally-provisioned tenant's own integration already supplies.
 *
 * Full criterion this row wants: a `time_entries` row with the resolved
 * jobId, EXACTLY ONE audit event, tenant-scoped, AND counted by the
 * job-profit query (`getJobProfit`, packages/api/src/jobs/job-profit.ts).
 *
 * ─── HONEST STOP POINT (found while writing this spec; do not fake it) ────
 *
 * Every `SpeechResult` reaching `/api/telephony/gather` is classified by
 * `classifyIntent` (packages/api/src/ai/orchestration/intent-classifier.ts).
 * That file's `classifyIntentRaw` short-circuits BEFORE any LLM call for a
 * fixed, enumerated set of phrasings (owner/operator commands,
 * `lookup_estimates`, `lookup_balance`, `lookup_job_profit`, `en_route`,
 * `create_appointment`, `issue_invoice`, `update_job`, `add_crew_member`,
 * `apply_late_fee`, …) — `log_time_entry` has NO such matcher anywhere in
 * that file (grepped; only the type declaration and taxonomy entry exist).
 * So "log two hours on the Garcia job" falls through to the real LLM call at
 * `intent-classifier.ts:2772` (`gateway.complete({ taskType:
 * 'classify_intent', ... })`).
 *
 * `createLLMGateway` (packages/api/src/ai/gateway/factory.ts:100-108) throws
 * without `AI_PROVIDER_API_KEY`; the app avoids that crash at boot
 * (app.ts:1257-1258) by falling back to `createHermeticMockLLMGateway()`
 * whenever the key is unset — this is the SAME hermetic, no-key posture a
 * normally-provisioned CI/local run has, not a test-only shortcut this spec
 * injects. That gateway's `scriptHermeticResponse()` for `classify_intent`
 * (packages/api/src/ai/providers/mock.ts:160-196) only scripts
 * `create_customer`, `draft_estimate`, and `create_invoice`; everything else,
 * `log_time_entry` included, falls through to
 * `{"intentType":"unknown","confidence":0.2}` — far below `TAU_INT` (0.75).
 *
 * Consequence, confirmed by reading `handleGather`
 * (packages/api/src/telephony/twilio-adapter.ts:2392-2417): confidence below
 * `TAU_INT` or `intentType === 'unknown'` never reaches a task handler at
 * all — the FSM takes the low-intent-confidence repair path instead. No
 * `log_time_entry` proposal is drafted, `LogTimeEntryTaskHandler` /
 * `LogTimeEntryExecutionHandler` never run, no `time_entries` row is
 * written, no matching audit event fires.
 *
 * This is a real capability gap, not a test artifact: getting past it needs
 * EITHER a live `AI_PROVIDER_API_KEY` (a credential this hermetic run
 * legitimately does not have — blocked-on-Josh territory, #1000) OR a
 * deterministic matcher added to `classifyIntentRaw`/the hermetic mock — a
 * `packages/api/src` change this test-only lane is explicitly forbidden from
 * making. So this spec proves everything hermetically reachable UP TO that
 * seam — the signed inbound call, the caller-ID -> technician resolution,
 * and the classification attempt itself — and then PINS the stop: no
 * `log_time_entry` proposal, no `time_entries` row, no audit event, and the
 * job-profit query for the named job is unchanged. Per the lane's own rule
 * ("if it yields a proposal that needs approval, approve it") — it never
 * yields one, so that step is documented as unreached, not skipped silently.
 *
 * Requires: real, disposable Postgres (DATABASE_URL, migrated, plus
 * E2E_USE_TEST_DB=true so a BYO container gets truncated at end-of-run —
 * job-photo-attach.spec.ts's identical gate) + TENANT_ENCRYPTION_KEY.
 * AI_PROVIDER_API_KEY must be UNSET, in this shell AND in packages/api/.env
 * if present (this row's whole finding rests on the hermetic no-key mock
 * gateway — a real key would issue a live, paid classification call
 * instead). The effective media-streams setting (TWILIO_MEDIA_STREAMS_ENABLED,
 * or its ElevenLabs/Deepgram auto-enable — see resolveMediaStreamsEnabled)
 * must resolve to off (this spec assumes the Gather telephony path).
 * Deliberately NOT
 * `chromium-devauth` (forces InMemory repos + TELEPHONY_ENABLED=false). No
 * browser — the caller here is Twilio, not a person at a screen; the
 * `request` fixture is the whole point.
 *
 * HOW TO RUN:
 *   DATABASE_URL=postgres://test:test@localhost:<port>/serviceos_e2e_test \
 *   E2E_USE_TEST_DB=true \
 *   TWILIO_ACCOUNT_SID=AC00000000000000000000000000000001 \
 *   TWILIO_AUTH_TOKEN=<any> TWILIO_FROM_NUMBER=+15125550000 \
 *   TWILIO_DEFAULT_TENANT_ID=<uuid> \
 *   TENANT_ENCRYPTION_KEY=<64 hex chars> \
 *   PUBLIC_API_URL=http://localhost:3000 \
 *   TWILIO_MEDIA_STREAMS_ENABLED=false \
 *   npx playwright test --project=chromium e2e/journeys/log-time-by-voice.spec.ts \
 *     --reporter=line --retries=0
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { Pool } from 'pg';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import twilio from 'twilio';
import { encrypt } from '../../packages/api/src/integrations/crypto';
import { PgInvoiceRepository } from '../../packages/api/src/invoices/pg-invoice';
import { PgTimeEntryRepository } from '../../packages/api/src/time-tracking/pg-time-entry';
import { PgExpenseRepository } from '../../packages/api/src/expenses/pg-expense';
import { getJobProfit } from '../../packages/api/src/jobs/job-profit';
import { resolveMediaStreamsEnabled } from '../../packages/api/src/shared/config';

const stripTrailingSlash = (url: string): string => url.replace(/\/+$/, '');
const API_URL = stripTrailingSlash(process.env.E2E_API_URL ?? 'http://localhost:3000');
const SIGNING_BASE = stripTrailingSlash(process.env.PUBLIC_API_URL ?? API_URL);

// The subaccount SID (not just the DID) must be unique per run: the API
// resolves the signing credential by AccountSid alone
// (resolveTwilioAuthTokenForSubaccount), with no ORDER BY, so a rerun
// against a kept-alive testcontainer (this lane's own dev loop; teardown
// only truncates at end-of-run) would otherwise find MULTIPLE
// tenant_integrations rows sharing the same fixed SID from earlier
// invocations and could non-deterministically decrypt the WRONG run's
// auth token, producing a spurious 403 unrelated to the product. Found by
// running this spec twice against the same container while developing it.
const RUN = crypto.randomInt(1000, 9999);
const UNIQ = crypto.randomBytes(9).toString('hex'); // 18 hex chars, for the SID
const A_DID = `+1512${RUN}201`;
const B_DID = `+1512${RUN}202`;
const A_SUBACCOUNT = `AC1018a${UNIQ}`; // 'AC' + 32 chars, Twilio SID shape
const B_SUBACCOUNT = `AC1018b${UNIQ}`;
const A_TWILIO_TOKEN = `tenant-a-twilio-auth-token-1018-${UNIQ}`;
const B_TWILIO_TOKEN = `tenant-b-twilio-auth-token-1018-${UNIQ}`;
const A_TECH_MOBILE = `+1512${RUN}301`;
const B_TECH_MOBILE = `+1512${RUN}302`;
const UTTERANCE = 'log two hours on the Garcia job';

const enc = process.env.TENANT_ENCRYPTION_KEY;
// E2E_USE_TEST_DB=true is required (not just DATABASE_URL) so that, when
// DATABASE_URL points at a pre-existing (BYO) container, e2e/global-setup.ts
// writes the state file that makes e2e/global-teardown.ts run the BYO
// truncate path at end-of-run (teardown-test-db.ts) — without it, a
// developer who exports DATABASE_URL against a persistent dev database
// would have this spec's provisionTenant() insert real rows with no
// cleanup. Matches job-photo-attach.spec.ts's identical gate. (Codex review,
// PR #1114.)
const dbReady = !!process.env.DATABASE_URL && process.env.E2E_USE_TEST_DB === 'true';
// The hermetic no-key mock gateway is the premise of this row's entire
// "stop point" finding (see the header comment) — if AI_PROVIDER_API_KEY is
// inherited from the operator's shell into apiWebServerEnv, classification
// would hit a REAL, paid LLM instead, silently spending money and making
// this spec's zero-result assertions fail for a confusing reason. Fail
// closed with a clear message instead. (Codex review, PR #1114.)
//
// The API webServer boots via `node --env-file-if-exists=.env` (packages/api/
// package.json's `dev` script) — a SEPARATE source from this Playwright
// process's own env, so checking only `process.env.AI_PROVIDER_API_KEY` here
// misses a key set in packages/api/.env (Codex review, round 2, PR #1114).
// This spec cannot force-clear that file's effect on the API child process
// (that would mean editing the shared webServer config other specs rely on),
// so it detects it and fails closed instead of silently producing a
// live-model result.
function apiEnvFileHasLiveLlmKey(): boolean {
  const envPath = path.resolve(__dirname, '../../packages/api/.env');
  if (!fs.existsSync(envPath)) return false;
  const text = fs.readFileSync(envPath, 'utf8');
  return /^\s*AI_PROVIDER_API_KEY\s*=\s*\S+/m.test(text);
}
const noLiveLlmKey = !process.env.AI_PROVIDER_API_KEY && !apiEnvFileHasLiveLlmKey();
// This spec's TwiML parsing (sessionIdFromTwiml below) assumes the Gather
// telephony path (`<Gather action="...?sid=...">`). The real app doesn't
// just check `TWILIO_MEDIA_STREAMS_ENABLED === 'true'` — when that var is
// unset, `resolveMediaStreamsEnabled` (packages/api/src/shared/config.ts)
// AUTO-ENABLES streaming when the full ElevenLabs/Deepgram stack is already
// configured. A naive `!== 'true'` check misses that auto-enable branch
// (Codex review, round 2, PR #1114), so this imports and calls the real
// resolver rather than re-deriving its logic (and risking drift from it).
const gatherPathActive = !resolveMediaStreamsEnabled(process.env);

let pool: Pool;

interface TenantFixture {
  tenantId: string;
  did: string;
  subaccountSid: string;
  twilioToken: string;
  techMobile: string;
  jobId: string;
}

test.describe.configure({ mode: 'serial' });

test.describe('#1018 row 5.3 — "log my hours by talking" on the phone surface, real Postgres', () => {
  test.skip(
    !dbReady || !enc,
    'Needs a real, disposable Postgres (DATABASE_URL, migrated, E2E_USE_TEST_DB=true so it gets ' +
      'truncated at end-of-run) and TENANT_ENCRYPTION_KEY so the tenant Twilio credential can be ' +
      'stored the way a provisioned tenant stores it.',
  );
  test.skip(
    !noLiveLlmKey,
    'AI_PROVIDER_API_KEY is set (either in this shell or in packages/api/.env) — this spec\'s whole ' +
      'premise is the hermetic no-key mock gateway (see header comment); running with a real key ' +
      'would issue a live, paid classification call instead of hitting the documented stop point. ' +
      'Unset it (and remove it from packages/api/.env if present) for this run.',
  );
  test.skip(
    !gatherPathActive,
    'resolveMediaStreamsEnabled(process.env) resolves to true (either TWILIO_MEDIA_STREAMS_ENABLED=' +
      '\'true\', or it\'s unset/auto with the full ElevenLabs/Deepgram stack configured) — this spec ' +
      'assumes the Gather telephony path (`<Gather action="...?sid=...">`); Media Streams returns ' +
      'the session id in a <Parameter> instead, which sessionIdFromTwiml cannot parse. Set ' +
      'TWILIO_MEDIA_STREAMS_ENABLED=false for this run.',
  );

  async function provisionTenant(opts: {
    did: string;
    subaccountSid: string;
    twilioToken: string;
    techMobile: string;
  }): Promise<TenantFixture> {
    const tenantId = crypto.randomUUID();
    const ownerId = crypto.randomUUID();
    const techId = crypto.randomUUID();

    await pool.query(
      `INSERT INTO tenants (id, owner_id, owner_email, name, subscription_status)
       VALUES ($1, $2, $3, $4, 'active')`,
      [tenantId, ownerId, `owner+${tenantId.slice(0, 8)}@example.com`, 'Voice Time Log Shop'],
    );
    await pool.query(
      `INSERT INTO users (id, tenant_id, clerk_user_id, email, role) VALUES ($1, $2, $3, $4, 'owner')`,
      [ownerId, tenantId, ownerId, `owner+${tenantId.slice(0, 8)}@example.com`],
    );
    await pool.query(
      `INSERT INTO users (id, tenant_id, clerk_user_id, email, role, first_name, last_name, mobile_number)
       VALUES ($1, $2, $3, $4, 'technician', 'Field', 'Tech', $5)`,
      [techId, tenantId, techId, `tech+${tenantId.slice(0, 8)}@example.com`, opts.techMobile],
    );
    await pool.query(
      `INSERT INTO tenant_settings (id, tenant_id, business_name, timezone, region, voice_agent_live_at)
       VALUES ($1, $2, 'Voice Time Log Shop', 'America/Chicago', 'TX', NOW())`,
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
        [tenantId, JSON.stringify({ phoneE164: opts.did }), opts.subaccountSid, encrypt(opts.twilioToken, enc!)],
      );
      const customerId = crypto.randomUUID();
      await client.query(
        `INSERT INTO customers
           (id, tenant_id, first_name, last_name, display_name, preferred_channel, sms_consent, is_archived, created_by)
         VALUES ($1, $2, 'Maria', 'Garcia', 'Maria Garcia', 'phone', false, false, $3)`,
        [customerId, tenantId, ownerId],
      );
      const locationId = crypto.randomUUID();
      await client.query(
        `INSERT INTO service_locations
           (id, tenant_id, customer_id, street1, city, state, postal_code, country, is_primary, is_archived)
         VALUES ($1, $2, $3, '1 Garcia Way', 'Austin', 'TX', '78701', 'USA', true, false)`,
        [locationId, tenantId, customerId],
      );
      const jobId = crypto.randomUUID();
      await client.query(
        `INSERT INTO jobs (id, tenant_id, customer_id, location_id, job_number, summary, status, priority, created_by)
         VALUES ($1, $2, $3, $4, 'JOB-GARCIA-1', 'Garcia job', 'in_progress', 'normal', $5)`,
        [jobId, tenantId, customerId, locationId, ownerId],
      );
      await client.query('COMMIT');
      return { tenantId, did: opts.did, subaccountSid: opts.subaccountSid, twilioToken: opts.twilioToken, techMobile: opts.techMobile, jobId };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async function signedPost(
    request: APIRequestContext,
    path: string,
    params: Record<string, string>,
    authToken: string,
  ) {
    const signature = twilio.getExpectedTwilioSignature(authToken, `${SIGNING_BASE}${path}`, params);
    return request.post(`${API_URL}${path}`, {
      headers: { 'X-Twilio-Signature': signature, 'content-type': 'application/x-www-form-urlencoded' },
      form: params,
    });
  }

  function sessionIdFromTwiml(twiml: string): string {
    const m = /[?&]sid=([0-9a-f-]{36})/i.exec(twiml);
    expect(m, `no ?sid= in TwiML: ${twiml}`).not.toBeNull();
    return m![1]!;
  }

  async function timeEntryRows(tenantId: string, jobId: string) {
    return pool.query<{ id: string; job_id: string }>(
      `SELECT id, job_id FROM time_entries WHERE tenant_id = $1 AND job_id = $2`,
      [tenantId, jobId],
    );
  }

  async function timeEntryAuditRows(tenantId: string) {
    return pool.query<{ event_type: string }>(
      `SELECT event_type FROM audit_events WHERE tenant_id = $1 AND event_type LIKE 'time_entry.%'`,
      [tenantId],
    );
  }

  async function proposalRows(tenantId: string) {
    return pool.query<{ id: string; proposal_type: string; status: string }>(
      `SELECT id, proposal_type, status FROM proposals WHERE tenant_id = $1 AND proposal_type = 'log_time_entry'`,
      [tenantId],
    );
  }

  async function jobProfitLaborMinutes(tenantId: string, jobId: string): Promise<number> {
    const invoiceRepo = new PgInvoiceRepository(pool);
    const timeEntryRepo = new PgTimeEntryRepository(pool);
    const expenseRepo = new PgExpenseRepository(pool);
    const profit = await getJobProfit(
      { tenantId, jobId, laborRateCentsPerHour: null },
      { invoiceRepo, timeEntryRepo, expenseRepo },
    );
    return profit.laborMinutes;
  }

  test.beforeAll(async () => {
    if (!dbReady || !enc) return;
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
  });

  test.afterAll(async () => {
    await pool?.end();
  });

  let tenantA: TenantFixture;
  let tenantB: TenantFixture;

  test('a signed inbound call from the technician\'s registered mobile reaches the real telephony routes and resolves a session', async ({
    request,
  }) => {
    tenantA = await provisionTenant({
      did: A_DID,
      subaccountSid: A_SUBACCOUNT,
      twilioToken: A_TWILIO_TOKEN,
      techMobile: A_TECH_MOBILE,
    });

    const callSid = `CA-voice-time-a-${crypto.randomUUID().slice(0, 8)}`;
    const voice = await signedPost(
      request,
      '/api/telephony/voice',
      { CallSid: callSid, AccountSid: A_SUBACCOUNT, From: A_TECH_MOBILE, To: A_DID },
      A_TWILIO_TOKEN,
    );
    expect(voice.status(), `POST /api/telephony/voice -> ${await voice.text()}`).toBe(200);
    const sid = sessionIdFromTwiml(await voice.text());
    expect(sid).toMatch(/^[0-9a-f-]{36}$/i);

    const session = await pool.query(`SELECT tenant_id, call_sid FROM voice_sessions WHERE id = $1`, [sid]);
    expect(session.rows).toHaveLength(1);
    expect(session.rows[0].tenant_id).toBe(tenantA.tenantId);
  });

  test('RED then GREEN — "log two hours on the Garcia job" does not (today) become a time_entries row, because classification never reaches log_time_entry without a live LLM', async ({
    request,
  }) => {
    const before = await timeEntryRows(tenantA.tenantId, tenantA.jobId);
    expect(before.rows).toHaveLength(0);

    const callSid = `CA-voice-time-a-utterance-${crypto.randomUUID().slice(0, 8)}`;
    const voice = await signedPost(
      request,
      '/api/telephony/voice',
      { CallSid: callSid, AccountSid: A_SUBACCOUNT, From: A_TECH_MOBILE, To: A_DID },
      A_TWILIO_TOKEN,
    );
    const sid = sessionIdFromTwiml(await voice.text());

    const gather = await signedPost(
      request,
      `/api/telephony/gather?sid=${sid}`,
      {
        CallSid: callSid,
        AccountSid: A_SUBACCOUNT,
        From: A_TECH_MOBILE,
        To: A_DID,
        SpeechResult: UTTERANCE,
        Confidence: '0.95',
      },
      A_TWILIO_TOKEN,
    );
    expect(gather.status(), `POST /api/telephony/gather -> ${await gather.text()}`).toBe(200);
    const twiml = await gather.text();
    // The call stays open (low-intent-confidence repair re-prompts) rather
    // than erroring — the seam is reached and handled, just not resolved
    // into a proposal.
    expect(twiml).toContain('<Gather');

    // The honest stop, pinned as a passing assertion (this line is the
    // "GREEN" of this row's TDD pass — see the lane report for the RED run
    // where this same assertion was first written as
    // `expect(after.rows).toHaveLength(1)` and failed with 0 rows, proving
    // the gap before this file asserted around it):
    const after = await timeEntryRows(tenantA.tenantId, tenantA.jobId);
    expect(after.rows).toHaveLength(0);

    const proposals = await proposalRows(tenantA.tenantId);
    expect(proposals.rows).toHaveLength(0);

    const auditRows = await timeEntryAuditRows(tenantA.tenantId);
    expect(auditRows.rows).toHaveLength(0);

    const laborMinutes = await jobProfitLaborMinutes(tenantA.tenantId, tenantA.jobId);
    expect(laborMinutes).toBe(0);
  });

  test("T1: tenant B's technician calling tenant B's DID with the same utterance lands only under B, and tenant A's profit query is unchanged", async ({
    request,
  }) => {
    tenantB = await provisionTenant({
      did: B_DID,
      subaccountSid: B_SUBACCOUNT,
      twilioToken: B_TWILIO_TOKEN,
      techMobile: B_TECH_MOBILE,
    });

    const aMinutesBefore = await jobProfitLaborMinutes(tenantA.tenantId, tenantA.jobId);
    const aAuditBefore = (await timeEntryAuditRows(tenantA.tenantId)).rows.length;

    const callSid = `CA-voice-time-b-${crypto.randomUUID().slice(0, 8)}`;
    const voice = await signedPost(
      request,
      '/api/telephony/voice',
      { CallSid: callSid, AccountSid: B_SUBACCOUNT, From: B_TECH_MOBILE, To: B_DID },
      B_TWILIO_TOKEN,
    );
    expect(voice.status()).toBe(200);
    const sid = sessionIdFromTwiml(await voice.text());

    const sessionRow = await pool.query(`SELECT tenant_id FROM voice_sessions WHERE id = $1`, [sid]);
    expect(sessionRow.rows[0].tenant_id).toBe(tenantB.tenantId);
    expect(sessionRow.rows[0].tenant_id).not.toBe(tenantA.tenantId);

    const gather = await signedPost(
      request,
      `/api/telephony/gather?sid=${sid}`,
      {
        CallSid: callSid,
        AccountSid: B_SUBACCOUNT,
        From: B_TECH_MOBILE,
        To: B_DID,
        SpeechResult: UTTERANCE,
        Confidence: '0.95',
      },
      B_TWILIO_TOKEN,
    );
    expect(gather.status()).toBe(200);

    // Same stop point under B — reachable, tenant-scoped, not resolved.
    const bRows = await timeEntryRows(tenantB.tenantId, tenantB.jobId);
    expect(bRows.rows).toHaveLength(0);
    const bAudit = await timeEntryAuditRows(tenantB.tenantId);
    expect(bAudit.rows).toHaveLength(0);

    // A is untouched by B's call.
    const aMinutesAfter = await jobProfitLaborMinutes(tenantA.tenantId, tenantA.jobId);
    expect(aMinutesAfter).toBe(aMinutesBefore);
    const aAuditAfter = (await timeEntryAuditRows(tenantA.tenantId)).rows.length;
    expect(aAuditAfter).toBe(aAuditBefore);
  });
});

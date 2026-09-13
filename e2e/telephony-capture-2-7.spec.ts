/**
 * #1014 §8.2 row 2.7 — "As M, I want a caller who hangs up mid-booking to
 * get a text back, so a dropped call isn't a lost job." Acceptance: given
 * a call ending in `dropped`/`failed` with a usable number, when 60s
 * elapse, then exactly one recovery SMS sends, stamped and audited,
 * re-evaluated at send time.
 *
 * Phone-surface reachability leg (lane C, test/8-2-capture-r5) — the gap
 * the row was held on ("a signed dropped-call webhook → recovery SMS",
 * parked as E7 on #1000). Driven entirely through the real
 * `/api/telephony/voice` + `/gather` webhooks; NO Twilio call-status
 * webhook is involved — this codebase detects a "dropped" call from the
 * Gather FSM's OWN terminal-outcome derivation, not from a Twilio
 * CallStatus callback (verified by reading the source, not assumed):
 *
 *   - Two consecutive empty-`SpeechResult` `/gather` turns (Twilio's real
 *     `actionOnEmptyResult="true"` no-speech timeout behaviour) trip the
 *     shared silence/low-confidence ladder
 *     (`runLowSttConfidenceGatherLadder`, twilio-adapter.ts:2684), capped
 *     at `MAX_CONSECUTIVE_LOW_CONFIDENCE_TURNS = 2`
 *     (media-streams/mediastream-adapter.ts:490) — the SAME cap the Media
 *     Streams transport uses, so this is not a Gather-only quirk.
 *   - At the cap, `end_session` fires with reason
 *     `low_stt_confidence_max_retries`, which `deriveCallOutcome`
 *     (ai/agents/customer-calling/outcome-mapper.ts) does NOT special-case
 *     — it falls through every named branch to the generic `return
 *     'failed'`.
 *   - `'failed'` is one of exactly two outcomes `RECOVERY_OUTCOMES`
 *     (voice/recovery/detect-dropped.ts:21-24) arms a recovery for (the
 *     other is `'dropped'`, a plain caller-hangup-before-speaking) —
 *     `scheduleDurableRecoveryContext` (twilio-adapter.ts:3259) fires
 *     UNCONDITIONALLY on any terminal outcome, and the scheduler's own
 *     `shouldRecoverDroppedCall` predicate is what actually gates the
 *     `dropped_call_recoveries` row.
 *   - The row is scheduled `RECOVERY_DELAY_MS = 60_000`ms out
 *     (sms/recovery/scheduler.ts:31); the live worker sweeps every 30s
 *     (app.ts, "P8-015 — dropped-call recovery drain"), so worst-case
 *     latency is ~90s. This spec genuinely waits for it — no clock
 *     mocking, no backdated `scheduled_for` — since accelerating the wait
 *     would mean asserting on a state the product didn't produce on its
 *     own schedule.
 *   - The worker's SEND itself needs no live Twilio: this repo's delivery
 *     provider factory (notifications/delivery-provider-factory.ts)
 *     structurally cannot construct a real Twilio/SendGrid provider
 *     outside `NODE_ENV=production/staging` (or an explicit
 *     `DELIVERY_ALLOW_REAL_PROVIDERS=true` opt-in) — the e2e webServer
 *     runs `NODE_ENV=dev`, so `messageDelivery` is the built-in
 *     `InMemoryDeliveryProvider` automatically, with no test-only flag of
 *     this spec's own. `composeStateAwareCue` (sms/recovery/state-aware
 *     -cue.ts) is a plain template composer with no LLM gateway call, so
 *     no #1119-class model dependency exists on this row either.
 *   - The worker itself runs unprompted: `PROCESS_ROLE` defaults to
 *     `'all'` (shared/config.ts:94), so `shouldRunWorkers` is true with no
 *     extra env var.
 *
 * T3: `dropped_call_recovery` is dark-by-default and tenant-ramped
 * (`OWNER_CAPABILITIES`, routes/settings.ts) — tenant A and tenant C flip
 * it ON through the real owner route; tenant B (T3's differently
 * configured tenant) leaves it OFF and its own dropped call's row stays
 * scheduled-but-never-sent for the life of the test.
 * T4: tenant A's and tenant C's rows are due in the SAME 30s sweep tick —
 * one cross-tenant pass reaches both, each stamped under its own
 * tenant_id, tenant B's untouched.
 */
import { test, expect } from '@playwright/test';
import { Pool } from 'pg';
import crypto from 'node:crypto';
import {
  provisionTenant,
  signedPost,
  sessionIdFromTwiml,
  devAuthBearerToken,
  API_URL,
  auditRows,
  pollFor,
  type ProvisionedTenant,
} from './fixtures/capture-8-2-lane';

const RUN = crypto.randomInt(1000, 9999);
const A_DID = `+1512${RUN}801`;
const B_DID = `+1512${RUN}802`;
const C_DID = `+1512${RUN}803`;
const A_SUBACCOUNT = 'AC1014c7aaaaaaaaaaaaaaaaaaaaaaaaaa';
const B_SUBACCOUNT = 'AC1014c7bbbbbbbbbbbbbbbbbbbbbbbbbb';
const C_SUBACCOUNT = 'AC1014c7ccccccccccccccccccccccccc';
const A_TOKEN = 'tenant-a-twilio-auth-token-1014c7-81';
const B_TOKEN = 'tenant-b-twilio-auth-token-1014c7-81';
const C_TOKEN = 'tenant-c-twilio-auth-token-1014c7-81';

const enc = process.env.TENANT_ENCRYPTION_KEY;
const dbReady = !!process.env.DATABASE_URL;

let pool: Pool;
let tenantA: ProvisionedTenant;
let tenantB: ProvisionedTenant;
let tenantC: ProvisionedTenant;

test.describe.configure({ mode: 'serial' });

test.describe('#1014 row 2.7 — a dropped call gets exactly one recovery SMS, stamped and audited (phone surface, T3·T4)', () => {
  test.skip(
    !dbReady || !enc,
    'Needs a real Postgres (DATABASE_URL, migrated) and TENANT_ENCRYPTION_KEY.',
  );

  test.beforeAll(async () => {
    if (!dbReady || !enc) return;
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    await pool.query(
      `DELETE FROM tenant_integrations WHERE provider = 'twilio' AND provider_data->>'phoneE164' = ANY($1)`,
      [[A_DID, B_DID, C_DID]],
    );
    tenantA = await provisionTenant(pool, enc, { did: A_DID, subaccountSid: A_SUBACCOUNT, authToken: A_TOKEN });
    tenantB = await provisionTenant(pool, enc, { did: B_DID, subaccountSid: B_SUBACCOUNT, authToken: B_TOKEN });
    tenantC = await provisionTenant(pool, enc, { did: C_DID, subaccountSid: C_SUBACCOUNT, authToken: C_TOKEN });

    // Flip the real owner control ON for A and C only (T3: B stays OFF).
    for (const t of [tenantA, tenantC]) {
      const owner = devAuthBearerToken(t.userId);
      const res = await fetch(`${API_URL}/api/settings/capabilities/dropped_call_recovery`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${owner}`, 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: true }),
      });
      expect(res.status, await res.text()).toBe(200);
    }
  });

  test.afterAll(async () => {
    await pool?.end();
  });

  /** Drive a call to a silence-induced 'failed' terminus via two empty-
   *  SpeechResult /gather turns (see file header for why this — not a
   *  Twilio status callback — is the real dropped-call trigger here). */
  async function driveDroppedCall(
    request: import('@playwright/test').APIRequestContext,
    caller: string,
    did: string,
    subaccountSid: string,
    authToken: string,
  ): Promise<string> {
    const callSid = `CA-2-7-${did.slice(-4)}-${crypto.randomUUID().slice(0, 8)}`;
    const voice = await signedPost(
      request,
      '/api/telephony/voice',
      { CallSid: callSid, AccountSid: subaccountSid, From: caller, To: did },
      authToken,
    );
    expect(voice.status()).toBe(200);
    const sid = sessionIdFromTwiml(await voice.text());

    for (let turn = 0; turn < 2; turn += 1) {
      const gather = await signedPost(
        request,
        `/api/telephony/gather?sid=${sid}`,
        { CallSid: callSid, AccountSid: subaccountSid, From: caller, To: did, SpeechResult: '' },
        authToken,
      );
      expect(gather.status()).toBe(200);
    }
    return callSid;
  }

  test('two silent gather turns end the call `failed`, arming a durable recovery row for the caller', async ({
    request,
  }) => {
    const callerA = '+15125557811';
    const callSidA = await driveDroppedCall(request, callerA, A_DID, A_SUBACCOUNT, A_TOKEN);

    // `scheduleDurableRecoveryContext` fires fire-and-forget (not awaited by
    // the /gather response), so the INSERT can genuinely land a beat after
    // the HTTP response returns — poll rather than a single immediate read.
    const rows = await pollFor<{ id: string; caller_e164: string; sent_at: string | null }>(
      pool,
      `SELECT dcr.id, dcr.caller_e164, dcr.sent_at
         FROM dropped_call_recoveries dcr
         JOIN voice_sessions vs ON vs.id = dcr.voice_session_id
        WHERE dcr.tenant_id = $1 AND vs.call_sid = $2`,
      [tenantA.tenantId, callSidA],
      { timeoutMs: 10_000 },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.caller_e164).toBe(callerA);
    expect(rows[0]!.sent_at).toBeNull();
  });

  test('T3·T4: within one real sweep window, tenant A AND tenant C (flag ON) each get exactly one sent, audited recovery SMS; tenant B (flag OFF) never sends', async ({
    request,
  }) => {
    // 60s schedule + up to 90s worst-case sweep latency + margin — well
    // past Playwright's 30s default. Must be called from WITHIN the test
    // body (module-scope test.setTimeout has no effect on a per-test
    // timeout — Playwright only honors it inside a test/beforeEach/
    // afterEach callback or via test.describe.configure({ timeout })).
    test.setTimeout(180_000);
    const callerB = '+15125557812';
    const callerC = '+15125557813';
    const callSidB = await driveDroppedCall(request, callerB, B_DID, B_SUBACCOUNT, B_TOKEN);
    const callSidC = await driveDroppedCall(request, callerC, C_DID, C_SUBACCOUNT, C_TOKEN);

    // Poll up to ~150s (60s schedule + up to 90s worst-case sweep latency +
    // margin) for BOTH enabled tenants' rows to be marked sent.
    const deadline = Date.now() + 150_000;
    let sentA: { sent_at: string | null; sms_message_sid: string | null } | undefined;
    let sentC: { sent_at: string | null; sms_message_sid: string | null } | undefined;
    while (Date.now() < deadline) {
      const a = await pool.query<{ sent_at: string | null; sms_message_sid: string | null }>(
        `SELECT dcr.sent_at, dcr.sms_message_sid
           FROM dropped_call_recoveries dcr
           JOIN voice_sessions vs ON vs.id = dcr.voice_session_id
          WHERE dcr.tenant_id = $1 AND dcr.sent_at IS NOT NULL
          ORDER BY dcr.created_at DESC LIMIT 1`,
        [tenantA.tenantId],
      );
      const c = await pool.query<{ sent_at: string | null; sms_message_sid: string | null }>(
        `SELECT dcr.sent_at, dcr.sms_message_sid
           FROM dropped_call_recoveries dcr
           JOIN voice_sessions vs ON vs.id = dcr.voice_session_id
          WHERE dcr.tenant_id = $1 AND dcr.sent_at IS NOT NULL
          ORDER BY dcr.created_at DESC LIMIT 1`,
        [tenantC.tenantId],
      );
      if (a.rows.length > 0) sentA = a.rows[0];
      if (c.rows.length > 0) sentC = c.rows[0];
      if (sentA && sentC) break;
      await new Promise((r) => setTimeout(r, 3000));
    }

    expect(sentA, 'tenant A (flag ON) should have a sent recovery row within the sweep window').toBeDefined();
    expect(sentA!.sms_message_sid).toBeTruthy();
    expect(sentC, 'tenant C (flag ON) should ALSO have a sent recovery row in the same run — T4').toBeDefined();
    expect(sentC!.sms_message_sid).toBeTruthy();

    const auditA = await auditRows(pool, tenantA.tenantId, 'dropped_call_recovery.sent');
    expect(auditA.length).toBeGreaterThanOrEqual(1);
    const auditC = await auditRows(pool, tenantC.tenantId, 'dropped_call_recovery.sent');
    expect(auditC.length).toBeGreaterThanOrEqual(1);

    // Exactly ONE recovery row per tenant for this run (idempotent — no
    // duplicate send even though the sweep ticks every 30s).
    const allA = await pool.query(`SELECT id FROM dropped_call_recoveries WHERE tenant_id = $1`, [tenantA.tenantId]);
    expect(allA.rows).toHaveLength(1);

    // Tenant B (flag OFF): the row exists (scheduling is unconditional) but
    // stays un-sent — never actioned by the sweep, no audit row.
    const bRow = await pool.query<{ sent_at: string | null }>(
      `SELECT dcr.sent_at FROM dropped_call_recoveries dcr
         JOIN voice_sessions vs ON vs.id = dcr.voice_session_id
        WHERE dcr.tenant_id = $1 AND vs.call_sid = $2`,
      [tenantB.tenantId, callSidB],
    );
    expect(bRow.rows).toHaveLength(1);
    expect(bRow.rows[0]!.sent_at).toBeNull();
    const auditB = await auditRows(pool, tenantB.tenantId, 'dropped_call_recovery.sent');
    expect(auditB).toHaveLength(0);
  });
});

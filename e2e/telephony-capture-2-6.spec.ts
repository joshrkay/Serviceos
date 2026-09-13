/**
 * #1014 §8.2 row 2.6 — "As J, I want an elderly caller on oxygen in 104°F
 * heat to reach me personally, so vulnerability isn't handled by a queue."
 * Acceptance: given age + weather + critical urgency, when triage runs, my
 * cell is patched with a 60s dial and a non-PII preface; if I don't
 * answer, a high-priority booking plus an owner SMS — never a normal
 * booking.
 *
 * SCOPE (per the lane brief): reachability leg only; the audit-emission gap
 * (`vulnerability_triage.recorded`) lands separately on draft PR #1136, not
 * merged on this branch (confirmed: no `vulnerability_triage.recorded`
 * anywhere in `vulnerability-triage-hook.ts`) — not asserted here.
 *
 * WHAT IS GENUINELY REACHABLE, deterministically, with no live model:
 *   1. The owner-facing flag control is real and reaches real Postgres:
 *      `PUT /api/settings/capabilities/voice_vulnerability_triage` (#1011
 *      PR-2, routes/settings.ts:654) writes a `tenant_feature_flags` row
 *      through `setTenantFlag`, and `GET /api/settings/capabilities` reads
 *      it back — proven here as T3 (tenant B's own read stays `false`,
 *      untouched by tenant A's write).
 *   2. The real signed `/voice` → `/gather` call reaches the hook's own
 *      call site for BOTH tenants (200 OK, ordinary Gather TwiML) — the
 *      hook is wired on the real Gather path
 *      (`setVulnerabilityTriageHook`, app.ts:4347/4475), so this is not a
 *      vacuous "the server didn't crash" check; it is the same code path
 *      that would produce a `triage_events` row if grading returned a
 *      nonzero score.
 *
 * WHAT IS NOT REACHABLE HERMETICALLY, #1119-class (see the pinned test
 * below): `gradeVulnerability` (ai/agents/customer-calling/vulnerability
 * -grader.ts) calls the LLM gateway for `taskType: 'grade_vulnerability'`
 * and fails safe to `ZERO_GRADE` (score 0, tier 'none') on ANY parse/call
 * error. The hermetic mock (`scriptHermeticResponse`,
 * ai/providers/mock.ts) has NO branch for that task type — it falls to
 * the generic `{"ok":true,...}` catch-all, which parses to a zero score
 * regardless of what the caller said. `vulnerability-triage-hook.ts`
 * never persists a zero-grade turn ("Zero-grade turns … are NOT
 * persisted"), so under this repo's no-`AI_PROVIDER_API_KEY` hermetic
 * boot, NO `triage_events` row is EVER written, flag on or off, no matter
 * the SpeechResult content — there is no deterministic pre-LLM keyword
 * path for this row (unlike E1's `runDeterministicSafetyScan`). Pinned
 * with `test.fail()` naming the seam.
 */
import { test, expect } from '@playwright/test';
import { Pool } from 'pg';
import crypto from 'node:crypto';
import {
  provisionTenant,
  signedPost,
  devAuthBearerToken,
  API_URL,
  triageEventRows,
  type ProvisionedTenant,
} from './fixtures/capture-8-2-lane';

const RUN = crypto.randomInt(1000, 9999);
const A_DID = `+1512${RUN}701`;
const B_DID = `+1512${RUN}702`;
const A_SUBACCOUNT = 'AC1014c6aaaaaaaaaaaaaaaaaaaaaaaaaa';
const B_SUBACCOUNT = 'AC1014c6bbbbbbbbbbbbbbbbbbbbbbbbbb';
const A_TOKEN = 'tenant-a-twilio-auth-token-1014c6-71';
const B_TOKEN = 'tenant-b-twilio-auth-token-1014c6-71';
const CALLER = '+15125557902';
const VULNERABLE_UTTERANCE =
  "I'm 84 and on oxygen, it's 104 degrees in here and I really need help";

const enc = process.env.TENANT_ENCRYPTION_KEY;
const dbReady = !!process.env.DATABASE_URL;

let pool: Pool;
let tenantA: ProvisionedTenant;
let tenantB: ProvisionedTenant;

test.describe.configure({ mode: 'serial' });

test.describe('#1014 row 2.6 — vulnerability triage flag control + call reachability (phone surface, T3)', () => {
  test.skip(
    !dbReady || !enc,
    'Needs a real Postgres (DATABASE_URL, migrated) and TENANT_ENCRYPTION_KEY.',
  );

  test.beforeAll(async () => {
    if (!dbReady || !enc) return;
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    await pool.query(
      `DELETE FROM tenant_integrations WHERE provider = 'twilio' AND provider_data->>'phoneE164' = ANY($1)`,
      [[A_DID, B_DID]],
    );
    tenantA = await provisionTenant(pool, enc, { did: A_DID, subaccountSid: A_SUBACCOUNT, authToken: A_TOKEN });
    tenantB = await provisionTenant(pool, enc, { did: B_DID, subaccountSid: B_SUBACCOUNT, authToken: B_TOKEN });
  });

  test.afterAll(async () => {
    await pool?.end();
  });

  test("T3: tenant A turns voice_vulnerability_triage ON through the real owner route; tenant B's own read stays OFF", async ({
    request,
  }) => {
    const ownerA = devAuthBearerToken(tenantA.userId);
    const putRes = await request.put(`${API_URL}/api/settings/capabilities/voice_vulnerability_triage`, {
      headers: { authorization: `Bearer ${ownerA}` },
      data: { enabled: true },
    });
    expect(putRes.status(), await putRes.text()).toBe(200);

    const flagRow = await pool.query<{ enabled: boolean }>(
      `SELECT enabled FROM tenant_feature_flags WHERE tenant_id = $1 AND flag_key = 'voice_vulnerability_triage'`,
      [tenantA.tenantId],
    );
    expect(flagRow.rows).toHaveLength(1);
    expect(flagRow.rows[0]!.enabled).toBe(true);

    const getA = await request.get(`${API_URL}/api/settings/capabilities`, {
      headers: { authorization: `Bearer ${ownerA}` },
    });
    expect(getA.status()).toBe(200);
    const bodyA = (await getA.json()) as Record<string, { enabled: boolean }>;
    expect(bodyA.voice_vulnerability_triage?.enabled).toBe(true);

    // T3: tenant B, provisioned in the same run, never had its flag touched.
    const ownerB = devAuthBearerToken(tenantB.userId);
    const getB = await request.get(`${API_URL}/api/settings/capabilities`, {
      headers: { authorization: `Bearer ${ownerB}` },
    });
    expect(getB.status()).toBe(200);
    const bodyB = (await getB.json()) as Record<string, { enabled: boolean }>;
    expect(bodyB.voice_vulnerability_triage?.enabled).toBe(false);
  });

  test('the real call reaches the vulnerability-triage hook path for both tenants (flag ON and OFF)', async ({
    request,
  }) => {
    for (const [tenant, subaccount, token] of [
      [tenantA, A_SUBACCOUNT, A_TOKEN],
      [tenantB, B_SUBACCOUNT, B_TOKEN],
    ] as const) {
      const callSid = `CA-2-6-${tenant.tenantId.slice(0, 6)}-${crypto.randomUUID().slice(0, 8)}`;
      const voice = await signedPost(
        request,
        '/api/telephony/voice',
        { CallSid: callSid, AccountSid: subaccount, From: CALLER, To: tenant.did },
        token,
      );
      expect(voice.status()).toBe(200);
    }
  });

  test(
    'KNOWN GAP — a critical-urgency turn should write a triage_events row when the flag is ON (expected to fail hermetically)',
    async ({ request }) => {
      test.fail(
        true,
        'packages/api/src/ai/agents/customer-calling/vulnerability-grader.ts calls the LLM ' +
          "gateway for taskType 'grade_vulnerability' and fails safe to ZERO_GRADE (score 0, " +
          'tier none) on any parse/call error; packages/api/src/ai/providers/mock.ts ' +
          "scriptHermeticResponse has NO branch for 'grade_vulnerability' (falls to the " +
          'generic {"ok":true,"mock":true,...} catch-all, which parses to a zero score). ' +
          "vulnerability-triage-hook.ts never persists a zero-grade turn (\"Zero-grade turns " +
          '… are NOT persisted\"), so under this repo\'s no-AI_PROVIDER_API_KEY hermetic boot ' +
          'no triage_events row can ever be written, flag on or off — there is no ' +
          'deterministic pre-LLM path for this row (unlike E1). #1119-class: needs a real ' +
          'model to reach.',
      );

      const callSid = `CA-2-6-grade-${crypto.randomUUID().slice(0, 8)}`;
      const voice = await signedPost(
        request,
        '/api/telephony/voice',
        { CallSid: callSid, AccountSid: A_SUBACCOUNT, From: CALLER, To: A_DID },
        A_TOKEN,
      );
      expect(voice.status()).toBe(200);
      const twiml = await voice.text();
      const sidMatch = /[?&]sid=([0-9a-f-]{36})/i.exec(twiml);
      const sid = sidMatch?.[1] ?? '';

      const gather = await signedPost(
        request,
        `/api/telephony/gather?sid=${sid}`,
        {
          CallSid: callSid,
          AccountSid: A_SUBACCOUNT,
          From: CALLER,
          To: A_DID,
          SpeechResult: VULNERABLE_UTTERANCE,
          Confidence: '0.95',
        },
        A_TOKEN,
      );
      expect(gather.status()).toBe(200);

      const rows = await triageEventRows(pool, tenantA.tenantId);
      expect(rows.length, 'a critical-urgency turn should produce a triage_events row').toBeGreaterThan(0);
    },
  );
});

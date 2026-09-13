/**
 * #1014 §8.2 row 2.2 — "As M, I want callers told they're being recorded
 * BEFORE anything is captured, so I'm not exposed in a two-party-consent
 * state." Acceptance: given an inbound call, when the greeting plays, then
 * the disclosure precedes `<Start><Record>`, Media Streams consumes no
 * audio until it has played, and the implicit-consent ledger row is
 * written.
 *
 * SCOPE (per the lane brief): reachability leg ONLY. The audit-emission gap
 * this row's ledger write left open (`commitRecordingConsent` wrote
 * `consent_events` but audited nothing) is closed on draft PR #1136
 * (`fix/audit-legs-2-2-2-6-9-4-9-6-9-12`), NOT merged as of this branch
 * (confirmed: `recording_consent.granted` does not exist anywhere in
 * `twilio-adapter.ts` on this branch — only the pre-existing
 * `recording_consent.revoked` for the caller-initiated revocation path).
 * This spec is test-only and does not touch product code, so it asserts
 * the `consent_events` ledger row (the write that already exists) and
 * deliberately does NOT assert an `audit_events` row for the grant — that
 * lands separately when #1136 merges.
 *
 * Media Streams is off by default for this deployment (Gather path only,
 * per the lane brief) — `<Start><Record>` is armed unconditionally on the
 * plain Gather `/voice` response (`buildTwiML`, twilio-adapter.ts:696-713;
 * wired at app.ts:3617/3697, no tenant flag gates it), so a single signed
 * `/voice` POST is enough to reach both the ordering guarantee (structural:
 * `<Say>` before `<Start><Record>` in the same TwiML document) and the
 * ledger commit (`commitRecordingConsent`, fired right after that TwiML is
 * built). The Media-Streams-specific fail-closed-disclosure leg is a
 * separate transport already proven at real Postgres by the vitest
 * integration suite (`conversation-consent-ordering.test.ts`) — not
 * reachable via the Gather-only webhook surface this lane drives.
 *
 * T1: a second tenant's call writes its own `consent_events` row; the
 * shared caller's consent state at tenant A never satisfies tenant B's gate
 * for the SAME phone number, and vice versa.
 */
import { test, expect } from '@playwright/test';
import { Pool } from 'pg';
import crypto from 'node:crypto';
import {
  provisionTenant,
  signedPost,
  consentEventRows,
  stripNonDigits,
  pollFor,
  type ProvisionedTenant,
} from './fixtures/capture-8-2-lane';

const RUN = crypto.randomInt(1000, 9999);
const A_DID = `+1512${RUN}501`;
const B_DID = `+1512${RUN}502`;
const A_SUBACCOUNT = 'AC1014c2aaaaaaaaaaaaaaaaaaaaaaaaaa';
const B_SUBACCOUNT = 'AC1014c2bbbbbbbbbbbbbbbbbbbbbbbbbb';
const A_TOKEN = 'tenant-a-twilio-auth-token-1014c2-51';
const B_TOKEN = 'tenant-b-twilio-auth-token-1014c2-51';
const SHARED_CALLER = '+15125557788';

const enc = process.env.TENANT_ENCRYPTION_KEY;
const dbReady = !!process.env.DATABASE_URL;

let pool: Pool;
let tenantA: ProvisionedTenant;
let tenantB: ProvisionedTenant;

test.describe.configure({ mode: 'serial' });

test.describe('#1014 row 2.2 — recording disclosure precedes capture, and the consent ledger writes (phone surface, T1)', () => {
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

  test("the disclosure precedes <Start><Record> in the same TwiML, and the implicit-consent ledger row is written", async ({
    request,
  }) => {
    const callSid = `CA-2-2-a-${crypto.randomUUID().slice(0, 8)}`;
    const res = await signedPost(
      request,
      '/api/telephony/voice',
      { CallSid: callSid, AccountSid: A_SUBACCOUNT, From: SHARED_CALLER, To: A_DID },
      A_TOKEN,
    );
    expect(res.status()).toBe(200);
    const twiml = await res.text();

    // Structural ordering proof: the <Say> disclosure/greeting element
    // appears before the <Start><Record> element in the same document.
    const sayIdx = twiml.indexOf('<Say');
    const startRecordIdx = twiml.indexOf('<Start><Record');
    expect(sayIdx, `expected a <Say> element: ${twiml}`).toBeGreaterThanOrEqual(0);
    expect(startRecordIdx, `expected <Start><Record> to be armed: ${twiml}`).toBeGreaterThanOrEqual(0);
    expect(sayIdx).toBeLessThan(startRecordIdx);

    const rows = await pollFor(
      pool,
      `SELECT kind, state, source FROM consent_events WHERE tenant_id = $1 AND phone_normalized = $2`,
      [tenantA.tenantId, stripNonDigits(SHARED_CALLER)],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'recording', state: 'implicit', source: 'voice' });
  });

  test("T1: tenant B's call from the SAME caller number writes tenant B's own consent row, never tenant A's", async ({
    request,
  }) => {
    const callSid = `CA-2-2-b-${crypto.randomUUID().slice(0, 8)}`;
    const res = await signedPost(
      request,
      '/api/telephony/voice',
      { CallSid: callSid, AccountSid: B_SUBACCOUNT, From: SHARED_CALLER, To: B_DID },
      B_TOKEN,
    );
    expect(res.status()).toBe(200);

    const rowsB = await pollFor(
      pool,
      `SELECT kind, state, source FROM consent_events WHERE tenant_id = $1 AND phone_normalized = $2`,
      [tenantB.tenantId, stripNonDigits(SHARED_CALLER)],
    );
    expect(rowsB).toHaveLength(1);
    expect(rowsB[0]).toMatchObject({ kind: 'recording', state: 'implicit', source: 'voice' });

    // Tenant A's own consent row (from the previous test) is untouched — still
    // exactly one row, not two, and it is not tenant B's.
    const rowsA = await consentEventRows(pool, tenantA.tenantId, stripNonDigits(SHARED_CALLER));
    expect(rowsA).toHaveLength(1);
  });
});

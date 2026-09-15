/**
 * #1014 §8.2 row 2.3 — "As M, I want a known customer recognised by their
 * number and a stranger turned into a lead, so nothing falls on the
 * floor." Acceptance: given an inbound number, when it matches a stored
 * customer in E.164, then they are identified — and a non-NANP caller
 * sharing the last 10 digits is NOT matched.
 *
 * Phone-surface reachability leg (lane C, test/8-2-capture-r5). The vitest
 * integration proof (`identify-caller.test.ts`, #1014-A) already covers all
 * three legs (known/non-NANP/stranger) at the handler level with T1 — this
 * spec drives the SAME three legs through the real `/api/telephony/voice`
 * webhook instead, at real Postgres.
 *
 * Read-back proof, three legs:
 *
 * 1. KNOWN customer (`identifyCaller`, ai/skills/identify-caller.ts): no
 *    dedicated "identified" audit event exists on this path (confirmed:
 *    `identify.greet_known`/`identify.greet_unknown` in ai/i18n/en.ts are
 *    UNREFERENCED dead strings — grepped, zero call sites). The one
 *    positive, in-request signal is `logInboundCallOnCustomerTimeline`
 *    (telephony/inbound-call-log.ts), AWAITED inside `handleInbound` before
 *    the `/voice` response is built: it appends a `system_event` message
 *    tagged `metadata.callSid` on the customer's own conversation thread.
 *    (`voice_sessions.customer_id` is NOT usable for this: it is written
 *    only by `persistSessionEnded`/`markEnded` at call TERMINATION, which
 *    plain Gather-loop /voice+/gather turns do not reach without a live
 *    model to complete the FSM — see telephony-book-3-1-proposed-booking
 *    .spec.ts's own reachability finding for the same frontier.)
 * 2. NON-NANP collision (`isNanpKey`, shared/phone.ts): a caller sharing a
 *    US customer's trailing 10 digits but dialling with a foreign country
 *    code (`+44` + the same 10 digits) normalizes to 12 digits, fails
 *    `isNanpKey`, and is refused a match WITHOUT the tail-probe SELECT ever
 *    running — proven by the same caller instead becoming a lead (no
 *    customer match), never contaminating the real customer's record.
 * 3. STRANGER (`findOrCreateLeadByPhone`, ai/skills/find-or-create-lead.ts):
 *    a `leads` row (`source='phone_call'`) plus a `lead.created` audit
 *    event (`entityType:'lead'`); a second call from the SAME stranger
 *    number is idempotent (still exactly one lead row, one audit event).
 *
 * T1: the SAME phone number is a known customer of tenant B and a stranger
 * to tenant A in the same run — tenant A's lead is never satisfied by
 * tenant B's customer record, and vice versa.
 */
import { test, expect } from '@playwright/test';
import { Pool } from 'pg';
import crypto from 'node:crypto';
import {
  provisionTenant,
  signedPost,
  devAuthBearerToken,
  createCustomerViaApi,
  leadRows,
  auditRows,
  inboundCallTimelineMessages,
  normalizePhone,
  stripNonDigits,
  pollFor,
  type ProvisionedTenant,
} from './fixtures/capture-8-2-lane';

const RUN = crypto.randomInt(1000, 9999);
const A_DID = `+1512${RUN}401`;
const B_DID = `+1512${RUN}402`;
const A_SUBACCOUNT = 'AC1014c3aaaaaaaaaaaaaaaaaaaaaaaaaa';
const B_SUBACCOUNT = 'AC1014c3bbbbbbbbbbbbbbbbbbbbbbbbbb';
const A_TOKEN = 'tenant-a-twilio-auth-token-1014c3-41';
const B_TOKEN = 'tenant-b-twilio-auth-token-1014c3-41';

// A_KNOWN is a genuine US NANP number: tenant A's known customer, and the
// number a NON-NANP caller (below) shares only the trailing 10 digits with.
const A_KNOWN_DIGITS = '5125550777';
const A_KNOWN_E164 = `+1${A_KNOWN_DIGITS}`;
const NON_NANP_CALLER = `+44${A_KNOWN_DIGITS}`; // same 10 digits, UK country code
const STRANGER = '+15125559911'; // matches no customer anywhere
const enc = process.env.TENANT_ENCRYPTION_KEY;
const dbReady = !!process.env.DATABASE_URL;

let pool: Pool;
let tenantA: ProvisionedTenant;
let tenantB: ProvisionedTenant;

test.describe.configure({ mode: 'serial' });

test.describe('#1014 row 2.3 — known customer identified, non-NANP collision refused, stranger becomes a lead (phone surface, T1)', () => {
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

  test('a known customer calling tenant A is identified — logged on their own timeline, no lead created', async ({
    request,
  }) => {
    const ownerToken = devAuthBearerToken(tenantA.userId);
    const customer = await createCustomerViaApi(request, ownerToken, {
      firstName: 'Known',
      lastName: 'Customer',
      primaryPhone: A_KNOWN_E164,
    });

    const callSid = `CA-2-3-known-${crypto.randomUUID().slice(0, 8)}`;
    const res = await signedPost(
      request,
      '/api/telephony/voice',
      { CallSid: callSid, AccountSid: A_SUBACCOUNT, From: A_KNOWN_E164, To: A_DID },
      A_TOKEN,
    );
    expect(res.status()).toBe(200);

    const messages = await pollFor(
      pool,
      `SELECT m.content, m.metadata FROM messages m
         JOIN conversations c ON c.id = m.conversation_id
        WHERE c.tenant_id = $1 AND c.entity_type = 'customer' AND c.entity_id = $2
          AND m.metadata->>'callSid' = $3`,
      [tenantA.tenantId, customer.id, callSid],
    );
    expect(messages).toHaveLength(1);
    expect((messages[0] as { metadata: Record<string, unknown> }).metadata).toMatchObject({
      direction: 'inbound',
      channel: 'call',
    });

    // No lead was created for the known customer's number.
    const leads = await leadRows(pool, tenantA.tenantId, normalizePhone(A_KNOWN_E164));
    expect(leads).toHaveLength(0);
  });

  test('a non-NANP caller sharing the last 10 digits is NOT matched to the US customer — becomes its own lead instead', async ({
    request,
  }) => {
    const callSid = `CA-2-3-nonnanp-${crypto.randomUUID().slice(0, 8)}`;
    const res = await signedPost(
      request,
      '/api/telephony/voice',
      { CallSid: callSid, AccountSid: A_SUBACCOUNT, From: NON_NANP_CALLER, To: A_DID },
      A_TOKEN,
    );
    expect(res.status()).toBe(200);

    const normalized = normalizePhone(NON_NANP_CALLER);
    expect(normalized).toBe(`44${A_KNOWN_DIGITS}`); // 12 digits — NOT a NANP key

    const leads = await pollFor(
      pool,
      `SELECT id, source FROM leads WHERE tenant_id = $1 AND phone_normalized = $2`,
      [tenantA.tenantId, normalized],
    );
    expect(leads).toHaveLength(1);
    expect((leads[0] as { source: string }).source).toBe('phone_call');

    // The known US customer's own record gained no timeline entry for this call.
    // `customers.phone_normalized` is a GENERATED COLUMN
    // (regexp_replace(primary_phone, '[^0-9]', '', 'g')) that keeps the
    // leading country-code '1' — a DIFFERENT convention from
    // `leads.phone_normalized` (normalizePhone, used just above), so this
    // lookup needs `stripNonDigits`, not `normalized`/`A_KNOWN_DIGITS`.
    const customerRows = await pool.query<{ id: string }>(
      `SELECT id FROM customers WHERE tenant_id = $1 AND phone_normalized = $2`,
      [tenantA.tenantId, stripNonDigits(A_KNOWN_E164)],
    );
    const knownMessages = await inboundCallTimelineMessages(
      pool,
      tenantA.tenantId,
      customerRows.rows[0]!.id,
      callSid,
    );
    expect(knownMessages).toHaveLength(0);
  });

  test('a stranger becomes exactly one lead with lead.created audited, idempotent on a repeat call', async ({
    request,
  }) => {
    const normalized = normalizePhone(STRANGER);

    for (const suffix of ['first', 'second']) {
      const callSid = `CA-2-3-stranger-${suffix}-${crypto.randomUUID().slice(0, 8)}`;
      const res = await signedPost(
        request,
        '/api/telephony/voice',
        { CallSid: callSid, AccountSid: A_SUBACCOUNT, From: STRANGER, To: A_DID },
        A_TOKEN,
      );
      expect(res.status()).toBe(200);
    }

    const leads = await pollFor(pool, `SELECT id, source FROM leads WHERE tenant_id = $1 AND phone_normalized = $2`, [
      tenantA.tenantId,
      normalized,
    ]);
    expect(leads).toHaveLength(1);
    expect((leads[0] as { source: string }).source).toBe('phone_call');

    const events = await auditRows(pool, tenantA.tenantId, 'lead.created');
    const forThisLead = events.filter((e) => e.entity_id === (leads[0] as { id: string }).id);
    expect(forThisLead).toHaveLength(1);
  });

  test("T1: the SAME phone number is a KNOWN customer of tenant B and a STRANGER to tenant A", async ({
    request,
  }) => {
    const shared = '+15125558822';
    const ownerTokenB = devAuthBearerToken(tenantB.userId);
    const customerB = await createCustomerViaApi(request, ownerTokenB, {
      firstName: 'Shared',
      lastName: 'Number',
      primaryPhone: shared,
    });

    // Call tenant A first — a stranger there.
    const callSidA = `CA-2-3-t1-a-${crypto.randomUUID().slice(0, 8)}`;
    const resA = await signedPost(
      request,
      '/api/telephony/voice',
      { CallSid: callSidA, AccountSid: A_SUBACCOUNT, From: shared, To: A_DID },
      A_TOKEN,
    );
    expect(resA.status()).toBe(200);

    const leadsA = await pollFor(pool, `SELECT id FROM leads WHERE tenant_id = $1 AND phone_normalized = $2`, [
      tenantA.tenantId,
      normalizePhone(shared),
    ]);
    expect(leadsA).toHaveLength(1);

    // Same number calls tenant B — identified as B's own customer, not a lead.
    const callSidB = `CA-2-3-t1-b-${crypto.randomUUID().slice(0, 8)}`;
    const resB = await signedPost(
      request,
      '/api/telephony/voice',
      { CallSid: callSidB, AccountSid: B_SUBACCOUNT, From: shared, To: B_DID },
      B_TOKEN,
    );
    expect(resB.status()).toBe(200);

    const messagesB = await pollFor(
      pool,
      `SELECT m.content FROM messages m
         JOIN conversations c ON c.id = m.conversation_id
        WHERE c.tenant_id = $1 AND c.entity_type = 'customer' AND c.entity_id = $2
          AND m.metadata->>'callSid' = $3`,
      [tenantB.tenantId, customerB.id, callSidB],
    );
    expect(messagesB).toHaveLength(1);

    const leadsB = await leadRows(pool, tenantB.tenantId, normalizePhone(shared));
    expect(leadsB).toHaveLength(0);

    // Tenant A's lead is untouched by tenant B's identification.
    const leadsAAfter = await leadRows(pool, tenantA.tenantId, normalizePhone(shared));
    expect(leadsAAfter).toHaveLength(1);
    expect(leadsAAfter[0]!.id).toBe(leadsA[0]!.id);
  });
});

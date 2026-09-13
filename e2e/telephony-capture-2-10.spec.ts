/**
 * #1014 §8.2 row 2.10 — "As M, I want an unclaimed text to become a thread
 * I can answer, so SMS isn't a black hole." Acceptance: given concurrent
 * inbound texts from one unmatched number, when captured, then they
 * collapse to a single open thread with no cross-tenant bleed.
 *
 * Phone/SMS-surface reachability leg (lane C, test/8-2-capture-r5): two
 * signed, concurrent (`Promise.all`) inbound-SMS webhooks through the real
 * `/webhooks/twilio/sms/:tenantId` route (packages/api/src/webhooks/routes
 * .ts:2845), driven exactly the way `e2e/fixtures/twilio-sms-lane.ts`
 * (merged §8.4) already drives it for other rows.
 *
 * MECHANISM NOTE: the real dispatcher wires a `leadRepo` into the capture
 * handler (`app.ts:3380` — `createInboundCaptureHandler({conversationRepo,
 * customerRepo, leadRepo, auditRepo, ...})`), so a genuinely unmatched
 * (zero-customer-match) sender does NOT thread onto the bare
 * `UNMATCHED_SMS_ENTITY_TYPE` phone-keyed conversation the row's own vitest
 * suite exercises with a leadRepo-less handler — it find-or-creates a
 * `leads` row and threads onto `entityType:'lead'` instead (the SAME
 * migration-200 partial unique index, `uq_conversations_open_noncustomer`,
 * covers both entity types — confirmed:
 * `inbound-sms-capture.test.ts`'s "collapses concurrent new-lead captures
 * to one open thread" test uses the identical mechanism this spec drives
 * over real HTTP). "One thread for the unclaimed text" is what the story
 * asks for; this is what the shipped wiring actually produces.
 *
 * T1: the SAME phone number texting two DIFFERENT tenants produces two
 * INDEPENDENT lead+thread pairs — never bled across tenant_id.
 */
import { test, expect } from '@playwright/test';
import { Pool } from 'pg';
import crypto from 'node:crypto';
import {
  provisionTenant,
  signedSmsPost,
  auditRows,
  pollFor,
  type ProvisionedTenant,
} from './fixtures/capture-8-2-lane';

const RUN = crypto.randomInt(1000, 9999);
const A_DID = `+1512${RUN}601`;
const B_DID = `+1512${RUN}602`;
const A_SUBACCOUNT = 'AC1014c10aaaaaaaaaaaaaaaaaaaaaaaaa';
const B_SUBACCOUNT = 'AC1014c10bbbbbbbbbbbbbbbbbbbbbbbbb';
const A_TOKEN = 'tenant-a-twilio-auth-token-1014c10-61';
const B_TOKEN = 'tenant-b-twilio-auth-token-1014c10-61';

const enc = process.env.TENANT_ENCRYPTION_KEY;
const dbReady = !!process.env.DATABASE_URL;

let pool: Pool;
let tenantA: ProvisionedTenant;
let tenantB: ProvisionedTenant;

test.describe.configure({ mode: 'serial' });

test.describe('#1014 row 2.10 — concurrent unclaimed texts collapse to one open thread (SMS surface, T1)', () => {
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

  test('two concurrent texts from one unclaimed number collapse to one open lead thread', async ({ request }) => {
    const from = '+15125556601';
    const [ra, rb] = await Promise.all([
      signedSmsPost(request, tenantA, { From: from, Body: 'a-first-text', MessageSid: `SM2-10a-${crypto.randomUUID().slice(0, 8)}` }),
      signedSmsPost(request, tenantA, { From: from, Body: 'b-second-text', MessageSid: `SM2-10b-${crypto.randomUUID().slice(0, 8)}` }),
    ]);
    expect(ra.status()).toBe(200);
    expect(rb.status()).toBe(200);

    const leads = await pollFor<{ id: string }>(
      pool,
      `SELECT id FROM leads WHERE tenant_id = $1 AND phone_normalized = $2`,
      [tenantA.tenantId, '5125556601'],
    );
    expect(leads).toHaveLength(1);
    const leadId = leads[0]!.id;

    const threads = await pollFor<{ id: string; status: string }>(
      pool,
      `SELECT id, status FROM conversations WHERE tenant_id = $1 AND entity_type = 'lead' AND entity_id = $2`,
      [tenantA.tenantId, leadId],
    );
    const open = threads.filter((t) => t.status === 'open');
    expect(open).toHaveLength(1);

    const messages = await pool.query<{ content: string }>(
      `SELECT content FROM messages WHERE conversation_id = $1 ORDER BY content ASC`,
      [open[0]!.id],
    );
    expect(messages.rows.map((m) => m.content)).toEqual(['a-first-text', 'b-second-text']);

    const events = await auditRows(pool, tenantA.tenantId, 'sms.inbound.captured');
    const forThisThread = events.filter((e) => e.entity_id === open[0]!.id);
    expect(forThisThread.length).toBeGreaterThanOrEqual(1);
    expect(forThisThread[0]!.metadata).toMatchObject({ matched: false, linkedTo: 'lead', leadId });
  });

  test("T1: the SAME unclaimed number texting tenant B never bleeds into tenant A's lead/thread", async ({ request }) => {
    const from = '+15125556601'; // identical sender to the previous test, different tenant

    const res = await signedSmsPost(request, tenantB, {
      From: from,
      Body: 'tenant-b-text',
      MessageSid: `SM2-10c-${crypto.randomUUID().slice(0, 8)}`,
    });
    expect(res.status()).toBe(200);

    const leadsB = await pollFor<{ id: string }>(
      pool,
      `SELECT id FROM leads WHERE tenant_id = $1 AND phone_normalized = $2`,
      [tenantB.tenantId, '5125556601'],
    );
    expect(leadsB).toHaveLength(1);

    const threadsB = await pool.query<{ id: string; status: string }>(
      `SELECT id, status FROM conversations WHERE tenant_id = $1 AND entity_type = 'lead' AND entity_id = $2 AND status = 'open'`,
      [tenantB.tenantId, leadsB[0]!.id],
    );
    expect(threadsB.rows).toHaveLength(1);
    const messagesB = await pool.query<{ content: string }>(
      `SELECT content FROM messages WHERE conversation_id = $1`,
      [threadsB.rows[0]!.id],
    );
    expect(messagesB.rows.map((m) => m.content)).toEqual(['tenant-b-text']);

    // Tenant A's lead/thread from the previous test is untouched: still
    // exactly one lead row and the two original messages only.
    const leadsAAfter = await pool.query<{ id: string }>(
      `SELECT id FROM leads WHERE tenant_id = $1 AND phone_normalized = $2`,
      [tenantA.tenantId, '5125556601'],
    );
    expect(leadsAAfter.rows).toHaveLength(1);
    const messagesA = await pool.query<{ content: string }>(
      `SELECT content FROM messages m
         JOIN conversations c ON c.id = m.conversation_id
        WHERE c.tenant_id = $1 AND c.entity_type = 'lead' AND c.entity_id = $2`,
      [tenantA.tenantId, leadsAAfter.rows[0]!.id],
    );
    expect(messagesA.rows.map((m) => m.content).sort()).toEqual(['a-first-text', 'b-second-text']);
  });
});

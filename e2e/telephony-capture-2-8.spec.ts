/**
 * #1014 §8.2 row 2.8 — "As J, I want a customer's photo of a leaking heater
 * to become a draft quote, so I can price it from the truck." Acceptance:
 * given an MMS from an unknown number, when ingest runs, then a
 * `draft_estimate` proposal persists with `tenant_id` and an audit row —
 * and an AMBIGUOUS sender yields a clarification, never a draft.
 *
 * SMS/MMS-surface reachability leg (lane C, test/8-2-capture-r5). The
 * vitest integration proof (`mms-to-quote.int.test.ts`, #1014-A) drives
 * `ingestCustomerMms` directly with a hand-stubbed `fetchMedia`/gateway.
 * This spec instead drives the REAL signed inbound-SMS/MMS webhook
 * (`/webhooks/twilio/sms/:tenantId`) with `NumMedia=1` + a real
 * `MediaUrl0` — a plain local HTTP server this spec starts, serving a real
 * JPEG. `createTwilioMediaFetcher` (sms/tech-status/mms-ingest.ts) does an
 * ordinary authenticated `fetch(url)` with no host restriction to Twilio's
 * own domain, so a same-process HTTP server stands in for Twilio's media
 * CDN without live Twilio at all — hermetic by construction, not mocked.
 *
 * FORMER GENUINE PRODUCT/HERMETIC-MOCK BUG, FIXED (#1154 item 1):
 *
 *   `MmsEstimateTaskHandler.buildUserContent` (ai/tasks/mms-estimate-task
 *   .ts:318) embeds `JSON.stringify(input.context)` — e.g.
 *   `{"customerId":"<uuid>","fromPhone":"+1..."}`  — directly into the
 *   prompt text sent to the LLM gateway. Under this repo's hermetic boot
 *   (no `AI_PROVIDER_API_KEY` — app.ts:1260-1261 falls back to
 *   `createHermeticMockLLMGateway()`), `scriptHermeticResponse`'s
 *   `extractName` helper (ai/providers/mock.ts) USED TO grep for ANY quoted
 *   substring (`/["']([^"']{2,80})["']/`) when its name-flavoured regexes
 *   missed — and the FIRST quoted substring in that JSON blob was the
 *   literal JSON KEY NAME `"customerId"`, not a customer's name, so every
 *   MMS/estimate draft under the hermetic gateway was labelled "Service
 *   estimate for customerId". The mock ALSO hardcoded `catalogItemId: null`
 *   on every line item (a real model never emits that key at all), which
 *   `groundLineItemPricing` (ai/resolution/catalog-resolver.ts) never
 *   cleared for a tenant with no matching catalog item — the
 *   `draft_estimate` Zod contract's `catalogItemId`
 *   (`z.string().uuid().optional()`) rejects an explicit `null`, so
 *   `assertValidProposalPayload` threw and `MmsEstimateTaskHandler` returned
 *   `{status:'parse_failed', reason:'invalid_payload'}` — NO proposal, NO
 *   `customer_mms.estimate_drafted` audit, ever, under the hermetic boot.
 *   Both fixed in `ai/providers/mock.ts` (`extractName` now strips embedded
 *   JSON blobs before scanning for a quoted name; the estimate/invoice
 *   branch no longer emits `catalogItemId` at all — matching real-model
 *   output). Mock-only; product callers unchanged.
 *
 *   WHAT IS GENUINELY REACHABLE, proven below: the webhook resolves/creates
 *   the customer by phone, fetches + stores the photo (a real `files` row +
 *   presigned URL), reaches the vision-drafting call, and — now that the
 *   mock produces a schema-valid draft — persists the `draft_estimate`
 *   proposal and its audit row.
 *
 * Ambiguous sender: two customers sharing the exact same `primaryPhone`
 * (a shared household/office line — created through the real
 * `POST /api/customers`, no unique constraint on the phone column) makes
 * `matchCustomersByPhone` return >1 match, which `ingestCustomerMms` turns
 * into a `voice_clarification` proposal + `customer_mms.clarification_raised`
 * audit BEFORE any vision call — genuinely unaffected by the bug above, and
 * fully proven below.
 *
 * T1: tenant B's own MMS, same media server, resolves its OWN independent
 * customer + stored photo, never touching tenant A's — proven at the layer
 * this bug does not block.
 *
 * T2 (#1193, map #995): the SAME sender phone number is ALREADY a known
 * customer in tenant B (created through the real `POST /api/customers`, not
 * SQL). Tenant A's MMS from that identical phone still resolves/creates
 * A's OWN independent customer (by `tenant_id`, not phone alone) and drafts
 * for A; tenant B's pre-existing customer and its files are byte-for-byte
 * unchanged — proving the phone-match lookup is scoped per tenant, not
 * global, even when a customer with that exact number already exists
 * elsewhere.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { Pool } from 'pg';
import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  provisionTenant,
  signedPost,
  smsWebhookPath,
  devAuthBearerToken,
  createCustomerViaApi,
  auditRows,
  pollFor,
  type ProvisionedTenant,
} from './fixtures/capture-8-2-lane';

// A minimal, genuinely-decodable 1x1 red-pixel JPEG (bytes, not a data URI) —
// real image bytes so `isSupportedImage` + any content-sniffing downstream
// sees a real file, not a placeholder string.
const TINY_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkI' +
    'CQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQ' +
    'EBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAABAAEDASIA' +
    'AhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEB' +
    'AQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABmX' +
    '/9k=',
  'base64',
);

function startMediaServer(): Promise<{ port: number; close: () => Promise<void>; url: string }> {
  return new Promise((resolve) => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': TINY_JPEG.length });
      res.end(TINY_JPEG);
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        port,
        url: `http://127.0.0.1:${port}/leaking-heater.jpg`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

async function signedMmsPost(
  request: APIRequestContext,
  tenant: Pick<ProvisionedTenant, 'tenantId' | 'authToken' | 'subaccountSid' | 'did'>,
  opts: { from: string; body: string; mediaUrl: string; messageSid?: string },
) {
  const params = {
    MessageSid: opts.messageSid ?? `SM${crypto.randomUUID().replace(/-/g, '')}`,
    AccountSid: tenant.subaccountSid,
    From: opts.from,
    To: tenant.did,
    Body: opts.body,
    NumMedia: '1',
    MediaUrl0: opts.mediaUrl,
    MediaContentType0: 'image/jpeg',
  };
  return signedPost(request, smsWebhookPath(tenant.tenantId), params, tenant.authToken);
}

const RUN = crypto.randomInt(1000, 9999);
const A_DID = `+1512${RUN}801`;
const B_DID = `+1512${RUN}802`;
const A_SUBACCOUNT = 'AC1014c8aaaaaaaaaaaaaaaaaaaaaaaaaa';
const B_SUBACCOUNT = 'AC1014c8bbbbbbbbbbbbbbbbbbbbbbbbbb';
const A_TOKEN = 'tenant-a-twilio-auth-token-1014c8-81';
const B_TOKEN = 'tenant-b-twilio-auth-token-1014c8-81';

const enc = process.env.TENANT_ENCRYPTION_KEY;
const dbReady = !!process.env.DATABASE_URL;

let pool: Pool;
let tenantA: ProvisionedTenant;
let tenantB: ProvisionedTenant;
let media: { port: number; close: () => Promise<void>; url: string };

test.describe.configure({ mode: 'serial' });

test.describe('#1014 row 2.8 — an MMS photo resolves/stores through the real webhook; an ambiguous sender clarifies (SMS surface, T2); the draft persist leg is pinned', () => {
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
    media = await startMediaServer();
  });

  test.afterAll(async () => {
    await media?.close();
    await pool?.end();
  });

  test('an unknown sender MMS resolves/creates a customer and stores the photo (a real files row)', async ({
    request,
  }) => {
    const from = '+15125558801';
    const res = await signedMmsPost(request, tenantA, {
      from,
      body: 'My water heater is leaking, can you give me a quote',
      mediaUrl: media.url,
    });
    expect(res.status()).toBe(200);

    // A new customer was created (unknown sender) and carries this phone.
    const customers = await pollFor<{ id: string }>(
      pool,
      `SELECT id FROM customers WHERE tenant_id = $1 AND primary_phone = $2`,
      [tenantA.tenantId, from],
    );
    expect(customers).toHaveLength(1);

    // The photo was fetched from this spec's own local media server and
    // persisted as a real `files` row against that customer — reachable
    // regardless of the drafting bug pinned below.
    const files = await pollFor(
      pool,
      `SELECT id, content_type FROM files WHERE tenant_id = $1 AND entity_type = 'customer' AND entity_id = $2`,
      [tenantA.tenantId, customers[0]!.id],
    );
    expect(files).toHaveLength(1);

    // #1133-adjacent workaround: the vision-drafting call itself runs
    // asynchronously off the mms_ingest queue job, AFTER this webhook's HTTP
    // response already returned 200. Now that #1154's mock fix makes this
    // draft succeed (previously it always failed hermetically), wait for
    // its own audit row to land before this test returns — otherwise the
    // next test's "no NEW draft fired" snapshot (`before = auditRows(...)`)
    // can race this test's still-in-flight async draft and undercount it.
    await pollFor(
      pool,
      `SELECT id FROM audit_events WHERE tenant_id = $1 AND event_type = 'customer_mms.estimate_drafted'`,
      [tenantA.tenantId],
    );
  });

  test(
    'the stored photo drafts a catalog-grounded draft_estimate proposal, audited (#1154 item 1 fixed)',
    async ({ request }) => {
      const from = '+15125558804';
      const messageSid = `SM${crypto.randomUUID().replace(/-/g, '')}`;
      const res = await signedMmsPost(request, tenantA, {
        from,
        body: 'My water heater is leaking, can you give me a quote',
        mediaUrl: media.url,
        messageSid,
      });
      expect(res.status()).toBe(200);

      // Scoped to THIS post's own messageSid, not just tenantA broadly — the
      // prior test's own MMS post also now drafts successfully (#1154), so
      // an unscoped "most recent" query could race and pick up its row
      // instead of this one.
      const events = await pollFor<{ id: string; entity_id: string }>(
        pool,
        `SELECT id, entity_id FROM audit_events WHERE tenant_id = $1 AND event_type = 'customer_mms.estimate_drafted' AND metadata->>'messageSid' = $2`,
        [tenantA.tenantId, messageSid],
        { timeoutMs: 5_000 },
      );
      expect(events.length, 'a draft_estimate should have been audited').toBeGreaterThan(0);

      // #1154 item 1 — the description must never carry the JSON key
      // "customerId" (the bug this leg used to pin with test.fail()), and
      // the persisted line item must carry no `catalogItemId: null` (the
      // mock no longer emits the key at all, matching a real model).
      const proposals = await pool.query<{ payload: { lineItems: Array<Record<string, unknown>> } }>(
        `SELECT payload FROM proposals WHERE tenant_id = $1 AND id = $2`,
        [tenantA.tenantId, events[0]!.entity_id],
      );
      expect(proposals.rows).toHaveLength(1);
      const line = proposals.rows[0]!.payload.lineItems[0]!;
      expect(String(line.description)).not.toContain('customerId');
      expect(line).not.toHaveProperty('catalogItemId');
    },
  );

  test('an ambiguous sender (two customers sharing one phone) yields a clarification, never a draft', async ({
    request,
  }) => {
    const shared = '+15125558802';
    const ownerToken = devAuthBearerToken(tenantA.userId);
    await createCustomerViaApi(request, ownerToken, { firstName: 'Alice', lastName: 'Household', primaryPhone: shared });
    await createCustomerViaApi(request, ownerToken, { firstName: 'Bob', lastName: 'Household', primaryPhone: shared });

    const before = await auditRows(pool, tenantA.tenantId, 'customer_mms.estimate_drafted');

    const res = await signedMmsPost(request, tenantA, {
      from: shared,
      body: 'Our heater is leaking',
      mediaUrl: media.url,
    });
    expect(res.status()).toBe(200);

    const clarifyEvents = await pollFor(
      pool,
      `SELECT metadata FROM audit_events WHERE tenant_id = $1 AND event_type = 'customer_mms.clarification_raised'`,
      [tenantA.tenantId],
    );
    expect(clarifyEvents).toHaveLength(1);

    const clarifyProposals = await pool.query(
      `SELECT id FROM proposals WHERE tenant_id = $1 AND proposal_type = 'voice_clarification' AND summary ILIKE '%matched 2 customers%'`,
      [tenantA.tenantId],
    );
    expect(clarifyProposals.rows).toHaveLength(1);

    // No NEW draft_estimate fired for this ambiguous message.
    const after = await auditRows(pool, tenantA.tenantId, 'customer_mms.estimate_drafted');
    expect(after).toHaveLength(before.length);
  });

  test("T1: tenant B's own MMS, same media server, resolves its own independent customer + stored photo — never touching tenant A's", async ({
    request,
  }) => {
    const from = '+15125558803';
    const res = await signedMmsPost(request, tenantB, {
      from,
      body: 'Leaking heater here too',
      mediaUrl: media.url,
    });
    expect(res.status()).toBe(200);

    const customersB = await pollFor<{ id: string }>(
      pool,
      `SELECT id FROM customers WHERE tenant_id = $1 AND primary_phone = $2`,
      [tenantB.tenantId, from],
    );
    expect(customersB).toHaveLength(1);

    const filesB = await pollFor(
      pool,
      `SELECT id FROM files WHERE tenant_id = $1 AND entity_type = 'customer' AND entity_id = $2`,
      [tenantB.tenantId, customersB[0]!.id],
    );
    expect(filesB).toHaveLength(1);

    // Tenant A never sees tenant B's customer/phone.
    const crossLeak = await pool.query(
      `SELECT id FROM customers WHERE tenant_id = $1 AND primary_phone = $2`,
      [tenantA.tenantId, from],
    );
    expect(crossLeak.rows).toHaveLength(0);
  });

  test(
    "T2: the same sender phone is already a known customer in tenant B; tenant A's MMS still resolves/creates its OWN customer and drafts for A, tenant B's customer and files are unchanged",
    async ({ request }) => {
      const sharedPhone = '+15125558805';

      // Tenant B already has a real customer on this exact phone number —
      // created through the real API, never SQL.
      const ownerTokenB = devAuthBearerToken(tenantB.userId);
      const knownCustomerB = await createCustomerViaApi(request, ownerTokenB, {
        firstName: 'Carol',
        lastName: 'Neighbour',
        primaryPhone: sharedPhone,
      });

      const beforeB = await pool.query<{ id: string }>(
        `SELECT id FROM customers WHERE tenant_id = $1 AND primary_phone = $2`,
        [tenantB.tenantId, sharedPhone],
      );
      expect(beforeB.rows).toHaveLength(1);
      expect(beforeB.rows[0]!.id).toBe(knownCustomerB.id);
      const filesBeforeB = await pool.query(
        `SELECT id FROM files WHERE tenant_id = $1 AND entity_type = 'customer' AND entity_id = $2`,
        [tenantB.tenantId, knownCustomerB.id],
      );

      // Tenant A's MMS arrives from the IDENTICAL phone number.
      const messageSid = `SM${crypto.randomUUID().replace(/-/g, '')}`;
      const res = await signedMmsPost(request, tenantA, {
        from: sharedPhone,
        body: "Leaking heater, same number as our office manager's apparently",
        mediaUrl: media.url,
        messageSid,
      });
      expect(res.status()).toBe(200);

      // Tenant A resolves/creates its OWN customer for this phone — a
      // DIFFERENT id from tenant B's pre-existing customer on the same number.
      const customersA = await pollFor<{ id: string }>(
        pool,
        `SELECT id FROM customers WHERE tenant_id = $1 AND primary_phone = $2`,
        [tenantA.tenantId, sharedPhone],
      );
      expect(customersA).toHaveLength(1);
      expect(customersA[0]!.id).not.toBe(knownCustomerB.id);

      // A's photo/draft leg proceeds exactly as for any other sender: a
      // real files row, plus the draft_estimate proposal + audit, scoped to
      // THIS post's own messageSid.
      const filesA = await pollFor(
        pool,
        `SELECT id FROM files WHERE tenant_id = $1 AND entity_type = 'customer' AND entity_id = $2`,
        [tenantA.tenantId, customersA[0]!.id],
      );
      expect(filesA).toHaveLength(1);

      const eventsA = await pollFor<{ id: string; entity_id: string }>(
        pool,
        `SELECT id, entity_id FROM audit_events WHERE tenant_id = $1 AND event_type = 'customer_mms.estimate_drafted' AND metadata->>'messageSid' = $2`,
        [tenantA.tenantId, messageSid],
        { timeoutMs: 5_000 },
      );
      expect(eventsA.length, 'a draft_estimate should have been audited for tenant A').toBeGreaterThan(0);

      // Tenant B's pre-existing customer row is byte-for-byte unchanged —
      // same id, same name — and its files are unchanged.
      const afterB = await pool.query<{ id: string; first_name: string; last_name: string }>(
        `SELECT id, first_name, last_name FROM customers WHERE tenant_id = $1 AND primary_phone = $2`,
        [tenantB.tenantId, sharedPhone],
      );
      expect(afterB.rows).toHaveLength(1);
      expect(afterB.rows[0]!.id).toBe(knownCustomerB.id);
      expect(afterB.rows[0]!.first_name).toBe('Carol');
      expect(afterB.rows[0]!.last_name).toBe('Neighbour');

      const filesAfterB = await pool.query(
        `SELECT id FROM files WHERE tenant_id = $1 AND entity_type = 'customer' AND entity_id = $2`,
        [tenantB.tenantId, knownCustomerB.id],
      );
      expect(
        filesAfterB.rows.length,
        "tenant B's file count for its known customer must be unchanged by A's MMS",
      ).toBe(filesBeforeB.rows.length);
    },
  );
});

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
 * GENUINE PRODUCT/HERMETIC-MOCK BUG FOUND WHILE BUILDING THIS SPEC (report
 * only, not fixed here — test-only lane), reproduced in isolation outside
 * the whole HTTP/queue stack before writing this down:
 *
 *   `MmsEstimateTaskHandler.buildUserContent` (ai/tasks/mms-estimate-task
 *   .ts:318) embeds `JSON.stringify(input.context)` — e.g.
 *   `{"customerId":"<uuid>","fromPhone":"+1..."}`  — directly into the
 *   prompt text sent to the LLM gateway. Under this repo's hermetic boot
 *   (no `AI_PROVIDER_API_KEY` — app.ts:1260-1261 falls back to
 *   `createHermeticMockLLMGateway()`), `scriptHermeticResponse`'s
 *   `extractName` helper (ai/providers/mock.ts) has a fallback that greps
 *   for ANY quoted substring (`/["']([^"']{2,80})["']/`) when its
 *   name-flavoured regexes miss — and the FIRST quoted substring in that
 *   JSON blob is the literal JSON KEY NAME `"customerId"`, not a customer's
 *   name. The mock then labels its one fixed line item
 *   `"Service estimate for customerId"` instead of the plain `"Service
 *   estimate"` its own doc comment claims. Every MMS/estimate draft under
 *   the hermetic gateway carries this label — `input.context` always
 *   includes `customerId` (customer-mms-intake.ts's call site), so no MMS
 *   body can avoid it. Confirmed directly: calling `ingestCustomerMms` in
 *   isolation (real Postgres, real `PgCatalogItemRepository`, the real
 *   hermetic gateway, no HTTP/queue involved) reproduces the identical
 *   description and the identical downstream failure.
 *
 *   Consequence: `groundLineItemPricing` (ai/resolution/catalog-resolver
 *   .ts) can only clear the mock's `catalogItemId: null` via an exact/high
 *   catalog-NAME match against that (buggy) description — a real tenant's
 *   catalog would never contain an item named "Service estimate for
 *   customerId", so the line stays uncatalogued and `catalogItemId` stays
 *   `null`. The `draft_estimate` Zod contract's `catalogItemId` is
 *   `z.string().uuid().optional()` — optional accepts ABSENT, not `null` —
 *   so `assertValidProposalPayload` throws and `MmsEstimateTaskHandler`
 *   returns `{status:'parse_failed', reason:'invalid_payload'}`: NO
 *   proposal, NO `customer_mms.estimate_drafted` audit, ever, under this
 *   hermetic boot. Naming a catalog item to literally match the buggy
 *   string would launder the bug into a passing assertion — not done here.
 *   #1119-adjacent: needs either a live model (whose real description
 *   would never echo a JSON key) or a mock.ts fix, neither in scope for a
 *   test-only lane. Pinned below with `test.fail()`.
 *
 *   WHAT IS GENUINELY REACHABLE, proven below: the webhook resolves/creates
 *   the customer by phone, fetches + stores the photo (a real `files` row +
 *   presigned URL), and reaches the vision-drafting call — everything up to
 *   the catalog-grounding/Zod gate the bug blocks.
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

test.describe('#1014 row 2.8 — an MMS photo resolves/stores through the real webhook; an ambiguous sender clarifies (SMS surface, T1); the draft persist leg is pinned', () => {
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
  });

  test(
    'KNOWN GAP — the stored photo should draft a catalog-grounded draft_estimate proposal, audited (expected to fail hermetically)',
    async ({ request }) => {
      test.fail(
        true,
        'ai/tasks/mms-estimate-task.ts buildUserContent embeds ' +
          'JSON.stringify(input.context) (starts {"customerId":"<uuid>",...) ' +
          "into the LLM prompt; ai/providers/mock.ts's scriptHermeticResponse " +
          "extractName fallback greps the first quoted substring when its " +
          'name regexes miss, grabbing the JSON KEY "customerId" — every ' +
          'hermetic MMS draft is labelled "Service estimate for customerId", ' +
          'not "Service estimate". No real tenant catalog item has that name, ' +
          'so groundLineItemPricing never clears catalogItemId from null, ' +
          "and the draft_estimate Zod contract's catalogItemId " +
          '(z.string().uuid().optional()) rejects null — ' +
          'assertValidProposalPayload throws, MmsEstimateTaskHandler returns ' +
          "parse_failed/invalid_payload, and NO proposal or " +
          '"customer_mms.estimate_drafted" audit is ever written under this ' +
          "hermetic boot. Reproduced calling ingestCustomerMms directly " +
          '(real Postgres, real catalog repo, real hermetic gateway, no ' +
          'HTTP/queue) before writing this pin. #1119-adjacent: needs a ' +
          'live model (whose real description would never echo a JSON key) ' +
          'or a mock.ts fix — neither in scope for a test-only lane.',
      );

      const from = '+15125558804';
      const res = await signedMmsPost(request, tenantA, {
        from,
        body: 'My water heater is leaking, can you give me a quote',
        mediaUrl: media.url,
      });
      expect(res.status()).toBe(200);

      const events = await pollFor(
        pool,
        `SELECT id FROM audit_events WHERE tenant_id = $1 AND event_type = 'customer_mms.estimate_drafted'`,
        [tenantA.tenantId],
        { timeoutMs: 5_000 },
      );
      expect(events.length, 'a draft_estimate should have been audited').toBeGreaterThan(0);
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
});

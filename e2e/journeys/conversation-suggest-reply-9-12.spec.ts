import { test, expect, APIRequestContext } from '@playwright/test';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import { installClerkStub } from '../helpers/clerk-stub';
import { blockExternalHosts } from '../helpers/api-mocks/shell';
import { hasViteClerkKey } from '../helpers/clerk-key';
import { PgConversationRepository } from '../../packages/api/src/conversations/pg-conversation';
import { PgCustomerRepository } from '../../packages/api/src/customers/pg-customer';

/**
 * §8.9 row 9.12 — rung-5 REACHABILITY for the AI-suggestion leg of the
 * unified inbox ("a draft returns and zero dispatch rows are written").
 *
 * G1 already proves the inbox listing (T1, real Postgres) and the guarded
 * send — including the DNC refusal, the "never auto-sent" half — at real
 * Postgres (test/integration/conversation-inbox.test.ts,
 * test/routes/conversation-reply-send.test.ts). What has never run is the
 * suggest-reply leg itself, on any surface: `POST /api/conversations/:id/
 * suggest-reply` (routes/conversations.ts:303) has no integration test at
 * all, and the web button that calls it (`✨ Suggest reply`,
 * components/conversations/MessageInput.tsx) had never been clicked in a
 * real browser.
 *
 * This is reachable WITHOUT a live model: app.ts (~line 1259) wires
 * `llmGateway` to `createHermeticMockLLMGateway()` whenever
 * `AI_PROVIDER_API_KEY` is unset — the SAME real gateway object the route
 * calls, not a test-only substitute (its own comment: "Assistant can still
 * draft proposals" without a key). For `taskType: 'suggest_reply'`
 * specifically, `ai/providers/mock.ts`'s scripted branches (transcription
 * correction, classify_intent, draft_estimate/invoice, assistant/chat) all
 * miss, so it falls to the generic fallback
 * (`JSON.stringify({ok:true,mock:true,taskType,note:'hermetic-mock'})`) —
 * non-empty, so `SuggestReplyTask` returns it as the draft rather than
 * throwing "empty draft". The row's acceptance only asks that A draft
 * return, not that it be a good one — the CONTENT of the draft is out of
 * scope (a real model turn would be #1119; this row doesn't need one).
 */

const API_URL = process.env.E2E_API_URL ?? 'http://localhost:3000';
const CLERK_WEBHOOK_SECRET =
  process.env.E2E_CLERK_WEBHOOK_SECRET ?? 'whsec_dGVzdC1zaWdudXAtY3JpdGljYWwtcGF0aA==';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function b64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}
function unsignedJwt(sub: string): string {
  return `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url({ sub, sid: 'dev-session', role: 'owner' })}.x`;
}
function signSvix(rawBody: string, svixId: string, svixTimestamp: string): string {
  const secret = Buffer.from(CLERK_WEBHOOK_SECRET.replace(/^whsec_/, ''), 'base64');
  const sig = createHmac('sha256', secret).update(`${svixId}.${svixTimestamp}.${rawBody}`).digest('base64');
  return `v1,${sig}`;
}

const WELCOME_SEEN_KEY = 'walkthrough.welcome.v1';
const WHATS_NEW_SEEN_KEY = 'walkthrough.whatsnew.lastSeen';
const SCREENSHOT_DIR = join(process.cwd(), 'docs/audit/lane-reports/8-9-close-r5');
mkdirSync(SCREENSHOT_DIR, { recursive: true });

interface BootstrappedOwner {
  tenantId: string;
  sub: string;
  jwt: string;
  authHeaders: { Authorization: string };
}

async function bootstrapOwner(request: APIRequestContext, label: string): Promise<BootstrappedOwner> {
  const sub = `user_e2e_suggestreply_${label}_${randomUUID().replace(/-/g, '')}`;
  const email = `owner-sr-${label}-${Date.now()}@serviceos-hermetic.test`;
  const jwt = unsignedJwt(sub);
  const authHeaders = { Authorization: `Bearer ${jwt}` };

  const svixId = `evt_${randomUUID()}`;
  const svixTimestamp = String(Math.floor(Date.now() / 1000));
  const rawBody = JSON.stringify({ type: 'user.created', data: { id: sub, email_addresses: [{ email_address: email }] } });
  const webhookRes = await request.post(`${API_URL}/webhooks/clerk`, {
    headers: {
      'content-type': 'application/json',
      'svix-id': svixId,
      'svix-timestamp': svixTimestamp,
      'svix-signature': signSvix(rawBody, svixId, svixTimestamp),
    },
    data: rawBody,
  });
  expect(webhookRes.status(), `webhook rejected: ${await webhookRes.text()}`).toBe(200);

  const meRes = await request.get(`${API_URL}/api/me`, { headers: authHeaders });
  expect(meRes.status()).toBe(200);
  const me = (await meRes.json()) as { tenant_id?: string };
  expect(me.tenant_id).toMatch(UUID_RE);
  const tenantId = me.tenant_id!;

  const identityRes = await request.put(`${API_URL}/api/onboarding/identity`, {
    headers: { 'content-type': 'application/json', ...authHeaders },
    data: JSON.stringify({
      businessName: `Suggest Reply 9.12 ${label} Co`,
      businessHours: { mon: { open: '08:00', close: '17:00' }, sat: null, sun: null },
      jobBufferMinutes: 30,
      hourlyRateCents: 12500,
      timezone: 'America/Chicago',
    }),
  });
  expect(identityRes.ok(), `PUT /api/onboarding/identity -> ${identityRes.status()}`).toBeTruthy();

  return { tenantId, sub, jwt, authHeaders };
}

test.describe('9.12 reachability — AI-suggestion leg of the unified inbox', () => {
  const canRun =
    !process.env.E2E_BASE_URL &&
    hasViteClerkKey() &&
    process.env.E2E_USE_TEST_DB === 'true' &&
    !!process.env.DATABASE_URL;
  test.skip(
    !canRun,
    'Requires the local webServer pair against a real Postgres: leave E2E_BASE_URL unset, ' +
      'set VITE_CLERK_PUBLISHABLE_KEY (placeholder ok), E2E_USE_TEST_DB=true, and DATABASE_URL ' +
      'pointing at the test container (also used directly here to seed the conversation thread).',
  );

  test('owner opens a real thread, clicks Suggest reply, a draft returns from the real route, and zero dispatch rows are written until Send is pressed', async ({
    page,
    request,
    baseURL,
  }) => {
    test.setTimeout(60_000);
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    const owner = await bootstrapOwner(request, 'owner');

    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    let conversationId: string;
    try {
      const customerRepo = new PgCustomerRepository(pool);
      const conversationRepo = new PgConversationRepository(pool);
      const now = new Date();
      const customer = await customerRepo.create({
        id: randomUUID(),
        tenantId: owner.tenantId,
        firstName: 'Sam',
        lastName: 'Suggest',
        displayName: 'Sam Suggest',
        primaryPhone: '+15555552099',
        preferredChannel: 'sms',
        smsConsent: true,
        isArchived: false,
        createdBy: owner.sub,
        createdAt: now,
        updatedAt: now,
      });
      const thread = await conversationRepo.createConversation({
        tenantId: owner.tenantId,
        title: customer.displayName,
        entityType: 'customer',
        entityId: customer.id,
        createdBy: owner.sub,
      });
      await conversationRepo.addMessage({
        tenantId: owner.tenantId,
        conversationId: thread.id,
        messageType: 'text',
        content: 'Can you come back and take another look at the leak?',
        senderId: customer.id,
        senderRole: 'customer',
        source: 'sms',
        metadata: { direction: 'inbound', channel: 'sms' },
      });
      conversationId = thread.id;
    } finally {
      await pool.end().catch(() => undefined);
    }

    await installClerkStub(page, { signedIn: true, sub: owner.sub, token: owner.jwt });
    await page.addInitScript(
      ({ welcomeKey, whatsNewKey }) => {
        try {
          localStorage.setItem(welcomeKey, '1');
          localStorage.setItem(whatsNewKey, '2026-06-21-onboarding');
        } catch {
          /* private mode */
        }
      },
      { welcomeKey: WELCOME_SEEN_KEY, whatsNewKey: WHATS_NEW_SEEN_KEY },
    );
    await blockExternalHosts(page, baseURL!);

    await page.goto('/comms-inbox');
    await expect(page.getByTestId('comms-thread-row').first()).toBeVisible({ timeout: 15_000 });
    await page.getByTestId('comms-thread-row').first().click();
    await expect(page.getByTestId('message-suggest-button')).toBeVisible({ timeout: 15_000 });
    await page.screenshot({ path: join(SCREENSHOT_DIR, '9-12-01-thread-open.png') });

    const suggestPromise = page.waitForResponse(
      (r) => r.request().method() === 'POST' && new URL(r.url()).pathname === `/api/conversations/${conversationId}/suggest-reply`,
    );
    await page.getByTestId('message-suggest-button').click();
    const suggestRes = await suggestPromise;
    expect(suggestRes.status(), `POST suggest-reply -> ${suggestRes.status()}`).toBe(200);
    const suggestBody = (await suggestRes.json()) as { draft?: string };
    expect(typeof suggestBody.draft).toBe('string');
    expect(suggestBody.draft!.length).toBeGreaterThan(0);

    // The draft lands in the composer — a proposal, not a send. Zero dispatch
    // rows exist because the reply was never sent, only suggested.
    await expect(page.getByTestId('message-input-field')).toHaveValue(suggestBody.draft!);
    await page.screenshot({ path: join(SCREENSHOT_DIR, '9-12-02-draft-in-composer.png') });

    const messagesRes = await request.get(`${API_URL}/api/conversations/${conversationId}/messages`, {
      headers: owner.authHeaders,
    });
    expect(messagesRes.ok(), `GET messages -> ${messagesRes.status()}`).toBeTruthy();
    const messages = (await messagesRes.json()) as Array<{ senderRole: string }>;
    const outbound = messages.filter((m) => m.senderRole === 'owner');
    expect(outbound, 'suggest-reply must never itself create a message/dispatch row').toHaveLength(0);

    expect(pageErrors, 'no uncaught page errors across the 9.12 suggest-reply flow').toEqual([]);
  });
});

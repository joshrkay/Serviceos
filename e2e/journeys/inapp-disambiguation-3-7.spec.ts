import { test, expect, request as pwRequest, type APIRequestContext, type Browser, type Page } from '@playwright/test';
import { Pool } from 'pg';
import { hasViteClerkKey } from '../helpers/clerk-key';
import { bootstrapOwner, postJson, signInBrowser, type RealOwner } from '../helpers/real-stack-tenant';

/**
 * §8.3 row 3.7 (#1015) — "As M, I want the AI to ask instead of guessing when
 * two customers share a name, so it never books the wrong Henderson" — the
 * IN-APP half (the phone/Gather half is `e2e/telephony-book-3-7-disambiguation.spec.ts`).
 *
 * Surface: the owner's in-app voice session (`/assistant` → Live session,
 * `/api/voice/sessions`), in a real browser at real Postgres. No model:
 * "Open a job for Jamie Rivera, leaking faucet repair" is the deterministic
 * owner create_job command (OWNER_OPERATOR_COMMAND_PATTERNS), the ambiguity
 * is PgEntityResolver's own result, the question is the FSM's disambiguate
 * template, the answer is placed by `resolveDisambiguationFollowUp`, and the
 * "yes" is the hermetic confirm (#1119).
 *
 * Criterion: the result is an ambiguity carrying BOTH candidates — never a
 * silent pick. Proven here as: the session asks (no proposal yet), the
 * `entity_ambiguous` side effect names exactly tenant A's two Jamie Riveras,
 * the owner's answer picks the 12 Oak Street one, and the approved job is
 * opened for THAT customer (not 48 Pine Avenue).
 *
 * `create_job` is the vehicle for the same reason as the phone spec: no
 * deterministic booking utterance carries a customer name.
 *
 * T1/T2: tenant B has ONE Jamie Rivera. B's identical command does not ask
 * (A's namesakes never become B's candidates) and A's candidate count stays
 * at two with B's namesake present.
 */

const API_URL = process.env.E2E_NOAUTHBYPASS_API_URL ?? 'http://localhost:3002';
const SHOTS = 'docs/audit/lane-reports/1015-1018-rows-rung5';
const COMMAND = 'Open a job for Jamie Rivera, leaking faucet repair';

async function addCustomer(api: APIRequestContext, owner: RealOwner, phone: string, street: string): Promise<string> {
  const customer = await postJson(api, `${API_URL}/api/customers`, owner.headers, {
    firstName: 'Jamie',
    lastName: 'Rivera',
    primaryPhone: phone,
  });
  await postJson(api, `${API_URL}/api/locations`, owner.headers, {
    customerId: customer.id,
    street1: street,
    city: 'Austin',
    state: 'TX',
    postalCode: '78701',
    isPrimary: true,
  });
  return customer.id;
}

async function openLiveSession(browser: Browser, baseURL: string, owner: RealOwner): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await signInBrowser(page, baseURL, owner.sub, owner.token);
  await page.goto('/assistant');
  await page.getByRole('button', { name: /live session/i }).click();
  await page.getByRole('button', { name: /start session/i }).click();
  await expect(page.getByPlaceholder('Type your message…')).toBeEnabled({ timeout: 15_000 });
  return page;
}

/** Send one turn through the panel and return the API's turn body. */
async function say(page: Page, text: string): Promise<{ sideEffects?: Array<{ type?: string; payload?: { candidates?: Array<{ id?: string }> } }>; proposalIds?: string[]; ttsText?: string }> {
  const input = page.getByPlaceholder('Type your message…');
  await expect(input).toBeEnabled({ timeout: 15_000 });
  await input.fill(text);
  const turn = page.waitForResponse(
    (r) => r.request().method() === 'POST' && /\/api\/voice\/sessions\/[^/]+\/input$/.test(new URL(r.url()).pathname),
  );
  await page.getByRole('button', { name: /^send$/i }).click();
  const res = await turn;
  expect(res.status()).toBe(200);
  return res.json();
}

test.describe('3.7 in-app — the assistant asks which Jamie Rivera instead of guessing (real Postgres)', () => {
  const canRun =
    !process.env.E2E_BASE_URL &&
    hasViteClerkKey() &&
    process.env.E2E_USE_TEST_DB === 'true' &&
    !!process.env.DATABASE_URL &&
    !process.env.AI_PROVIDER_API_KEY;
  test.skip(!canRun, 'Needs the local webServer pairs against a real Postgres and NO AI_PROVIDER_API_KEY.');

  let api: APIRequestContext;
  let pool: Pool;
  let ownerA: RealOwner;
  let ownerB: RealOwner;
  let oakId: string;
  let pineId: string;
  let bOnlyId: string;

  test.beforeAll(async () => {
    test.setTimeout(180_000); // seeding through the real API is slow under load
    if (!canRun) return;
    api = await pwRequest.newContext({ timeout: 60_000 });
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    ownerA = await bootstrapOwner(api, API_URL, pool, 'namesake-a');
    ownerB = await bootstrapOwner(api, API_URL, pool, 'namesake-b');
    oakId = await addCustomer(api, ownerA, '512-555-0171', '12 Oak Street');
    pineId = await addCustomer(api, ownerA, '512-555-0172', '48 Pine Avenue');
    bOnlyId = await addCustomer(api, ownerB, '512-555-0173', '12 Oak Street');
  });

  test.afterAll(async () => {
    await api?.dispose();
    await pool?.end();
  });

  test('two Jamie Riveras → the session asks with both candidates; "the one on 12 Oak Street" → the approved job is that customer\'s; tenant B\'s single namesake never asks (T2)', async ({ browser, baseURL }) => {
    test.setTimeout(180_000);

    // ── Tenant A: the command meets two same-named customers. ─────────────
    const pageA = await openLiveSession(browser, baseURL!, ownerA);
    const ask = await say(pageA, COMMAND);
    const ambiguity = (ask.sideEffects ?? []).find((e) => (e.payload?.candidates?.length ?? 0) > 0);
    expect(ambiguity, `no disambiguation side effect: ${JSON.stringify(ask)}`).toBeTruthy();
    expect(new Set(ambiguity!.payload!.candidates!.map((c) => c.id))).toEqual(new Set([oakId, pineId]));
    expect(ask.proposalIds ?? []).toHaveLength(0);
    await expect(pageA.getByText(/more than one|which/i).first()).toBeVisible({ timeout: 10_000 });
    await pageA.screenshot({ path: `${SHOTS}/3.7-inapp-asks.png`, fullPage: true });
    expect(
      (await pool.query(`SELECT id FROM proposals WHERE tenant_id = $1`, [ownerA.tenantId])).rows,
      'asking drafts nothing',
    ).toHaveLength(0);

    // ── The owner answers; the readback follows; "yes" drafts. ────────────
    const answered = await say(pageA, 'the one on 12 Oak Street');
    expect((answered.ttsText ?? '').toLowerCase()).toMatch(/is that right|confirm/);
    const confirmed = await say(pageA, 'yes');
    expect(confirmed.proposalIds ?? []).toHaveLength(1);
    const proposalId = confirmed.proposalIds![0];
    const { rows: drafted } = await pool.query<{ payload: Record<string, unknown>; proposal_type: string }>(
      `SELECT proposal_type, payload FROM proposals WHERE id = $1 AND tenant_id = $2`,
      [proposalId, ownerA.tenantId],
    );
    expect(drafted[0].proposal_type).toBe('create_job');
    expect(drafted[0].payload.customerId).toBe(oakId);

    // ── Approve on the real Inbox → the job opens for the Oak customer. ───
    await pageA.goto('/inbox');
    const card = pageA.getByTestId('inbox-row').filter({ hasText: /create job/i });
    await expect(card).toHaveCount(1, { timeout: 20_000 });
    const approve = pageA.waitForResponse(
      (r) => r.request().method() === 'POST' && new URL(r.url()).pathname === `/api/proposals/${proposalId}/approve`,
    );
    await card.getByRole('button', { name: /^approve$/i }).click();
    expect((await approve).status()).toBeLessThan(300);
    await expect
      .poll(
        async () =>
          (await pool.query<{ customer_id: string }>(`SELECT customer_id FROM jobs WHERE tenant_id = $1`, [ownerA.tenantId])).rows.map(
            (r) => r.customer_id,
          ),
        { timeout: 30_000, message: 'the approved create_job never opened a job' },
      )
      .toEqual([oakId]);
    const { rows: ambiguousAudits } = await pool.query<{ tenant_id: string }>(
      `SELECT tenant_id FROM audit_events WHERE event_type LIKE '%entity_ambiguous%' AND tenant_id IN ($1, $2)`,
      [ownerA.tenantId, ownerB.tenantId],
    );
    console.log(`[3.7] entity_ambiguous audit rows by tenant: ${JSON.stringify(ambiguousAudits.map((r) => (r.tenant_id === ownerA.tenantId ? 'A' : 'B')))}`);

    // ── Tenant B: one namesake — resolved without a question. ─────────────
    const pageB = await openLiveSession(browser, baseURL!, ownerB);
    const bTurn = await say(pageB, COMMAND);
    expect((bTurn.sideEffects ?? []).some((e) => (e.payload?.candidates?.length ?? 0) > 1)).toBe(false);
    expect((bTurn.ttsText ?? '').toLowerCase()).toMatch(/is that right|confirm/);
    const bConfirmed = await say(pageB, 'yes');
    expect(bConfirmed.proposalIds ?? []).toHaveLength(1);
    const { rows: bDraft } = await pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM proposals WHERE id = $1 AND tenant_id = $2`,
      [bConfirmed.proposalIds![0], ownerB.tenantId],
    );
    expect(bDraft[0].payload.customerId).toBe(bOnlyId);
    expect(
      (await pool.query(`SELECT id FROM jobs WHERE tenant_id = $1`, [ownerB.tenantId])).rows,
      'B approved nothing, so B has no job',
    ).toHaveLength(0);
  });
});

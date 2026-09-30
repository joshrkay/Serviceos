import { test, expect, request as pwRequest, type APIRequestContext, type Browser, type Page } from '@playwright/test';
import { Pool } from 'pg';
import { hasViteClerkKey } from '../helpers/clerk-key';
import {
  bootstrapOwner,
  inviteTechnician,
  postJson,
  signInBrowser,
  tenantWallClockToUtc,
  todayInTz,
  type RealOwner,
  type RealTechnician,
} from '../helpers/real-stack-tenant';
import { PgInvoiceRepository } from '../../packages/api/src/invoices/pg-invoice';
import { PgTimeEntryRepository } from '../../packages/api/src/time-tracking/pg-time-entry';
import { PgExpenseRepository } from '../../packages/api/src/expenses/pg-expense';
import { getJobProfit } from '../../packages/api/src/jobs/job-profit';

/**
 * §8.5 row 5.3 (#1018) — "As Carlos, I want to log my hours by talking":
 * a spoken duration lands a `time_entries` row with the resolved jobId,
 * EXACTLY ONE audit event, tenant-scoped, and the job-profit query counts it.
 *
 * Surface: the in-app voice session (`/assistant` → Live session, the
 * `/api/voice/sessions` adapter), Carlos signed in as himself. No model: the
 * utterance "log two hours on the Garcia job" is recognised by the anchored
 * `matchLogTimePhrase` short-circuit (intent-classifier.ts, #1018), the
 * "yes" by the hermetic confirm (#1119). The owner approves the resulting
 * card on the real `/inbox`; the running API's executor writes the entry.
 *
 * Not the phone: a technician's call is classified on the `field_tech`
 * profile, which does not offer `log_time_entry`, and `log_time_entry` is not
 * on the S1 proposal allowlist (proposals/surface.ts) — see
 * e2e/journeys/log-time-by-voice.spec.ts, which still characterises that.
 *
 * T1: tenant B has its own Carlos and its own "Garcia job"; A's card never
 * shows on B's inbox, B's job profit stays at zero, and A's entry is A's.
 *
 * Runs on `chromium-noauthbypass` (production-shaped auth: the
 * authorization loader resolves each session's internal user).
 */

const API_URL = process.env.E2E_NOAUTHBYPASS_API_URL ?? 'http://localhost:3002';
const TZ = 'America/Chicago';
const SHOTS = 'docs/audit/lane-reports/1015-1018-rows-rung5';
const UTTERANCE = 'log two hours on the Garcia job';

interface Shop {
  owner: RealOwner;
  carlos: RealTechnician;
  jobId: string;
}

async function seedShop(api: APIRequestContext, pool: Pool, label: string): Promise<Shop> {
  const owner = await bootstrapOwner(api, API_URL, pool, `hours-${label}`, TZ);
  const carlos = await inviteTechnician(api, API_URL, owner, `carlos-hours-${label}`);
  const customer = await postJson(api, `${API_URL}/api/customers`, owner.headers, {
    firstName: 'Maria',
    lastName: 'Garcia',
    primaryPhone: label === 'a' ? '512-555-0153' : '512-555-0154',
  });
  const location = await postJson(api, `${API_URL}/api/locations`, owner.headers, {
    customerId: customer.id,
    street1: '1 Garcia Way',
    city: 'Austin',
    state: 'TX',
    postalCode: '78701',
    isPrimary: true,
  });
  const job = await postJson(api, `${API_URL}/api/jobs`, owner.headers, {
    customerId: customer.id,
    locationId: location.id,
    summary: 'Garcia furnace repair',
    priority: 'normal',
    scheduledStart: tenantWallClockToUtc(todayInTz(TZ), '09:00', TZ).toISOString(),
    durationMin: 120,
    timezone: TZ,
    technicianId: carlos.techId,
  });
  return { owner, carlos, jobId: job.id };
}

async function laborMinutes(pool: Pool, tenantId: string, jobId: string): Promise<number> {
  const profit = await getJobProfit(
    { tenantId, jobId, laborRateCentsPerHour: null },
    {
      invoiceRepo: new PgInvoiceRepository(pool),
      timeEntryRepo: new PgTimeEntryRepository(pool),
      expenseRepo: new PgExpenseRepository(pool),
    },
  );
  return profit.laborMinutes;
}

async function signedInPage(browser: Browser, baseURL: string, sub: string, token: string): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await signInBrowser(page, baseURL, sub, token);
  return page;
}

test.describe('5.3 — Carlos logs his hours by talking (in-app voice), real Postgres', () => {
  const canRun =
    !process.env.E2E_BASE_URL &&
    hasViteClerkKey() &&
    process.env.E2E_USE_TEST_DB === 'true' &&
    !!process.env.DATABASE_URL &&
    !process.env.AI_PROVIDER_API_KEY;
  test.skip(
    !canRun,
    'Needs the local webServer pairs against a real Postgres (E2E_USE_TEST_DB=true, DATABASE_URL) and NO ' +
      'AI_PROVIDER_API_KEY (the proof is that no model is needed).',
  );

  let api: APIRequestContext;
  let pool: Pool;
  let shopA: Shop;
  let shopB: Shop;

  test.beforeAll(async () => {
    test.setTimeout(180_000); // seeding through the real API is slow under load
    if (!canRun) return;
    api = await pwRequest.newContext({ timeout: 60_000 });
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    shopA = await seedShop(api, pool, 'a');
    shopB = await seedShop(api, pool, 'b');
  });

  test.afterAll(async () => {
    await api?.dispose();
    await pool?.end();
  });

  test('"log two hours on the Garcia job" → the owner approves → one time entry on that job, one audit event, counted by job profit; tenant B untouched (T1)', async ({ browser, baseURL }) => {
    test.setTimeout(180_000);
    const pageErrors: string[] = [];

    // ── Carlos speaks (text mode of the live session) on /assistant. ──────
    const carlosPage = await signedInPage(browser, baseURL!, shopA.carlos.sub, shopA.carlos.token);
    carlosPage.on('pageerror', (err) => pageErrors.push(err.message));
    await carlosPage.goto('/assistant');
    await carlosPage.getByRole('button', { name: /live session/i }).click();
    await carlosPage.getByRole('button', { name: /start session/i }).click();
    const input = carlosPage.getByPlaceholder('Type your message…');
    await expect(input).toBeEnabled({ timeout: 15_000 });

    await input.fill(UTTERANCE);
    await carlosPage.getByRole('button', { name: /^send$/i }).click();
    // The session reaches the confirm readback (state badge intent_confirm).
    await expect(carlosPage.getByText('intent_confirm')).toBeVisible({ timeout: 20_000 });
    await expect(carlosPage.getByText(/is that right\?/i)).toBeVisible();
    await expect(input).toBeEnabled({ timeout: 15_000 });
    await input.fill('yes');
    await carlosPage.getByRole('button', { name: /^send$/i }).click();
    await expect(carlosPage.getByText('Proposals queued: 1')).toBeVisible({ timeout: 20_000 });
    await carlosPage.screenshot({ path: `${SHOTS}/5.3-carlos-live-session.png`, fullPage: true });

    const { rows: drafted } = await pool.query<{ id: string; status: string; payload: Record<string, unknown> }>(
      `SELECT id, status, payload FROM proposals WHERE tenant_id = $1 AND proposal_type = 'log_time_entry'`,
      [shopA.owner.tenantId],
    );
    expect(drafted).toHaveLength(1);
    expect(drafted[0].payload).toMatchObject({ jobId: shopA.jobId, durationMinutes: 120 });
    expect(
      (await pool.query(`SELECT id FROM time_entries WHERE tenant_id = $1`, [shopA.owner.tenantId])).rows,
      'nothing is written before the owner approves',
    ).toHaveLength(0);

    // ── The owner approves on the real Inbox. ─────────────────────────────
    const ownerPage = await signedInPage(browser, baseURL!, shopA.owner.sub, shopA.owner.token);
    ownerPage.on('pageerror', (err) => pageErrors.push(err.message));
    await ownerPage.goto('/inbox');
    const card = ownerPage.getByTestId('inbox-row').filter({ hasText: /log time entry/i });
    await expect(card).toHaveCount(1, { timeout: 20_000 });
    await ownerPage.screenshot({ path: `${SHOTS}/5.3-owner-inbox.png`, fullPage: true });
    const approved = ownerPage.waitForResponse(
      (r) => r.request().method() === 'POST' && new URL(r.url()).pathname === `/api/proposals/${drafted[0].id}/approve`,
    );
    await card.getByRole('button', { name: /^approve$/i }).click();
    expect((await approved).status()).toBeLessThan(300);

    // ── The executor writes exactly one entry on the resolved job. ────────
    await expect
      .poll(
        async () =>
          (await pool.query(`SELECT id FROM time_entries WHERE tenant_id = $1 AND job_id = $2`, [shopA.owner.tenantId, shopA.jobId]))
            .rows.length,
        { timeout: 30_000, message: 'the approved time log never became a time_entries row' },
      )
      .toBe(1);
    const { rows: entries } = await pool.query<{ id: string; job_id: string; duration_minutes: number }>(
      `SELECT id, job_id, duration_minutes FROM time_entries WHERE tenant_id = $1`,
      [shopA.owner.tenantId],
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].duration_minutes).toBe(120);
    const { rows: audits } = await pool.query<{ event_type: string }>(
      `SELECT event_type FROM audit_events WHERE tenant_id = $1 AND entity_type = 'time_entry' AND entity_id = $2`,
      [shopA.owner.tenantId, entries[0].id],
    );
    expect(audits, `time-entry audit rows: ${JSON.stringify(audits)}`).toHaveLength(1);
    expect(await laborMinutes(pool, shopA.owner.tenantId, shopA.jobId)).toBe(120);
    console.log(`[5.3] tenant A entry: ${JSON.stringify(entries)} audit: ${JSON.stringify(audits)}`);

    // ── T1: tenant B's owner never sees A's card; B's job is untouched. ──
    const ownerBPage = await signedInPage(browser, baseURL!, shopB.owner.sub, shopB.owner.token);
    await ownerBPage.goto('/inbox');
    await expect(ownerBPage.getByRole('heading').first()).toBeVisible({ timeout: 15_000 });
    await expect(ownerBPage.getByTestId('inbox-row').filter({ hasText: /log time entry/i })).toHaveCount(0);
    expect((await pool.query(`SELECT id FROM time_entries WHERE tenant_id = $1`, [shopB.owner.tenantId])).rows).toHaveLength(0);
    expect(await laborMinutes(pool, shopB.owner.tenantId, shopB.jobId)).toBe(0);
    expect(
      (await pool.query(`SELECT id FROM time_entries WHERE id = $1 AND tenant_id <> $2`, [entries[0].id, shopA.owner.tenantId])).rows,
    ).toHaveLength(0);

    expect(pageErrors, 'no uncaught page errors').toEqual([]);
  });
});

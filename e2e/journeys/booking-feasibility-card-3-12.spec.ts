import { test, expect, request as pwRequest, type APIRequestContext } from '@playwright/test';
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
import { CreateAppointmentAITaskHandler } from '../../packages/api/src/ai/tasks/create-appointment-task';
import { PgProposalRepository } from '../../packages/api/src/proposals/pg-proposal';
import { PgAppointmentRepository } from '../../packages/api/src/appointments/pg-appointment';
import { PgAssignmentRepository } from '../../packages/api/src/appointments/pg-assignment';
import { PgJobRepository } from '../../packages/api/src/jobs/pg-job';
import { PgLocationRepository } from '../../packages/api/src/locations/pg-location';
import { PgWorkingHoursRepository } from '../../packages/api/src/availability/pg-working-hours';
import { PgUnavailableBlockRepository } from '../../packages/api/src/availability/pg-unavailable-block';
import { StubSkillMatcher } from '../../packages/api/src/scheduling/skill-matcher';
import { createTravelTimeProvider } from '../../packages/api/src/scheduling/travel-time/factory';
import type { LLMGateway } from '../../packages/api/src/ai/gateway/gateway';
import type { TaskContext } from '../../packages/api/src/ai/tasks/task-handlers';

/**
 * §8.3 row 3.12 (#1015) — "As M, I want to be warned when back-to-back jobs
 * aren't drivable, so I stop promising times Carlos can't make." Given a
 * proposed booking, infeasibility surfaces on the owner's card — flagged
 * unverified when the estimate is the great-circle fallback.
 *
 * The API already computes the check on both creation paths (hold →
 * `holdFeasibility`, non-held draft → `slotFeasibility`); until this change
 * no web component read either stamp. This spec proves the owner SEES it.
 *
 * Real: tenant, owner, Carlos, the customer's SF home and the Oakland job
 * Carlos finishes at 09:55 tomorrow — all created through the running API.
 * The draft is produced by the production `CreateAppointmentAITaskHandler`
 * with real Postgres repositories and the production travel-time factory
 * (no Google key → the haversine fallback) — the same deps the registry
 * wires. Stubbed, and named: the handler's drafting MODEL call only
 * (it returns the verbatim "tomorrow at 10am" phrase), because the hermetic
 * API has no model to draft a timed booking; the proposal is then persisted
 * through `PgProposalRepository`, as e2e/journeys/appointment-confirmation-inbox-3-8.spec.ts
 * does.
 *
 * The owner opens the real `/inbox`: the card says the drive does not fit
 * and that the estimate is unverified; approving books the appointment.
 * T2 (non-interference, in the same run): tenant B drafts the identical
 * 10am booking for its own customer at the same San Francisco address while
 * tenant A's Carlos is booked in Oakland until 09:55 — exactly the neighbour
 * appointment that makes A's slot infeasible. B's answer is its own: its
 * stamp reads back `{ checked: true, warnings: [] }` and its card shows no
 * warning; A's stamp carries exactly one warning, for A's own Carlos; A's
 * card never appears on B's inbox. Proven red against a planted fault: the
 * feasibility read path (appointments in the window, their assignments, the
 * technician's calendar, the job and location lookups) without its tenant
 * predicates hands A's Oakland job to B's check, and B's card warns.
 */

const API_URL = process.env.E2E_NOAUTHBYPASS_API_URL ?? 'http://localhost:3002';
const TZ = 'America/Los_Angeles';
const SHOTS = 'docs/audit/lane-reports/1015-1018-rows-rung5';
const SF = { latitude: 37.7749, longitude: -122.4194 };
const OAK = { latitude: 37.8044, longitude: -122.2712 };

function tomorrow(): string {
  const d = new Date(`${todayInTz(TZ)}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

interface Shop {
  owner: RealOwner;
  carlos: RealTechnician;
  customerId: string;
}

async function seedShop(api: APIRequestContext, pool: Pool, label: string, withOaklandJob: boolean): Promise<Shop> {
  const owner = await bootstrapOwner(api, API_URL, pool, `drive-${label}`, TZ);
  const carlos = await inviteTechnician(api, API_URL, owner, `carlos-drive-${label}`);
  const customer = await postJson(api, `${API_URL}/api/customers`, owner.headers, {
    firstName: 'Dana',
    lastName: 'Caller',
    primaryPhone: label === 'a' ? '415-555-0161' : '415-555-0162',
  });
  await postJson(api, `${API_URL}/api/locations`, owner.headers, {
    customerId: customer.id,
    street1: '1 Market St',
    city: 'San Francisco',
    state: 'CA',
    postalCode: '94103',
    isPrimary: true,
    ...SF,
  });
  if (withOaklandJob) {
    const oakland = await postJson(api, `${API_URL}/api/locations`, owner.headers, {
      customerId: customer.id,
      street1: '1 Broadway',
      city: 'Oakland',
      state: 'CA',
      postalCode: '94607',
      isPrimary: false,
      ...OAK,
    });
    await postJson(api, `${API_URL}/api/jobs`, owner.headers, {
      customerId: customer.id,
      locationId: oakland.id,
      summary: 'Oakland furnace tune-up',
      priority: 'normal',
      scheduledStart: tenantWallClockToUtc(tomorrow(), '09:00', TZ).toISOString(),
      durationMin: 55,
      timezone: TZ,
      technicianId: carlos.techId,
    });
  }
  return { owner, carlos, customerId: customer.id };
}

/** The production handler, wired as the handler registry wires it. */
async function draftBooking(pool: Pool, shop: Shop): Promise<string> {
  const appointmentRepo = new PgAppointmentRepository(pool);
  const jobRepo = new PgJobRepository(pool);
  const locationRepo = new PgLocationRepository(pool);
  const draftingModel = {
    complete: async () => ({
      content: JSON.stringify({ dateTimePhrase: 'tomorrow at 10am', summary: 'Leak check', confidence_score: 0.9 }),
    }),
  } as unknown as LLMGateway;
  const handler = new CreateAppointmentAITaskHandler(
    draftingModel,
    undefined,
    undefined,
    appointmentRepo,
    jobRepo,
    { locationRepo },
    {
      assignmentRepo: new PgAssignmentRepository(pool),
      appointmentRepo,
      jobRepo,
      locationRepo,
      workingHoursRepo: new PgWorkingHoursRepository(pool),
      unavailableBlockRepo: new PgUnavailableBlockRepository(pool),
      travelTimeProvider: createTravelTimeProvider({}),
      skillMatcher: new StubSkillMatcher(),
    },
  );
  const result = await handler.handle({
    tenantId: shop.owner.tenantId,
    userId: shop.owner.sub,
    customerId: shop.customerId,
    message: 'Can someone come out tomorrow at 10am to check a leak?',
    timezone: TZ,
    // A fresh hermetic tenant has nobody in supervisor mode — the same
    // presence signal the gateway threads — so the draft waits for review
    // instead of auto-approving.
    supervisorPresent: false,
  } as TaskContext);
  expect(result.taskType).toBe('create_appointment');
  expect(result.proposal.status).toBe('ready_for_review');
  await new PgProposalRepository(pool).create(result.proposal);
  return result.proposal.id;
}

test.describe('3.12 — the owner sees the drive-time warning on the booking card (real Postgres)', () => {
  const canRun = !process.env.E2E_BASE_URL && hasViteClerkKey() && process.env.E2E_USE_TEST_DB === 'true' && !!process.env.DATABASE_URL;
  test.skip(!canRun, 'Needs the local webServer pairs against a real Postgres (E2E_USE_TEST_DB=true, DATABASE_URL).');

  let api: APIRequestContext;
  let pool: Pool;

  test.beforeAll(async () => {
    if (!canRun) return;
    api = await pwRequest.newContext({ timeout: 60_000 });
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
  });

  test.afterAll(async () => {
    await api?.dispose();
    await pool?.end();
  });

  test('a 10am booking 5 minutes after Carlos leaves Oakland carries an unverified drive-time warning on the real Inbox; approving books it; tenant B\'s identical slot in the same run is unaffected by A\'s Oakland job (T2)', async ({ page, browser, baseURL }) => {
    test.setTimeout(180_000);
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    const shopA = await seedShop(api, pool, 'a', true);
    const shopB = await seedShop(api, pool, 'b', false);
    const proposalA = await draftBooking(pool, shopA);
    const proposalB = await draftBooking(pool, shopB);
    const { rows: stamped } = await pool.query<{ source_context: Record<string, unknown> }>(
      `SELECT source_context FROM proposals WHERE id = $1`,
      [proposalA],
    );
    console.log(`[3.12] tenant A slotFeasibility: ${JSON.stringify(stamped[0]?.source_context?.slotFeasibility)}`);
    // T2 — each tenant's stamp is computed from its own calendar only.
    const stampA = stamped[0]?.source_context?.slotFeasibility as
      | { checked: boolean; warnings: Array<{ metadata?: { technicianId?: string } }> }
      | undefined;
    expect(stampA?.checked).toBe(true);
    expect(stampA?.warnings.map((w) => w.metadata?.technicianId)).toEqual([shopA.carlos.techId]);
    const { rows: stampedB } = await pool.query<{ source_context: Record<string, unknown> }>(
      `SELECT source_context FROM proposals WHERE id = $1`,
      [proposalB],
    );
    console.log(`[3.12] tenant B slotFeasibility: ${JSON.stringify(stampedB[0]?.source_context?.slotFeasibility)}`);
    expect(stampedB[0]?.source_context?.slotFeasibility, 'A\'s Oakland job must not change B\'s answer').toEqual({
      checked: true,
      warnings: [],
    });

    // ── Owner A's real Inbox. ──────────────────────────────────────────────
    await signInBrowser(page, baseURL!, shopA.owner.sub, shopA.owner.token);
    await page.goto('/inbox');
    const card = page.getByTestId('inbox-row');
    await expect(card).toHaveCount(1, { timeout: 20_000 });
    const warning = card.getByTestId('proposal-feasibility-warning');
    await expect(warning).toBeVisible();
    await expect(warning).toContainText(/min drive, only 5 min between jobs/);
    await expect(warning).toContainText(/unverified/i);
    await page.screenshot({ path: `${SHOTS}/3.12-inbox-drive-warning.png`, fullPage: true });

    const approved = page.waitForResponse(
      (r) => r.request().method() === 'POST' && new URL(r.url()).pathname === `/api/proposals/${proposalA}/approve`,
    );
    await card.getByRole('button', { name: /^approve$/i }).click();
    expect((await approved).status()).toBeLessThan(300);
    await expect
      .poll(
        async () =>
          (
            await pool.query(
              `SELECT a.id FROM appointments a JOIN jobs j ON j.id = a.job_id
                WHERE a.tenant_id = $1 AND j.customer_id = $2 AND a.scheduled_start = $3`,
              [shopA.owner.tenantId, shopA.customerId, tenantWallClockToUtc(tomorrow(), '10:00', TZ)],
            )
          ).rows.length,
        { timeout: 30_000, message: 'the approved booking never became an appointment' },
      )
      .toBe(1);

    // ── T2: tenant B's 10am draft carries no warning; A's card is not there.
    const pageB = await (await browser.newContext()).newPage();
    await signInBrowser(pageB, baseURL!, shopB.owner.sub, shopB.owner.token);
    await pageB.goto('/inbox');
    const cardB = pageB.getByTestId('inbox-row');
    await expect(cardB).toHaveCount(1, { timeout: 20_000 });
    await expect(cardB.getByTestId('proposal-feasibility-warning')).toHaveCount(0);
    await pageB.screenshot({ path: 'docs/audit/lane-reports/t2-legs-rung5/3.12-neighbour-inbox-no-warning.png', fullPage: true });
    const { rows: bStatus } = await pool.query<{ status: string }>(`SELECT status FROM proposals WHERE id = $1`, [proposalB]);
    expect(bStatus[0].status).toBe('ready_for_review');

    expect(pageErrors, 'no uncaught page errors').toEqual([]);
  });
});

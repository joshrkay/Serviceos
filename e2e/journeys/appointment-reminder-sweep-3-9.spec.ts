import { test, expect, APIRequestContext } from '@playwright/test';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import { installClerkStub } from '../helpers/clerk-stub';
import { blockExternalHosts } from '../helpers/api-mocks/shell';
import { hasViteClerkKey } from '../helpers/clerk-key';
import {
  runAppointmentReminderSweep,
  ownerReminderDispatchKey,
  APPOINTMENT_REMINDER_LEAD_MS,
} from '../../packages/api/src/workers/appointment-reminder-worker';
import { PgAppointmentRepository } from '../../packages/api/src/appointments/pg-appointment';
import { PgJobRepository } from '../../packages/api/src/jobs/pg-job';
import { PgCustomerRepository } from '../../packages/api/src/customers/pg-customer';
import { PgSettingsRepository } from '../../packages/api/src/settings/pg-settings';
import { PgDispatchRepository } from '../../packages/api/src/notifications/dispatch-repository';
import { PgDeviceTokenRepository } from '../../packages/api/src/push/pg-device-token-repository';
import { PgDncRepository } from '../../packages/api/src/compliance/dnc';
import { PgInvoiceRepository } from '../../packages/api/src/invoices/pg-invoice';
import { TransactionalCommsService } from '../../packages/api/src/notifications/transactional-comms-service';
import { InMemoryDeliveryProvider } from '../../packages/api/src/notifications/delivery-provider';
import { OwnerNotificationService } from '../../packages/api/src/notifications/owner-notification-service';
import { InMemoryPushDeliveryProvider } from '../../packages/api/src/notifications/push-delivery-provider';
import { setOwnerNotifications } from '../../packages/api/src/notifications/owner-notifications-instance';
import { listAllTenantIds } from '../../packages/api/src/tenants/list-tenant-ids';
import { createLogger } from '../../packages/api/src/logging/logger';

/**
 * §8.3 row 3.9 — rung-5 reachability: "customers reminded the day before, so
 * I stop eating no-shows." Keeps the T1/T3/T4 angles already proven at
 * packages/api/test/integration/appointment-reminder-owner-push
 * .integration.test.ts (#1015).
 *
 * That integration test builds every fixture (tenant, customer, job,
 * appointment, device token) directly through Pg repositories, never through
 * a real owner session. This file: a REAL owner signs in (Clerk webhook +
 * onboarding identity), books a REAL job+appointment through the
 * authenticated API (the same way a solo operator would), registers a REAL
 * push device via `POST /api/devices`, and sees the appointment on the real
 * `/dispatch` board — then `runAppointmentReminderSweep` (the SAME function
 * app.ts's hourly `setInterval` invokes) is called directly against the
 * real Postgres the API webServer is also pointed at (a worker tick, not an
 * admin route — waiting out the real cadence in CI is not viable, same
 * reasoning as e2e/journeys/digest-toggle.spec.ts's sweep reachability
 * block). The appointment is booked at a FIXED far-future, mid-day-UTC
 * instant (clock-safe — never spans a local-day boundary in any of the
 * three tenant timezones below, unlike a wall-clock-relative "due in 24h"
 * which could straddle midnight depending on what time this spec happens to
 * run) and the sweep's clock is INJECTED at exactly
 * `APPOINTMENT_REMINDER_LEAD_MS` before that instant — deterministic
 * regardless of real run time, same technique as this suite's hold-reaper
 * and proposal-expiry sweep specs.
 *
 * T1/T2 — a second tenant's reminder never crosses into the first's.
 * T3 — two tenants in DIFFERENT, owner-configured timezones (Chicago /
 * Phoenix), both due at the SAME instant, each gets exactly its own
 * reminder (the tenant timezone `notifyOwnerAppointmentReminder` and
 * `TransactionalCommsService` read is a genuine per-tenant SETTING, not
 * hardcoded).
 * T4 — the REAL tenant enumerator (`listAllTenantIds`) sweeps a THIRD
 * tenant with nothing due in the same pass; it is reached and skipped
 * without disturbing the other two tenants' reminders.
 */

const API_URL = process.env.E2E_API_URL ?? 'http://localhost:3000';

const CLERK_WEBHOOK_SECRET =
  process.env.E2E_CLERK_WEBHOOK_SECRET ??
  'whsec_dGVzdC1zaWdudXAtY3JpdGljYWwtcGF0aA==';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SCREENSHOT_DIR = join(process.cwd(), 'docs/audit/lane-reports/8-3-book-inapp-r5');
mkdirSync(SCREENSHOT_DIR, { recursive: true });

const WELCOME_SEEN_KEY = 'walkthrough.welcome.v1';
const WHATS_NEW_SEEN_KEY = 'walkthrough.whatsnew.lastSeen';

function b64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

function unsignedJwt(sub: string): string {
  return `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url({
    sub,
    sid: 'dev-session',
    role: 'owner',
  })}.x`;
}

function signSvix(rawBody: string, svixId: string, svixTimestamp: string): string {
  const secret = Buffer.from(CLERK_WEBHOOK_SECRET.replace(/^whsec_/, ''), 'base64');
  const sig = createHmac('sha256', secret)
    .update(`${svixId}.${svixTimestamp}.${rawBody}`)
    .digest('base64');
  return `v1,${sig}`;
}

interface Tenant {
  tenantId: string;
  sub: string;
  jwt: string;
  authHeaders: { Authorization: string };
}

async function bootstrapOwner(request: APIRequestContext, label: string, timezone: string): Promise<Tenant> {
  const sub = `user_e2e_remind_${label}_${randomUUID().replace(/-/g, '')}`;
  const email = `owner-${label}-${Date.now()}@serviceos-hermetic.test`;
  const jwt = unsignedJwt(sub);
  const authHeaders = { Authorization: `Bearer ${jwt}` };

  const svixId = `evt_${randomUUID()}`;
  const svixTimestamp = String(Math.floor(Date.now() / 1000));
  const rawBody = JSON.stringify({
    type: 'user.created',
    data: { id: sub, email_addresses: [{ email_address: email }] },
  });
  const webhookRes = await request.post(`${API_URL}/webhooks/clerk`, {
    headers: {
      'content-type': 'application/json',
      'svix-id': svixId,
      'svix-timestamp': svixTimestamp,
      'svix-signature': signSvix(rawBody, svixId, svixTimestamp),
    },
    data: rawBody,
  });
  expect(webhookRes.status(), `${label} bootstrap webhook -> ${await webhookRes.text()}`).toBe(200);

  const meRes = await request.get(`${API_URL}/api/me`, { headers: authHeaders });
  expect(meRes.status()).toBe(200);
  const me = (await meRes.json()) as { tenant_id?: string };
  expect(me.tenant_id).toMatch(UUID_RE);
  const tenantId = me.tenant_id!;

  const identityRes = await request.put(`${API_URL}/api/onboarding/identity`, {
    headers: { 'content-type': 'application/json', ...authHeaders },
    data: JSON.stringify({
      businessName: `Reminder Sweep E2E ${label.toUpperCase()}`,
      businessHours: { mon: { open: '00:00', close: '23:59' }, tue: { open: '00:00', close: '23:59' }, wed: { open: '00:00', close: '23:59' }, thu: { open: '00:00', close: '23:59' }, fri: { open: '00:00', close: '23:59' }, sat: { open: '00:00', close: '23:59' }, sun: { open: '00:00', close: '23:59' } },
      jobBufferMinutes: 15,
      hourlyRateCents: 12500,
      timezone,
    }),
  });
  expect(identityRes.ok(), `PUT /api/onboarding/identity (${label}) -> ${identityRes.status()}`).toBeTruthy();

  return { tenantId, sub, jwt, authHeaders };
}

interface CreatedEntity {
  id: string;
  [k: string]: unknown;
}

async function postJson(
  request: APIRequestContext,
  url: string,
  authHeaders: Record<string, string>,
  body: unknown,
): Promise<CreatedEntity> {
  const res = await request.post(url, {
    headers: { 'content-type': 'application/json', ...authHeaders },
    data: JSON.stringify(body),
  });
  expect(res.ok(), `POST ${url} -> ${res.status()}: ${await res.text()}`).toBeTruthy();
  return (await res.json()) as CreatedEntity;
}

/** Real customer + location + job+appointment at a FIXED far-future instant
 *  (clock-safe — never depends on wall-clock time of day), through the
 *  authenticated API — no SQL. */
async function seedDueAppointment(
  request: APIRequestContext,
  tenant: Tenant,
  label: string,
  phone: string,
  scheduledStart: string,
): Promise<{ appointmentId: string; jobId: string; scheduledStart: string }> {
  const stamp = `${Date.now()}-${randomUUID().slice(0, 6)}`;
  const customer = await postJson(request, `${API_URL}/api/customers`, tenant.authHeaders, {
    firstName: label,
    lastName: `Reminder Customer ${stamp}`,
    primaryPhone: phone,
    preferredChannel: 'sms',
    smsConsent: true,
  });
  const location = await postJson(request, `${API_URL}/api/locations`, tenant.authHeaders, {
    customerId: customer.id,
    street1: `${label} Reminder Ave`,
    city: 'Austin',
    state: 'TX',
    postalCode: '78701',
    isPrimary: true,
  });
  const job = await postJson(request, `${API_URL}/api/jobs`, tenant.authHeaders, {
    customerId: customer.id,
    locationId: location.id,
    summary: `${label} reminder sweep job`,
    priority: 'normal',
    scheduledStart,
    durationMin: 60,
    timezone: 'Etc/UTC',
  });
  // #1133 workaround — poll until the appointment is durably queryable.
  let appointmentId = '';
  for (let i = 0; i < 10 && !appointmentId; i++) {
    const apptRes = await request.get(`${API_URL}/api/appointments?jobId=${job.id}`, { headers: tenant.authHeaders });
    const list = (await apptRes.json()) as Array<{ id: string }>;
    if (list.length > 0) appointmentId = list[0].id;
    else await new Promise((r) => setTimeout(r, 200));
  }
  expect(appointmentId, `job ${job.id} must have a linked appointment`).toMatch(UUID_RE);
  return { appointmentId, jobId: job.id, scheduledStart };
}

test.describe('appointment-reminder sweep (3.9) — real Postgres', () => {
  const canRun =
    // A LOCALHOST E2E_BASE_URL means a self-managed, dedicated-port
    // webServer pair (this lane's own workaround for sibling lanes
    // squatting the default port 5173 on a shared Mac) — not a remote
    // deployed environment, so it does not disqualify a run.
    (!process.env.E2E_BASE_URL || /^https?:\/\/(127\.0\.0\.1|localhost)/.test(process.env.E2E_BASE_URL)) &&
    hasViteClerkKey() &&
    process.env.E2E_USE_TEST_DB === 'true' &&
    !!process.env.DATABASE_URL;
  test.skip(
    !canRun,
    'Requires the local webServer pair against a real Postgres: leave E2E_BASE_URL unset, ' +
      'set VITE_CLERK_PUBLISHABLE_KEY (placeholder ok), E2E_USE_TEST_DB=true, and DATABASE_URL ' +
      'pointing at the test container (also used directly here to run the reminder sweep).',
  );

  test('a real owner books a job, registers a push device, and the reminder sweep fires the customer SMS + owner push exactly once; T3 timezone divergence; T4 fan-out reaches an unaffected third tenant', async ({
    page,
    baseURL,
  }) => {
    test.setTimeout(120_000);
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    const tenantChicago = await bootstrapOwner(page.request, 'chi', 'America/Chicago');
    const tenantPhoenix = await bootstrapOwner(page.request, 'phx', 'America/Phoenix');
    const tenantQuiet = await bootstrapOwner(page.request, 'quiet', 'Etc/UTC'); // T4: nothing due

    // ── Owner registers a REAL push device (owner-push half, U4). ──────────
    const deviceRes = await page.request.post(`${API_URL}/api/devices`, {
      headers: { 'content-type': 'application/json', ...tenantChicago.authHeaders },
      data: JSON.stringify({
        expoPushToken: `ExponentPushToken[e2e-${tenantChicago.tenantId.slice(0, 8)}]`,
        platform: 'ios',
      }),
    });
    expect(deviceRes.ok(), `POST /api/devices -> ${deviceRes.status()}`).toBeTruthy();

    // ── Real appointments at a FIXED far-future instant (clock-safe — a
    //    mid-day UTC hour so a 60-min appointment never spans a local-day
    //    boundary in ANY of the three tenant timezones below), and an
    //    INJECTED sweep clock exactly LEAD_MS before it (deterministic —
    //    never depends on wall-clock time at run time). ─────────────────────
    const DUE_AT = '2099-06-15T18:00:00.000Z'; // mid-day UTC, mid-day in Chicago/Phoenix too
    const QUIET_DUE_AT = '2099-06-25T18:00:00.000Z'; // 10 days later — nothing due yet
    const sweepNow = new Date(new Date(DUE_AT).getTime() - APPOINTMENT_REMINDER_LEAD_MS);

    const chiPhone = '+15125550190';
    const chi = await seedDueAppointment(page.request, tenantChicago, 'Chicago', chiPhone, DUE_AT);
    // T3 — Phoenix tenant, due at the SAME instant, DIFFERENT owner-configured tz.
    const phxPhone = '+15125550191';
    const phx = await seedDueAppointment(page.request, tenantPhoenix, 'Phoenix', phxPhone, DUE_AT);
    // T4 — quiet tenant, nothing due for another 10 days.
    const quietPhone = '+15125550192';
    await seedDueAppointment(page.request, tenantQuiet, 'Quiet', quietPhone, QUIET_DUE_AT);

    // ── Real owner browser: the booked appointment is visible on /dispatch
    //    BEFORE the reminder fires. ─────────────────────────────────────────
    await installClerkStub(page, { signedIn: true, sub: tenantChicago.sub, token: tenantChicago.jwt });
    await page.addInitScript(
      ({ welcomeKey, whatsNewKey }) => {
        try {
          localStorage.setItem(welcomeKey, '1');
          localStorage.setItem(whatsNewKey, '2026-06-21-onboarding');
        } catch {
          /* private mode — ignore */
        }
      },
      { welcomeKey: WELCOME_SEEN_KEY, whatsNewKey: WHATS_NEW_SEEN_KEY },
    );
    await blockExternalHosts(page, baseURL!);
    const chiDay = chi.scheduledStart.slice(0, 10);
    await page.goto('/dispatch');
    await expect(page.getByTestId('dispatch-board')).toBeVisible({ timeout: 15_000 });
    await page.getByTestId('date-nav-picker').fill(chiDay);
    await expect(page.locator(`[data-appointment-id="${chi.appointmentId}"]`)).toBeVisible({ timeout: 15_000 });
    await page.screenshot({ path: join(SCREENSHOT_DIR, '3.9-dispatch-board-before-reminder.png'), fullPage: true });

    // ── The production sweep, called directly against real Postgres (a
    //    worker tick, not an admin route), with the REAL tenant enumerator
    //    (T4) so a third, unrelated tenant is genuinely swept in the SAME
    //    pass. ─────────────────────────────────────────────────────────────
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const delivery = new InMemoryDeliveryProvider();
    try {
      const appointmentRepo = new PgAppointmentRepository(pool);
      const jobRepo = new PgJobRepository(pool);
      const customerRepo = new PgCustomerRepository(pool);
      const settingsRepo = new PgSettingsRepository(pool);
      const dispatchRepo = new PgDispatchRepository(pool);
      const deviceTokenRepo = new PgDeviceTokenRepository(pool);
      const transactionalComms = new TransactionalCommsService({
        delivery,
        dispatchRepo,
        dncRepo: new PgDncRepository(pool),
        appointmentRepo,
        jobRepo,
        customerRepo,
        settingsRepo,
        invoiceRepo: new PgInvoiceRepository(pool),
        pool,
        logger: createLogger({ service: 'e2e-reminder', environment: 'test', level: 'error' }),
      });
      const pushProvider = new InMemoryPushDeliveryProvider();
      setOwnerNotifications(new OwnerNotificationService({ deviceTokenRepo, provider: pushProvider }));

      const realTenantIds = await listAllTenantIds(pool);
      expect(realTenantIds).toEqual(
        expect.arrayContaining([tenantChicago.tenantId, tenantPhoenix.tenantId, tenantQuiet.tenantId]),
      );

      const sweepDeps = {
        appointmentRepo,
        transactionalComms,
        jobRepo,
        customerRepo,
        settingsRepo,
        dispatchRepo,
        listTenantIds: () => listAllTenantIds(pool),
        logger: createLogger({ service: 'e2e-reminder-sweep', environment: 'test', level: 'error' }),
        now: () => sweepNow,
      };
      const sweepResult = await runAppointmentReminderSweep(sweepDeps);
      expect(sweepResult.tenants, 'the sweep must have reached at least our 3 tenants').toBeGreaterThanOrEqual(3);
      expect(sweepResult.reminders, `sweep result -> ${JSON.stringify(sweepResult)}`).toBeGreaterThanOrEqual(2);

      // ── Owner push fired for Chicago's real appointment id, durable via
      //    the dispatch idempotency key. ─────────────────────────────────
      expect(pushProvider.sent.some((m) => m.data?.entityId === chi.appointmentId)).toBe(true);
      const ownerPushRows = await dispatchRepo.findByEntity(tenantChicago.tenantId, 'appointment_reminder', chi.appointmentId);
      expect(ownerPushRows.some((r) => r.idempotencyKey === ownerReminderDispatchKey(chi.appointmentId))).toBe(true);

      // ── Customer SMS reminder — Chicago and Phoenix each reminded, each
      //    under its OWN tenant scope (T3). ───────────────────────────────
      const chiSms = delivery.sentSms.find((m) => m.to === chiPhone);
      const phxSms = delivery.sentSms.find((m) => m.to === phxPhone);
      expect(chiSms, 'Chicago tenant\'s customer must have been reminded').toBeDefined();
      expect(phxSms, 'Phoenix tenant\'s customer must have been reminded at the SAME instant, its own tz').toBeDefined();
      expect(chiSms?.tenantId).toBe(tenantChicago.tenantId);
      expect(phxSms?.tenantId).toBe(tenantPhoenix.tenantId);

      // ── T1/T2 — cross-tenant leak check on the dispatch rows. ───────────
      expect(await dispatchRepo.findByEntity(tenantPhoenix.tenantId, 'appointment_reminder', chi.appointmentId)).toEqual([]);
      expect(await dispatchRepo.findByEntity(tenantChicago.tenantId, 'appointment_reminder', phx.appointmentId)).toEqual([]);

      // ── T4 — the quiet tenant was reached (real enumerator) and left
      //    with ZERO reminder rows; its presence never broke the sweep for
      //    the other two. ───────────────────────────────────────────────
      const quietSms = delivery.sentSms.find((m) => m.to === quietPhone);
      expect(quietSms, 'the quiet tenant\'s appointment is 10 days out — no reminder yet').toBeUndefined();
      expect(sweepResult.failed, 'no tenant may fail the sweep').toBe(0);

      // ── Idempotency — a second sweep call does not double-push. ────────
      const beforeSecondSweep = delivery.sentSms.length;
      await runAppointmentReminderSweep(sweepDeps);
      expect(delivery.sentSms.length, 'a second sweep must not double-send').toBe(beforeSecondSweep);
      expect(pushProvider.sent.filter((m) => m.data?.entityId === chi.appointmentId)).toHaveLength(1);
    } finally {
      setOwnerNotifications(undefined);
      await pool.end().catch(() => undefined);
    }

    expect(pageErrors, 'no uncaught page errors while viewing the dispatch board').toEqual([]);
  });
});

/**
 * #1017 §8.4 row 4.5, SMS-keyword leg — "Given any of the four entry
 * points, when fired, then one audited act with a TECH actor plus a
 * customer ETA dispatch row."
 *
 * packages/api/test/integration/en-route-voice.test.ts already proves the
 * voice/phone/chat legs at real Postgres; packages/api/test/integration
 * /en-route-sms-keyword.test.ts proves the SMS-keyword leg's handler
 * (`registerEnRouteSmsKeyword`) writes the SAME `appointment.
 * en_route_triggered` audit event + `delay_notice_state` row the app
 * button/voice/chat legs produce — but only by calling `dispatchInboundSms`
 * directly inside the vitest process, never through the actual signed HTTP
 * webhook. This spec reaches the SAME assertions through the real
 * `/webhooks/twilio/sms/:tenantId` route (packages/api/src/webhooks
 * /routes.ts:2845) at a real Postgres, driven from a self-signed
 * Twilio-shaped Playwright request — the phone/SMS surface itself, not just
 * the handler behind it.
 *
 * Setup mirrors e2e/telephony-tech-out-4-8.spec.ts (row 4.8, same lane):
 * tenant/owner/settings/integration via the shared `provisionTenant`
 * (SQL — matches the merged §8.3 phone lane's own precedent), the
 * technician user via a direct insert (Clerk-driven in prod; see
 * e2e/fixtures/twilio-sms-lane.ts), and customers/locations/the scheduled
 * job+appointment+assignment through the real, authenticated HTTP API
 * (`POST /api/jobs` with `scheduledStart` + `technicianId` — the only place
 * in this codebase that wires a technician to an appointment).
 *
 * No brand-voice content is asserted here (unlike row 4.8's reschedule SMS
 * draft): the en-route customer ETA text is composed later by
 * `delayNotificationWorker` off the QUEUED `delay_notice_state` row, not at
 * enqueue time, so this leg has no hermetic-mock content gap to pin.
 */
import { test, expect } from '@playwright/test';
import { Pool } from 'pg';
import crypto from 'node:crypto';
import {
  provisionTenant,
  signedSmsPost,
  devAuthBearerToken,
  insertTechnician,
  createCustomerViaApi,
  createLocationViaApi,
  createScheduledJobViaApi,
  getAppointmentIdForJob,
  laterTodaySlots,
  type ProvisionedTenant,
} from './fixtures/twilio-sms-lane';

const RUN = crypto.randomInt(1000, 9999);
const A_DID = `+1512${RUN}451`;
const B_DID = `+1512${RUN}452`;
const A_SUBACCOUNT = 'AC1017cccccccccccccccccccccccccccc';
const B_SUBACCOUNT = 'AC1017dddddddddddddddddddddddddddd';
const A_TOKEN = 'tenant-a-twilio-auth-token-1017-row45';
const B_TOKEN = 'tenant-b-twilio-auth-token-1017-row45';

const A_BUSINESS_NAME = `Terry's Field Services ${RUN}`;
const B_BUSINESS_NAME = `Neighbour Field Co ${RUN}`;

// Tenant A carries TWO technicians so the "omw" and "on my way" synonyms
// each get their OWN unambiguous appointment (resolveEnRouteAppointment
// picks the assignee's appointment nearest to "now" — a single tech with
// two live appointments would make which one "wins" a race with the clock).
const TERRY_MOBILE = `+1555${RUN}451`;
const ROBIN_MOBILE = `+1555${RUN}452`;
const B_TECH_MOBILE = `+1555${RUN}453`;
const UNREGISTERED_MOBILE = `+1555${RUN}959`;

const enc = process.env.TENANT_ENCRYPTION_KEY;
const dbReady = !!process.env.DATABASE_URL;

let pool: Pool;
let tenantA: ProvisionedTenant;
let tenantB: ProvisionedTenant;
let terryId: string;
let robinId: string;
let techBId: string;
let ownerTokenA: string;
let ownerTokenB: string;
let apptTerry: string;
let apptRobin: string;
let apptB: string;

test.describe.configure({ mode: 'serial' });

test.describe('#1017 row 4.5 (SMS-keyword leg) — "on my way" reaches an audited TECH act + customer ETA dispatch row through the real inbound-SMS webhook', () => {
  test.skip(
    !dbReady || !enc,
    'Needs a real Postgres (DATABASE_URL, migrated) and TENANT_ENCRYPTION_KEY — see the lane report for the invocation.',
  );

  test.beforeAll(async ({ request }) => {
    if (!dbReady || !enc) return;
    pool = new Pool({ connectionString: process.env.DATABASE_URL });

    tenantA = await provisionTenant(pool, enc, {
      did: A_DID,
      subaccountSid: A_SUBACCOUNT,
      authToken: A_TOKEN,
      businessName: A_BUSINESS_NAME,
    });
    tenantB = await provisionTenant(pool, enc, {
      did: B_DID,
      subaccountSid: B_SUBACCOUNT,
      authToken: B_TOKEN,
      businessName: B_BUSINESS_NAME,
    });

    ownerTokenA = devAuthBearerToken(tenantA.userId);
    ownerTokenB = devAuthBearerToken(tenantB.userId);

    const terry = await insertTechnician(pool, tenantA.tenantId, {
      mobile: TERRY_MOBILE,
      firstName: 'Terry',
      lastName: 'Field',
    });
    terryId = terry.id;
    const robin = await insertTechnician(pool, tenantA.tenantId, {
      mobile: ROBIN_MOBILE,
      firstName: 'Robin',
      lastName: 'Ortiz',
    });
    robinId = robin.id;
    const techB = await insertTechnician(pool, tenantB.tenantId, {
      mobile: B_TECH_MOBILE,
      firstName: 'Blair',
      lastName: 'Nguyen',
    });
    techBId = techB.id;

    // Terry: one appointment ~1h from now, for the bare "OMW" keyword.
    const custTerry = await createCustomerViaApi(request, ownerTokenA, {
      firstName: 'Jamie',
      lastName: 'Rivera',
      primaryPhone: '+15125557001',
    });
    const locTerry = await createLocationViaApi(request, ownerTokenA, custTerry.id);
    const jobTerry = await createScheduledJobViaApi(request, ownerTokenA, {
      customerId: custTerry.id,
      locationId: locTerry.id,
      summary: 'Leaky faucet',
      technicianId: terryId,
      scheduledStart: laterTodaySlots('America/Chicago', 1, 60)[0]!,
      timezone: 'America/Chicago',
    });
    apptTerry = await getAppointmentIdForJob(request, ownerTokenA, jobTerry.id);

    // Robin: one appointment ~1h from now, for the "on my way" phrase form.
    const custRobin = await createCustomerViaApi(request, ownerTokenA, {
      firstName: 'Morgan',
      lastName: 'Lee',
      primaryPhone: '+15125557002',
    });
    const locRobin = await createLocationViaApi(request, ownerTokenA, custRobin.id);
    const jobRobin = await createScheduledJobViaApi(request, ownerTokenA, {
      customerId: custRobin.id,
      locationId: locRobin.id,
      summary: 'Water heater inspection',
      technicianId: robinId,
      scheduledStart: laterTodaySlots('America/Chicago', 1, 60)[0]!,
      timezone: 'America/Chicago',
    });
    apptRobin = await getAppointmentIdForJob(request, ownerTokenA, jobRobin.id);

    // Tenant B: its own technician + appointment.
    const custB = await createCustomerViaApi(request, ownerTokenB, {
      firstName: 'Robin',
      lastName: 'Nguyen',
      primaryPhone: '+15125559876',
    });
    const locB = await createLocationViaApi(request, ownerTokenB, custB.id);
    const jobB = await createScheduledJobViaApi(request, ownerTokenB, {
      customerId: custB.id,
      locationId: locB.id,
      summary: 'Water heater replacement',
      technicianId: techBId,
      scheduledStart: laterTodaySlots('America/Chicago', 1, 60)[0]!,
      timezone: 'America/Chicago',
    });
    apptB = await getAppointmentIdForJob(request, ownerTokenB, jobB.id);
  });

  test.afterAll(async () => {
    await pool?.end();
  });

  async function assertEnRouteFired(tenantId: string, appointmentId: string, technicianId: string) {
    const audit = await pool.query(
      `SELECT actor_id, actor_role FROM audit_events
        WHERE tenant_id = $1 AND event_type = 'appointment.en_route_triggered' AND entity_id = $2`,
      [tenantId, appointmentId],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].actor_id).toBe(technicianId);
    expect(audit.rows[0].actor_role).toBe('technician');

    const state = await pool.query(
      `SELECT idempotency_key, channel, status FROM delay_notice_state
        WHERE tenant_id = $1 AND appointment_id = $2`,
      [tenantId, appointmentId],
    );
    expect(state.rows).toHaveLength(1);
    expect(state.rows[0].idempotency_key).toBe(`${appointmentId}:en_route`);
    expect(state.rows[0].channel).toBe('sms');
    expect(state.rows[0].status).toBe('queued');
  }

  test('a registered tech texting the bare "OMW" keyword fires the audited en-route act + a customer ETA dispatch row', async ({
    request,
  }) => {
    const res = await signedSmsPost(request, tenantA, { From: TERRY_MOBILE, Body: 'OMW' });
    expect(res.status(), `raw response: ${await res.text()}`).toBe(200);

    await assertEnRouteFired(tenantA.tenantId, apptTerry, terryId);
  });

  test('the "on my way" phrase form fires the SAME audited act + dispatch row (a DIFFERENT tech/appointment, same tenant)', async ({
    request,
  }) => {
    const res = await signedSmsPost(request, tenantA, { From: ROBIN_MOBILE, Body: 'on my way' });
    expect(res.status(), `raw response: ${await res.text()}`).toBe(200);

    await assertEnRouteFired(tenantA.tenantId, apptRobin, robinId);
  });

  test('an OMW from an UNREGISTERED number does nothing — unverified_mobile audit, no en-route audit or dispatch row for anyone', async ({
    request,
  }) => {
    const res = await signedSmsPost(request, tenantA, { From: UNREGISTERED_MOBILE, Body: 'OMW' });
    expect(res.status(), `raw response: ${await res.text()}`).toBe(200);

    const unverified = await pool.query(
      `SELECT metadata FROM audit_events
        WHERE tenant_id = $1 AND event_type = 'tech_status.en_route.unverified_mobile' AND metadata->>'fromE164' = $2`,
      [tenantA.tenantId, UNREGISTERED_MOBILE],
    );
    expect(unverified.rows).toHaveLength(1);
    expect(unverified.rows[0].metadata.reason).toBe('unknown_mobile');

    // Still exactly the two en-route rows from the two tests above — no
    // third audit row or dispatch row was created for the unregistered number.
    const allEnRoute = await pool.query(
      `SELECT id FROM audit_events WHERE tenant_id = $1 AND event_type = 'appointment.en_route_triggered'`,
      [tenantA.tenantId],
    );
    expect(allEnRoute.rows).toHaveLength(2);
    const allDispatches = await pool.query(`SELECT idempotency_key FROM delay_notice_state WHERE tenant_id = $1`, [
      tenantA.tenantId,
    ]);
    expect(allDispatches.rows).toHaveLength(2);
  });

  test("T2: tenant B's own tech texting OMW fires its OWN audited act + dispatch row, and never touches tenant A's rows", async ({
    request,
  }) => {
    const beforeEnRouteA = (
      await pool.query(
        `SELECT id FROM audit_events WHERE tenant_id = $1 AND event_type = 'appointment.en_route_triggered'`,
        [tenantA.tenantId],
      )
    ).rows.length;
    const beforeDispatchA = (
      await pool.query(`SELECT idempotency_key FROM delay_notice_state WHERE tenant_id = $1`, [tenantA.tenantId])
    ).rows.length;

    const res = await signedSmsPost(request, tenantB, { From: B_TECH_MOBILE, Body: 'OMW' });
    expect(res.status(), `raw response: ${await res.text()}`).toBe(200);

    await assertEnRouteFired(tenantB.tenantId, apptB, techBId);

    const afterEnRouteA = (
      await pool.query(
        `SELECT id FROM audit_events WHERE tenant_id = $1 AND event_type = 'appointment.en_route_triggered'`,
        [tenantA.tenantId],
      )
    ).rows.length;
    const afterDispatchA = (
      await pool.query(`SELECT idempotency_key FROM delay_notice_state WHERE tenant_id = $1`, [tenantA.tenantId])
    ).rows.length;
    expect(afterEnRouteA).toBe(beforeEnRouteA);
    expect(afterDispatchA).toBe(beforeDispatchA);

    // Cross-tenant read: tenant A's id scope never sees tenant B's appointment.
    const crossRead = await pool.query(`SELECT id FROM audit_events WHERE tenant_id = $1 AND entity_id = $2`, [
      tenantA.tenantId,
      apptB,
    ]);
    expect(crossRead.rows).toHaveLength(0);
  });
});

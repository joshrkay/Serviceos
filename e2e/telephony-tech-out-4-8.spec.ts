/**
 * #1017 §8.4 row 4.8 — "Given a verified tech OUT, when processed, then an
 * unavailable block, a reschedule proposal per appointment each carrying a
 * brand-voiced message, and an audit row — idempotent same-day, and an OUT
 * from an unregistered number is not actioned."
 *
 * Phone/SMS-surface reachability, same shape as the merged §8.3 phone lane
 * (e2e/telephony-e1-signed-webhook.spec.ts, e2e/telephony-book-3-1-proposed
 * -booking.spec.ts): a self-signed Twilio-shaped webhook POST, driven
 * through the REAL `/webhooks/twilio/sms/:tenantId` route
 * (packages/api/src/webhooks/routes.ts:2845) at a real Postgres, with the
 * setup done through the real, authenticated HTTP API wherever a route
 * exists (owner dev-auth-bypass bearer token) — see
 * e2e/fixtures/twilio-sms-lane.ts for why the technician user itself is
 * still a direct SQL insert (Clerk-driven in prod; no create-user route
 * exists) and why the job+appointment+assignment is created via a single
 * `POST /api/jobs` call (the only place in this codebase that wires a
 * technician to an appointment).
 *
 * REACHABILITY FINDING (own test below documents it, marked `test.fail()`
 * per the lane's evidence rules — do not remove until the product gap is
 * fixed): the acceptance criterion's "each carrying a brand-voiced message"
 * (and the T2/T3 "B's OUT produces B's block/proposal with B's brand
 * voice") is NOT verifiable under this repo's hermetic (no
 * `AI_PROVIDER_API_KEY`) boot. `createRescheduleProposalsFromTechOut`
 * (packages/api/src/scheduling/reschedule/from-tech-out.ts) drafts the
 * customer SMS via `draftCustomerRescheduleMessage` →
 * `composeBrandVoiceMessage` (packages/api/src/ai/brand-voice/composer.ts),
 * which uses the LLM gateway's `response.content` VERBATIM as the message
 * text (only banned-phrase stripping + a char-cap trim are applied in
 * code). The hermetic mock provider
 * (packages/api/src/ai/providers/mock.ts `scriptHermeticResponse`) has no
 * branch for `taskType === 'brand_voice_v1'`
 * (`BRAND_VOICE_TASK_TYPE`, ai/prompt-registry.ts:133) — it falls through to
 * the generic catch-all `{"ok":true,"mock":true,"taskType":"brand_voice_v1",
 * "note":"hermetic-mock"}`, which never contains the tenant's business name
 * or any brand-voice tone. Verified EMPIRICALLY (not assumed from reading
 * source) with a standalone probe calling
 * `createHermeticMockLLMGateway()` + `composeBrandVoiceMessage()` directly
 * with a settings repo stub carrying a real `business_name` — the probe's
 * output is quoted verbatim in the lane report. Everything else the row
 * asks for (the unavailable block, exactly one proposal PER appointment,
 * the audit row, same-day idempotency, the unregistered-number refusal, and
 * full tenant isolation of data AND of a per-tenant config value) is proven
 * below the normal way, through the real webhook and real Postgres.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
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
  pickSafeSecondaryTimezone,
  API_URL,
  type ProvisionedTenant,
} from './fixtures/twilio-sms-lane';

// Tenant A always uses plain UTC (always in the curated `VALID_TIMEZONES`
// list `tenantLocalDate` — sms/tech-status/handler.ts — actually honors,
// and its "local time" IS the real UTC clock: safe from the US-zone
// clustering issue below, only close to ITS OWN midnight for a much
// narrower, unrelated window). Tenant B's zone is picked HERE, once, from
// whichever curated zone is currently farthest from ITS OWN midnight — see
// `pickSafeSecondaryTimezone`'s own comment for why a FIXED second zone
// (e.g. always America/Los_Angeles) is unsafe: every curated zone is a US
// (+Hawaii) zone, so there is a real multi-hour UTC window where the WHOLE
// list is simultaneously in the evening/night and no fixed choice works at
// every real run time.
const A_TIMEZONE = 'UTC';
const B_TIMEZONE = pickSafeSecondaryTimezone();

const RUN = crypto.randomInt(1000, 9999);
const A_DID = `+1512${RUN}481`;
const B_DID = `+1512${RUN}482`;
const A_SUBACCOUNT = 'AC1017aaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const B_SUBACCOUNT = 'AC1017bbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const A_TOKEN = 'tenant-a-twilio-auth-token-1017-row48';
const B_TOKEN = 'tenant-b-twilio-auth-token-1017-row48';

const A_BUSINESS_NAME = `Wrench Bros Plumbing ${RUN}`;
const B_BUSINESS_NAME = `Neighbour Plumbing Co ${RUN}`;

const A_CARLOS_MOBILE = `+1555${RUN}481`;
const B_TECH_MOBILE = `+1555${RUN}482`;
const UNREGISTERED_MOBILE = `+1555${RUN}999`;

const enc = process.env.TENANT_ENCRYPTION_KEY;
const dbReady = !!process.env.DATABASE_URL;

let pool: Pool;
let tenantA: ProvisionedTenant;
let tenantB: ProvisionedTenant;
let carlosId: string;
let techBId: string;
let ownerTokenA: string;
let ownerTokenB: string;
let apptA1: string;
let apptA2: string;
let apptB1: string;

test.describe.configure({ mode: 'serial' });

test.describe('#1017 row 4.8 — a verified tech OUT reaches unavailable-block + reschedule-proposal + audit through the real inbound-SMS webhook', () => {
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
    // T3 — tenant A and tenant B read DIFFERENT per-tenant config values
    // (provisionTenant's own default is 'America/Chicago' for every
    // tenant, so both are overridden here): the tenant-local "today"
    // window (tenantLocalDate, sms/tech-status/handler.ts) is computed
    // from tenant_settings.timezone, so this exercises the capability's
    // own per-tenant CONFIG read, not just per-tenant data.
    await pool.query(`UPDATE tenant_settings SET timezone = $1 WHERE tenant_id = $2`, [A_TIMEZONE, tenantA.tenantId]);
    await pool.query(`UPDATE tenant_settings SET timezone = $1 WHERE tenant_id = $2`, [B_TIMEZONE, tenantB.tenantId]);

    ownerTokenA = devAuthBearerToken(tenantA.userId);
    ownerTokenB = devAuthBearerToken(tenantB.userId);

    const carlos = await insertTechnician(pool, tenantA.tenantId, {
      mobile: A_CARLOS_MOBILE,
      firstName: 'Carlos',
      lastName: 'Mendes',
    });
    carlosId = carlos.id;
    const techB = await insertTechnician(pool, tenantB.tenantId, {
      mobile: B_TECH_MOBILE,
      firstName: 'Dana',
      lastName: 'Ortiz',
    });
    techBId = techB.id;

    // Tenant A: two customers, two locations, two appointments TODAY
    // assigned to Carlos — all through the real, authenticated API. Slots
    // computed in tenant A's OWN timezone (UTC), 2h apart (comfortably
    // more than the 60-min duration so the same technician's two
    // appointments never double-book).
    const [slotA1, slotA2] = laterTodaySlots(A_TIMEZONE, 2, 120);
    const custA1 = await createCustomerViaApi(request, ownerTokenA, {
      firstName: 'Jamie',
      lastName: 'Rivera',
      primaryPhone: '+15125557001',
    });
    const locA1 = await createLocationViaApi(request, ownerTokenA, custA1.id);
    const jobA1 = await createScheduledJobViaApi(request, ownerTokenA, {
      customerId: custA1.id,
      locationId: locA1.id,
      summary: 'Leaky faucet',
      technicianId: carlosId,
      scheduledStart: slotA1!,
      timezone: A_TIMEZONE,
    });
    apptA1 = await getAppointmentIdForJob(request, ownerTokenA, jobA1.id);

    const custA2 = await createCustomerViaApi(request, ownerTokenA, {
      firstName: 'Morgan',
      lastName: 'Lee',
      primaryPhone: '+15125557002',
    });
    const locA2 = await createLocationViaApi(request, ownerTokenA, custA2.id);
    const jobA2 = await createScheduledJobViaApi(request, ownerTokenA, {
      customerId: custA2.id,
      locationId: locA2.id,
      summary: 'Water heater inspection',
      technicianId: carlosId,
      scheduledStart: slotA2!,
      timezone: A_TIMEZONE,
    });
    apptA2 = await getAppointmentIdForJob(request, ownerTokenA, jobA2.id);

    // Tenant B: one customer/location/appointment for its own technician,
    // slot computed in tenant B's OWN (dynamically-picked-safe) timezone.
    const [slotB1] = laterTodaySlots(B_TIMEZONE, 1, 120);
    const custB1 = await createCustomerViaApi(request, ownerTokenB, {
      firstName: 'Robin',
      lastName: 'Nguyen',
      primaryPhone: '+15125559876',
    });
    const locB1 = await createLocationViaApi(request, ownerTokenB, custB1.id);
    const jobB1 = await createScheduledJobViaApi(request, ownerTokenB, {
      customerId: custB1.id,
      locationId: locB1.id,
      summary: 'Water heater replacement',
      technicianId: techBId,
      scheduledStart: slotB1!,
      timezone: B_TIMEZONE,
    });
    apptB1 = await getAppointmentIdForJob(request, ownerTokenB, jobB1.id);
  });

  test.afterAll(async () => {
    await pool?.end();
  });

  async function rescheduleProposals(request: APIRequestContext, ownerToken: string) {
    const res = await request.get(`${API_URL}/api/proposals?proposalType=reschedule_appointment&limit=100`, {
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(res.status(), `GET /api/proposals failed: ${await res.text()}`).toBe(200);
    return (await res.json()) as {
      data: Array<{ id: string; targetEntityId?: string; status: string; sourceContext?: Record<string, unknown> }>;
      total: number;
    };
  }

  test('a verified tech OUT reaches an unavailable block, one reschedule proposal per affected appointment, and a tech_status.recorded audit row', async ({
    request,
  }) => {
    const res = await signedSmsPost(request, tenantA, { From: A_CARLOS_MOBILE, Body: 'OUT' });
    // The SMS webhook responds JSON (not TwiML — that's the voice routes).
    expect(res.status(), `raw response: ${await res.text()}`).toBe(200);

    const blocks = await pool.query(
      `SELECT id, technician_id, start_time, end_time, reason FROM tech_unavailable_blocks
        WHERE tenant_id = $1 AND technician_id = $2`,
      [tenantA.tenantId, carlosId],
    );
    expect(blocks.rows).toHaveLength(1);
    expect(blocks.rows[0].reason).toBe('out');

    const { data } = await rescheduleProposals(request, ownerTokenA);
    expect(data).toHaveLength(2);
    const byAppt = new Map(data.map((p) => [p.targetEntityId, p]));
    expect(byAppt.has(apptA1), 'a proposal exists for appointment #1').toBe(true);
    expect(byAppt.has(apptA2), 'a proposal exists for appointment #2').toBe(true);
    for (const p of data) {
      expect(p.status).toBe('ready_for_review');
      expect(typeof p.sourceContext?.draftSms, `proposal ${p.id} carries a draftSms`).toBe('string');
      expect((p.sourceContext?.draftSms as string).length).toBeGreaterThan(0);
    }

    const audit = await pool.query(
      `SELECT metadata FROM audit_events WHERE tenant_id = $1 AND event_type = 'tech_status.recorded' AND actor_id = $2`,
      [tenantA.tenantId, carlosId],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].metadata.proposalCount).toBe(2);
    expect(audit.rows[0].metadata.status).toBe('out');
  });

  test(
    'KNOWN GAP — each reschedule SMS draft should carry the tenant\'s brand voice / business name (expected to fail under this repo\'s hermetic AI mock)',
    async ({ request }) => {
      test.fail(
        true,
        'packages/api/src/ai/providers/mock.ts scriptHermeticResponse has no branch for ' +
          "taskType 'brand_voice_v1' (BRAND_VOICE_TASK_TYPE, ai/prompt-registry.ts:133); " +
          'composeBrandVoiceMessage (ai/brand-voice/composer.ts) uses the gateway response ' +
          'VERBATIM as the SMS text (only banned-phrase stripping + a char-cap trim run in ' +
          'code), so under the hermetic no-AI_PROVIDER_API_KEY boot every brand-voice draft ' +
          'is the generic catch-all {"ok":true,"mock":true,"taskType":"brand_voice_v1",' +
          '"note":"hermetic-mock"} — never the tenant\'s business name or tone. Verified ' +
          'empirically (standalone probe of createHermeticMockLLMGateway + ' +
          'composeBrandVoiceMessage; output quoted in the lane report). Product code ' +
          '(mock.ts) is out of scope for this TEST-ONLY lane — filing is Fable\'s call.',
      );

      const { data } = await rescheduleProposals(request, ownerTokenA);
      for (const p of data) {
        expect(
          p.sourceContext?.draftSms,
          `proposal ${p.id}'s draftSms should mention tenant A's business name once brand voice is wired hermetically`,
        ).toContain(A_BUSINESS_NAME);
      }
    },
  );

  test('a second identical OUT the same tenant-local day is idempotent — duplicate audit, no new block or proposals', async ({
    request,
  }) => {
    const res = await signedSmsPost(request, tenantA, { From: A_CARLOS_MOBILE, Body: 'OUT' });
    expect(res.status()).toBe(200);

    const dup = await pool.query(
      `SELECT id FROM audit_events WHERE tenant_id = $1 AND event_type = 'tech_status.duplicate' AND actor_id = $2`,
      [tenantA.tenantId, carlosId],
    );
    expect(dup.rows).toHaveLength(1);

    const blocks = await pool.query(
      `SELECT id FROM tech_unavailable_blocks WHERE tenant_id = $1 AND technician_id = $2`,
      [tenantA.tenantId, carlosId],
    );
    expect(blocks.rows).toHaveLength(1);

    const { data } = await rescheduleProposals(request, ownerTokenA);
    expect(data).toHaveLength(2);
  });

  test('an OUT from an UNREGISTERED number is not actioned — unverified_mobile audit, nothing changes', async ({
    request,
  }) => {
    const beforeBlocks = (
      await pool.query(`SELECT id FROM tech_unavailable_blocks WHERE tenant_id = $1`, [tenantA.tenantId])
    ).rows.length;
    const { data: before } = await rescheduleProposals(request, ownerTokenA);

    const res = await signedSmsPost(request, tenantA, { From: UNREGISTERED_MOBILE, Body: 'OUT' });
    // Twilio contract: the webhook always 200s once the signature verifies —
    // "not actioned" means no state changed, never an HTTP error.
    expect(res.status(), `raw response: ${await res.text()}`).toBe(200);

    const unverified = await pool.query(
      `SELECT metadata FROM audit_events
        WHERE tenant_id = $1 AND event_type = 'tech_status.unverified_mobile' AND metadata->>'fromE164' = $2`,
      [tenantA.tenantId, UNREGISTERED_MOBILE],
    );
    expect(unverified.rows).toHaveLength(1);
    expect(unverified.rows[0].metadata.reason).toBe('unknown_mobile');

    const afterBlocks = (
      await pool.query(`SELECT id FROM tech_unavailable_blocks WHERE tenant_id = $1`, [tenantA.tenantId])
    ).rows.length;
    expect(afterBlocks).toBe(beforeBlocks);
    const { data: after } = await rescheduleProposals(request, ownerTokenA);
    expect(after).toHaveLength(before.length);
  });

  test("T2/T3: tenant B (different data AND a different per-tenant timezone) gets its own OUT block/proposal/audit, and tenant A's rows are unchanged", async ({
    request,
  }) => {
    const beforeBlocksA = (
      await pool.query(`SELECT id FROM tech_unavailable_blocks WHERE tenant_id = $1`, [tenantA.tenantId])
    ).rows.length;
    const { data: beforeProposalsA } = await rescheduleProposals(request, ownerTokenA);

    const res = await signedSmsPost(request, tenantB, { From: B_TECH_MOBILE, Body: 'OUT' });
    expect(res.status(), `raw response: ${await res.text()}`).toBe(200);

    const blocksB = await pool.query(
      `SELECT id FROM tech_unavailable_blocks WHERE tenant_id = $1 AND technician_id = $2`,
      [tenantB.tenantId, techBId],
    );
    expect(blocksB.rows).toHaveLength(1);

    const { data: proposalsB } = await rescheduleProposals(request, ownerTokenB);
    expect(proposalsB).toHaveLength(1);
    expect(proposalsB[0]!.targetEntityId).toBe(apptB1);

    const auditB = await pool.query(
      `SELECT id FROM audit_events WHERE tenant_id = $1 AND event_type = 'tech_status.recorded' AND actor_id = $2`,
      [tenantB.tenantId, techBId],
    );
    expect(auditB.rows).toHaveLength(1);

    // Tenant A completely unaffected by tenant B's OUT.
    const afterBlocksA = (
      await pool.query(`SELECT id FROM tech_unavailable_blocks WHERE tenant_id = $1`, [tenantA.tenantId])
    ).rows.length;
    expect(afterBlocksA).toBe(beforeBlocksA);
    const { data: afterProposalsA } = await rescheduleProposals(request, ownerTokenA);
    expect(afterProposalsA).toHaveLength(beforeProposalsA.length);

    // Cross-tenant read: tenant A's id scope never sees tenant B's technician.
    const crossRead = await pool.query(`SELECT id FROM audit_events WHERE tenant_id = $1 AND actor_id = $2`, [
      tenantA.tenantId,
      techBId,
    ]);
    expect(crossRead.rows).toHaveLength(0);
  });
});

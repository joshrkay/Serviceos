/**
 * Trial / provisioning proof pack (Agent E, R4) —
 * docs/plans/2026-09-09-inapp-50-cases-plan.md, "Trial / provisioning proof
 * pack" section.
 *
 * Hermetic, ordered proof that a brand-new tenant can go
 * signup → authenticated workspace → trial entitlement → provisioned phone
 * → an in-app voice booking approved into a real appointment, with NO
 * Clerk/Stripe/Twilio credentials — only signed webhooks (the same HMAC
 * mechanism those providers use) and the dev/test provisioning stub already
 * shipped for Twilio-less environments (workers/provision-twilio.ts).
 *
 * Reuses the proven patterns from its siblings rather than re-deriving them:
 *   - signed Clerk `user.created` / Stripe webhook driving the REAL
 *     `/webhooks/*` router against `getSharedTestDb()` — TEST-04
 *     (signup-to-paid-critical-path.test.ts) and clerk-owner-membership.test.ts.
 *   - Stripe subscription mirroring via a stubbed-fetch BillingService and a
 *     signed `customer.subscription.created` webhook — flow1-saas-billing-
 *     runthrough.test.ts.
 *   - InAppVoiceAdapter driven by a scripted LLM gateway, approve → backdate
 *     past the undo window → runExecutionSweep with the PRODUCTION execution
 *     registry — voice-inbound-appointment.test.ts and
 *     update-brand-voice-voice-execution.test.ts.
 *
 * Each step asserts a DB or HTTP fact; step (f) prints a compact evidence
 * block so docs/verification-runs/trial-provision-proof-pack-2026-09-09.md
 * can quote real, reproducible output.
 *
 * Run: cd packages/api && RLS_RUNTIME_ROLE=true npx vitest run \
 *   --config vitest.integration.config.ts \
 *   test/integration/trial-provisioning-first-value.test.ts
 */
import express from 'express';
import request from 'supertest';
import * as crypto from 'crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';

import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';

import { createWebhookRouter } from '../../src/webhooks/routes';
import { createWebhookSignature } from '../../src/webhooks/webhook-handler';
import { PgTenantRepository } from '../../src/auth/pg-tenant';
import { PgSettingsRepository } from '../../src/settings/pg-settings';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { PgPackActivationRepository } from '../../src/settings/pg-pack-activation';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgLocationRepository } from '../../src/locations/pg-location';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { PgAppointmentRepository } from '../../src/appointments/pg-appointment';
import { BillingService } from '../../src/billing/subscription';
import type { AppConfig } from '../../src/shared/config';

import { createOnboardingRouter } from '../../src/routes/onboarding';
import {
  createMeRouter,
  DEFAULT_TENANT_TIMEZONE,
  type UserModeService,
  type MeUserRecord,
  type MeTenantSettings,
} from '../../src/routes/me';
import type { TenantIntegrationStatus } from '../../src/integrations/status-machine';

import { createCustomerRouter } from '../../src/routes/customers';
import { createLocationRouter } from '../../src/routes/locations';
import { permissiveTenantOwnership } from '../../src/shared/tenant-ownership';

import { createVoiceSessionsRouter } from '../../src/routes/voice-sessions';
import { InAppVoiceAdapter } from '../../src/ai/agents/customer-calling/inapp-adapter';
import { VoiceSessionStore } from '../../src/ai/agents/customer-calling/voice-session-store';
import { InMemoryOnCallRepository } from '../../src/oncall/rotation';
import type { LLMGateway, LLMResponse } from '../../src/ai/gateway/gateway';

import { createProposalsRouter } from '../../src/routes/proposals';
import { InMemoryProposalRepository, missingFieldsFor } from '../../src/proposals/proposal';
import { InMemoryProposalExecutionRepository } from '../../src/proposals/proposal-execution';
import { UNDO_WINDOW_MS } from '../../src/proposals/lifecycle';
import { ProposalExecutor } from '../../src/proposals/execution/executor';
import { IdempotencyGuard } from '../../src/proposals/execution/idempotency';
import { createExecutionHandlerRegistry } from '../../src/proposals/execution/handlers';
import { runExecutionSweep } from '../../src/workers/execution-worker';

import {
  createProvisionTwilioWorker,
  type ProvisionTwilioPayload,
} from '../../src/workers/provision-twilio';
import { evaluateTrialCap, TRIAL_LIMITS } from '../../src/voice/trial-limits';
import { createLogger } from '../../src/logging/logger';
import type { QueueMessage } from '../../src/queues/queue';
import type { AuthenticatedRequest } from '../../src/auth/clerk';

const CLERK_SECRET = 'whsec_dHJpYWwtcHJvdmlzaW9uaW5nLXByb29mLXBhY2s='; // base64
const STRIPE_SECRET = 'whsec_test_trial_provisioning_proof_pack';
const STUB_DEV_PHONE_E164 = '+15005550006';
const TENANT_TIMEZONE = 'America/Phoenix';
const SPOKEN_CUSTOMER_FIRST = 'Priya';
const SPOKEN_CUSTOMER_LAST = 'Natarajan';
const SPOKEN_CUSTOMER = `${SPOKEN_CUSTOMER_FIRST} ${SPOKEN_CUSTOMER_LAST}`;
const BOOKING_UTTERANCE = `Book ${SPOKEN_CUSTOMER} for next Tuesday at 2 pm for a furnace tune-up`;

function signSvixPayload(body: object, svixId: string, svixTimestamp: string): string {
  const rawBody = JSON.stringify(body);
  const secretBytes = Buffer.from(CLERK_SECRET.replace(/^whsec_/, ''), 'base64');
  const signedContent = `${svixId}.${svixTimestamp}.${rawBody}`;
  const sig = crypto.createHmac('sha256', secretBytes).update(signedContent).digest('base64');
  return `v1,${sig}`;
}

function msg<T>(payload: T): QueueMessage<T> {
  return {
    id: `msg-${crypto.randomUUID()}`,
    type: 'test',
    payload,
    attempts: 1,
    maxAttempts: 3,
    idempotencyKey: `idem-${crypto.randomUUID()}`,
    createdAt: new Date().toISOString(),
  };
}

/** Replays scripted JSON replies in call order; repeats the last one. */
function scriptedGateway(responses: unknown[]): LLMGateway {
  let i = 0;
  return {
    complete: async () =>
      ({
        content: JSON.stringify(responses[Math.min(i++, responses.length - 1)]),
        model: 'mock',
        provider: 'mock',
        tokenUsage: { input: 10, output: 10, total: 20 },
        latencyMs: 1,
      }) satisfies LLMResponse,
  } as unknown as LLMGateway;
}

const logger = createLogger({ service: 'test', environment: 'test', level: 'error' });

/**
 * The same small Pg-backed `UserModeService` app.ts wires for
 * `createMeRouter` in production (src/app.ts ~5148-5233), copied here rather
 * than touching app.ts — this test builds its own minimal express app from
 * real routers + real Pg repos, the established pattern in this directory
 * (see TEST-04, flow1-saas-billing-runthrough, voice-inbound-appointment).
 */
function createPgUserModeService(pool: Pool): UserModeService {
  return {
    async getUser(tenantId, userId) {
      const r = await pool.query(
        `SELECT id, clerk_user_id, tenant_id, role,
                COALESCE(can_field_serve, false) AS can_field_serve,
                COALESCE(current_mode, 'supervisor') AS current_mode,
                mode_changed_at
           FROM users
           WHERE tenant_id = $1 AND clerk_user_id = $2
           LIMIT 1`,
        [tenantId, userId],
      );
      if (r.rowCount === 0) return null;
      const row = r.rows[0] as Record<string, unknown>;
      const rec: MeUserRecord = {
        user_id: String(row.clerk_user_id),
        internal_user_id: String(row.id),
        tenant_id: String(row.tenant_id),
        role: String(row.role),
        can_field_serve: Boolean(row.can_field_serve),
        current_mode: row.current_mode as MeUserRecord['current_mode'],
        mode_changed_at: row.mode_changed_at ? new Date(row.mode_changed_at as string) : null,
      };
      return rec;
    },
    async getTenantSettings(tenantId) {
      const r = await pool.query(
        `SELECT backup_supervisor_user_id,
                COALESCE(unsupervised_proposal_routing, 'queue_and_sms') AS unsupervised_proposal_routing,
                COALESCE(timezone, $2) AS timezone
           FROM tenant_settings WHERE tenant_id = $1 LIMIT 1`,
        [tenantId, DEFAULT_TENANT_TIMEZONE],
      );
      if (r.rowCount === 0) {
        return {
          backup_supervisor_user_id: null,
          unsupervised_proposal_routing: 'queue_and_sms',
          timezone: DEFAULT_TENANT_TIMEZONE,
        } as MeTenantSettings;
      }
      const row = r.rows[0] as Record<string, unknown>;
      return {
        backup_supervisor_user_id: row.backup_supervisor_user_id ? String(row.backup_supervisor_user_id) : null,
        unsupervised_proposal_routing:
          row.unsupervised_proposal_routing as MeTenantSettings['unsupervised_proposal_routing'],
        timezone: String(row.timezone),
      };
    },
    async getTenantIntegrationStatuses(tenantId) {
      const r = await pool.query(
        `SELECT provider, status, updated_at FROM tenant_integrations WHERE tenant_id = $1`,
        [tenantId],
      );
      return r.rows.map((row) => ({
        provider: String(row.provider),
        status: String(row.status) as TenantIntegrationStatus,
        updated_at: row.updated_at ? new Date(String(row.updated_at)) : null,
      }));
    },
    async setMode(tenantId, userId, mode) {
      const now = new Date();
      await pool.query(
        `UPDATE users SET current_mode = $1, mode_changed_at = $2 WHERE tenant_id = $3 AND clerk_user_id = $4`,
        [mode, now, tenantId, userId],
      );
      return { modeChangedAt: now };
    },
  };
}

/** Tenant-scoped write against a FORCE-RLS table, matching the
 * `insertTwilioIntegration` helper pattern already used by
 * voice-inbound-appointment.test.ts. */
async function setTenantTimezone(pool: Pool, tenantId: string, timezone: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL app.current_tenant_id = '${tenantId}'`);
    await client.query(
      `UPDATE tenant_settings SET timezone = $1, updated_at = now() WHERE tenant_id = $2`,
      [timezone, tenantId],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

describe('Postgres integration — trial/provisioning proof pack (signup → workspace → trial → provisioned phone → in-app booking)', () => {
  let pool: Pool;
  let tenantRepo: PgTenantRepository;
  let settingsRepo: PgSettingsRepository;
  let auditRepo: PgAuditRepository;
  let packActivationRepo: PgPackActivationRepository;
  let customerRepo: PgCustomerRepository;
  let locationRepo: PgLocationRepository;
  let jobRepo: PgJobRepository;
  let appointmentRepo: PgAppointmentRepository;
  let userModeService: UserModeService;

  let clerkApp: express.Express;
  let stripeApp: express.Express;
  let billingService: BillingService;

  let voiceStore: VoiceSessionStore;

  const savedTwilioEnv = {
    sid: process.env.TWILIO_ACCOUNT_SID,
    token: process.env.TWILIO_AUTH_TOKEN,
  };

  // Evidence collected across steps, printed at the end (step f).
  const evidence: Record<string, unknown> = {};

  const clerkUserId = `user_${crypto.randomUUID()}`;
  const ownerEmail = `owner-${crypto.randomUUID()}@example.com`;
  let tenantId: string;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    tenantRepo = new PgTenantRepository(pool);
    settingsRepo = new PgSettingsRepository(pool);
    auditRepo = new PgAuditRepository(pool);
    packActivationRepo = new PgPackActivationRepository(pool);
    customerRepo = new PgCustomerRepository(pool);
    locationRepo = new PgLocationRepository(pool);
    jobRepo = new PgJobRepository(pool);
    appointmentRepo = new PgAppointmentRepository(pool);
    userModeService = createPgUserModeService(pool);

    // Hermetic: no real Twilio creds, whatever the host env happens to carry.
    delete process.env.TWILIO_ACCOUNT_SID;
    delete process.env.TWILIO_AUTH_TOKEN;

    // ── Clerk webhook app (step a) ──────────────────────────────────────
    clerkApp = express();
    clerkApp.use(express.json());
    const clerkConfig = {
      CLERK_WEBHOOK_SECRET: CLERK_SECRET,
      CLERK_SECRET_KEY: undefined,
    } as unknown as AppConfig;
    clerkApp.use(
      '/webhooks',
      createWebhookRouter(clerkConfig, { tenantRepo, settingsRepo, pool, auditRepo }),
    );

    // ── Stripe webhook app (step c) — mock Stripe fetch, real Postgres ──
    process.env.STRIPE_PRICE_ID = 'price_mock_trial_proof_pack';
    billingService = new BillingService({
      pool,
      config: { apiKey: 'sk_test_mock' },
      fetchFn: (async () => {
        throw new Error('unexpected Stripe fetch — this proof pack never opens real checkout');
      }) as unknown as typeof fetch,
    });
    stripeApp = express();
    stripeApp.use('/webhooks/stripe', express.raw({ type: '*/*' }));
    stripeApp.use(
      '/webhooks',
      createWebhookRouter({} as AppConfig, {
        billingService,
        pool,
        stripeWebhookSecret: STRIPE_SECRET,
      }),
    );

    voiceStore = new VoiceSessionStore({ startInterval: false });
  });

  afterAll(async () => {
    voiceStore.dispose();
    delete process.env.STRIPE_PRICE_ID;
    if (savedTwilioEnv.sid !== undefined) process.env.TWILIO_ACCOUNT_SID = savedTwilioEnv.sid;
    if (savedTwilioEnv.token !== undefined) process.env.TWILIO_AUTH_TOKEN = savedTwilioEnv.token;
    await closeSharedTestDb();
  });

  /** Builds a fresh express app authenticated as the given principal,
   * mounting every router this proof pack drives over HTTP. Matches the
   * req.auth-stamping shim used by test/routes/voice-sessions.route.test.ts
   * and test/integration/clerk-owner-membership.test.ts. */
  function buildAuthedApp(auth: { userId: string; tenantId: string; role: string }): express.Express {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as AuthenticatedRequest).auth = { ...auth, sessionId: `sess-${crypto.randomUUID()}` };
      next();
    });
    app.use('/api/me', createMeRouter(userModeService, auditRepo));
    app.use(
      '/api/onboarding',
      createOnboardingRouter({ settingsRepo, packActivationRepo, auditRepo, pool }),
    );
    app.use('/api/customers', createCustomerRouter(customerRepo, auditRepo));
    app.use('/api/locations', createLocationRouter(locationRepo, permissiveTenantOwnership(), auditRepo));
    app.use('/api/voice/sessions', createVoiceSessionsRouter({ adapter: voiceAdapter, store: voiceStore }));
    app.use('/api/proposals', createProposalsRouter(proposalRepo, appointmentRepo, auditRepo));
    return app;
  }

  // Shared, real-Postgres-backed proposal repo for the in-app voice leg
  // (step e). In-memory for the PROPOSAL bookkeeping itself — matching
  // voice-inbound-appointment.test.ts's InMemoryProposalRepository — while
  // the domain effect it approves into (the appointments row) is asserted
  // against real Postgres via appointmentRepo/jobRepo above.
  const proposalRepo = new InMemoryProposalRepository();
  let voiceAdapter: InAppVoiceAdapter;

  it('step a — signed Clerk user.created bootstraps tenant + owner + settings, idempotently', async () => {
    const svixId = `evt_signup_${crypto.randomUUID()}`;
    const svixTimestamp = String(Math.floor(Date.now() / 1000));
    const clerkPayload = {
      type: 'user.created',
      data: { id: clerkUserId, email_addresses: [{ email_address: ownerEmail }] },
    };
    const res = await request(clerkApp)
      .post('/webhooks/clerk')
      .set('svix-id', svixId)
      .set('svix-timestamp', svixTimestamp)
      .set('svix-signature', signSvixPayload(clerkPayload, svixId, svixTimestamp))
      .send(clerkPayload);
    expect(res.status).toBe(200);

    const tenant = await tenantRepo.findByOwner(clerkUserId);
    expect(tenant).toBeTruthy();
    tenantId = tenant!.id;
    evidence.tenantId = tenantId;

    const userRows = await pool.query(
      `SELECT role, status, deleted_at FROM users WHERE tenant_id = $1 AND clerk_user_id = $2`,
      [tenantId, clerkUserId],
    );
    expect(userRows.rowCount).toBe(1);
    expect(userRows.rows[0].role).toBe('owner');
    expect(userRows.rows[0].status).toBe('active');
    expect(userRows.rows[0].deleted_at).toBeNull();
    evidence.userId = clerkUserId;

    const settings = await settingsRepo.findByTenant(tenantId);
    expect(settings).toBeTruthy();
    expect(settings!.aiModel).toBeTruthy();

    // Idempotent replay — SAME svix id, fresh timestamp.
    const replayTimestamp = String(Math.floor(Date.now() / 1000));
    const replay = await request(clerkApp)
      .post('/webhooks/clerk')
      .set('svix-id', svixId)
      .set('svix-timestamp', replayTimestamp)
      .set('svix-signature', signSvixPayload(clerkPayload, svixId, replayTimestamp))
      .send(clerkPayload);
    expect(replay.status).toBe(200);

    const tenantCount = await pool.query(`SELECT count(*)::int AS n FROM tenants WHERE owner_id = $1`, [
      clerkUserId,
    ]);
    expect(tenantCount.rows[0].n).toBe(1);
    const ownerCount = await pool.query(
      `SELECT count(*)::int AS n FROM users WHERE tenant_id = $1 AND clerk_user_id = $2`,
      [tenantId, clerkUserId],
    );
    expect(ownerCount.rows[0].n).toBe(1);

    // Tenant zone: needed downstream for spoken-datetime resolution
    // (step e) — a real onboarding wizard submit would set this via
    // PUT /api/onboarding/identity; set it directly here since this proof
    // pack does not exercise the identity step.
    await setTenantTimezone(pool, tenantId, TENANT_TIMEZONE);
  });

  it('step b — GET /api/me returns the authenticated workspace (tenant id, owner role, permissions)', async () => {
    const app = buildAuthedApp({ userId: clerkUserId, tenantId, role: 'owner' });
    const res = await request(app).get('/api/me');
    expect(res.status).toBe(200);
    expect(res.body.tenant_id).toBe(tenantId);
    expect(res.body.role).toBe('owner');
    expect(Array.isArray(res.body.permissions)).toBe(true);
    expect(res.body.permissions.length).toBeGreaterThan(0);
    evidence.mePermissionsCount = res.body.permissions.length;
  });

  it('step c — signed Stripe customer.subscription.created (trialing) mirrors trial entitlement', async () => {
    const subscriptionId = `sub_${crypto.randomUUID()}`;
    const customerId = `cus_${crypto.randomUUID()}`;
    const trialEndEpoch = Math.floor(Date.now() / 1000) + 14 * 24 * 60 * 60;
    const stripeEvent = {
      id: `evt_stripe_${crypto.randomUUID()}`,
      type: 'customer.subscription.created',
      data: {
        object: {
          id: subscriptionId,
          customer: customerId,
          status: 'trialing',
          trial_end: trialEndEpoch,
          metadata: { tenant_id: tenantId },
        },
      },
    };
    const rawBody = JSON.stringify(stripeEvent);
    const res = await request(stripeApp)
      .post('/webhooks/stripe')
      .set('stripe-signature', createWebhookSignature(rawBody, STRIPE_SECRET))
      .set('content-type', 'application/json')
      .send(rawBody);
    expect(res.status).toBe(200);

    const tenantRow = await pool.query(
      `SELECT subscription_status, trial_ends_at, stripe_subscription_id FROM tenants WHERE id = $1`,
      [tenantId],
    );
    expect(tenantRow.rows[0].subscription_status).toBe('trialing');
    expect(tenantRow.rows[0].stripe_subscription_id).toBe(subscriptionId);
    const trialEndsAt = new Date(tenantRow.rows[0].trial_ends_at as string);
    expect(Math.round(trialEndsAt.getTime() / 1000)).toBe(trialEndEpoch);
    evidence.subscriptionStatus = 'trialing';
    evidence.trialEndsAt = trialEndsAt.toISOString();

    const app = buildAuthedApp({ userId: clerkUserId, tenantId, role: 'owner' });
    const status = await request(app).get('/api/onboarding/status');
    expect(status.status).toBe(200);
    expect(status.body.subscriptionStatus).toBe('trialing');
    const billingStep = status.body.steps.find((s: { id: string }) => s.id === 'billing');
    expect(billingStep?.status).toBe('done');

    // Trial entitlement, pure function — the same evaluator the telephony
    // voice gate (voice-gate.ts) calls with a real usage snapshot.
    const capBrandNew = evaluateTrialCap({
      status: 'trialing',
      dailyMinutes: 0,
      trialTotalMinutes: 0,
      concurrentCalls: 0,
    });
    expect(capBrandNew).toEqual({ allowed: true });
    const capAtDailyCeiling = evaluateTrialCap({
      status: 'trialing',
      dailyMinutes: TRIAL_LIMITS.DAILY_MINUTES,
      trialTotalMinutes: 0,
      concurrentCalls: 0,
    });
    expect(capAtDailyCeiling).toEqual({ allowed: false, reason: 'trial_cap_daily' });
  });

  it('step d — provision-twilio dev stub reaches full_readiness; onboarding phone step done; test-call skip works', async () => {
    const worker = createProvisionTwilioWorker({ pool });
    const payload: ProvisionTwilioPayload = {
      tenantId,
      region: null,
      baseUrl: 'http://localhost:3000',
    };
    await worker.handle(msg(payload), logger);

    const integ = await pool.query(
      `SELECT status, provider_data->>'phoneE164' AS phone_e164
         FROM tenant_integrations WHERE tenant_id = $1 AND provider = 'twilio'`,
      [tenantId],
    );
    expect(integ.rowCount).toBe(1);
    expect(integ.rows[0].status).toBe('full_readiness');
    expect(integ.rows[0].phone_e164).toBe(STUB_DEV_PHONE_E164);
    evidence.phoneE164 = integ.rows[0].phone_e164;

    const app = buildAuthedApp({ userId: clerkUserId, tenantId, role: 'owner' });
    const status = await request(app).get('/api/onboarding/status');
    const phoneStep = status.body.steps.find((s: { id: string }) => s.id === 'phone');
    expect(phoneStep?.status).toBe('done');
    expect(phoneStep?.metadata?.phoneNumber).toBe(STUB_DEV_PHONE_E164);

    const skip = await request(app).post('/api/onboarding/test-call/skip');
    expect(skip.status).toBe(200);
    const testCallStep = skip.body.steps.find((s: { id: string }) => s.id === 'test_call');
    expect(testCallStep?.status).toBe('skipped');
  });

  it('step e — first-value in-app: seed customer, voice-book, approve, execute → real appointment; cross-tenant isolated', async () => {
    const ownerApp = buildAuthedApp({ userId: clerkUserId, tenantId, role: 'owner' });

    // Seed one customer + primary location via the real HTTP API.
    const customerRes = await request(ownerApp).post('/api/customers').send({
      firstName: SPOKEN_CUSTOMER_FIRST,
      lastName: SPOKEN_CUSTOMER_LAST,
      preferredChannel: 'phone',
    });
    expect(customerRes.status).toBe(201);
    const customerId = customerRes.body.id as string;
    expect(customerRes.body.displayName).toBe(SPOKEN_CUSTOMER);

    const locationRes = await request(ownerApp).post('/api/locations').send({
      customerId,
      street1: '900 Trial Provisioning Way',
      city: 'Phoenix',
      state: 'AZ',
      postalCode: '85001',
      isPrimary: true,
    });
    expect(locationRes.status).toBe(201);

    // Build the InAppVoiceAdapter now (after settings/customer/location
    // exist) — `pool` alone self-wires PgEntityResolver + tenant-timezone
    // resolution (see inapp-adapter.ts's getEntityResolver /
    // resolveSessionTimezone), exactly like production app.ts wiring.
    voiceAdapter = new InAppVoiceAdapter({
      store: voiceStore,
      gateway: scriptedGateway([
        {
          intentType: 'create_appointment',
          confidence: 0.95,
          extractedEntities: {
            customerName: SPOKEN_CUSTOMER,
            dateTimeDescription: 'next Tuesday at 2 pm',
            jobTitle: 'Furnace tune-up',
          },
        },
        { answer: 'yes', reasoning: 'confirmed' },
      ]),
      proposalRepo,
      auditRepo,
      onCallRepo: new InMemoryOnCallRepository(),
      pool,
      settingsRepo,
    });
    // Rebuild the authed app now that voiceAdapter is wired (buildAuthedApp
    // closes over the mutable `voiceAdapter` binding via a fresh mount).
    const bookingApp = buildAuthedApp({ userId: clerkUserId, tenantId, role: 'owner' });

    const start = await request(bookingApp).post('/api/voice/sessions').send({});
    expect(start.status).toBe(201);
    const sessionId = start.body.sessionId as string;

    const turn1 = await request(bookingApp)
      .post(`/api/voice/sessions/${sessionId}/input`)
      .send({ text: BOOKING_UTTERANCE });
    expect(turn1.status).toBe(200);
    expect(turn1.body.state).toBe('intent_confirm');

    const turn2 = await request(bookingApp)
      .post(`/api/voice/sessions/${sessionId}/input`)
      .send({ text: 'yes' });
    expect(turn2.status).toBe(200);
    expect(turn2.body.proposalIds).toHaveLength(1);
    const proposalId = turn2.body.proposalIds[0] as string;
    evidence.proposalId = proposalId;

    const stored = await proposalRepo.findById(tenantId, proposalId);
    expect(stored).toBeTruthy();
    expect(stored!.proposalType).toBe('create_appointment');
    expect(stored!.status).toBe('ready_for_review');
    // Customer name resolved to the seeded customer's real id — no gate.
    expect(missingFieldsFor(stored!)).toHaveLength(0);
    expect((stored!.payload as Record<string, unknown>).customerId).toBe(customerId);

    // Approve via the REAL HTTP route, as the owner.
    const approveRes = await request(ownerApp).post(`/api/proposals/${proposalId}/approve`).send({});
    expect(approveRes.status).toBe(200);
    expect(approveRes.body.status).toBe('approved');

    // Backdate past the undo window (same technique as
    // update-brand-voice-voice-execution.test.ts) so the sweep below picks
    // it up instead of waiting out the real 5s window.
    await proposalRepo.updateStatus(tenantId, proposalId, 'approved', {
      approvedAt: new Date(Date.now() - UNDO_WINDOW_MS - 100),
    });

    const executionRepo = new InMemoryProposalExecutionRepository();
    const registry = createExecutionHandlerRegistry({
      appointmentRepo,
      jobRepo,
      locationRepo,
      settingsRepo,
      auditRepo,
    });
    const executor = new ProposalExecutor(
      registry,
      proposalRepo,
      new IdempotencyGuard(executionRepo, proposalRepo),
      auditRepo,
    );
    await runExecutionSweep({ proposalRepo, executor, logger, auditRepo });

    const executed = await proposalRepo.findById(tenantId, proposalId);
    expect(executed!.status).toBe('executed');

    const appointments = await pool.query(
      `SELECT a.id, a.job_id, a.status, j.customer_id, j.summary
         FROM appointments a JOIN jobs j ON j.id = a.job_id
        WHERE a.tenant_id = $1 AND j.customer_id = $2`,
      [tenantId, customerId],
    );
    expect(appointments.rowCount).toBe(1);
    const appointmentId = appointments.rows[0].id as string;
    expect(appointments.rows[0].status).toBe('scheduled');
    expect(String(appointments.rows[0].summary)).toContain('Furnace tune-up');
    evidence.appointmentId = appointmentId;

    // Audit: both the approval AND the execution left a real trail.
    const approvalAudit = await pool.query(
      `SELECT event_type FROM audit_events
        WHERE tenant_id = $1 AND event_type = 'proposal.approved' AND entity_id = $2`,
      [tenantId, proposalId],
    );
    expect(approvalAudit.rowCount).toBeGreaterThanOrEqual(1);
    const executionAudit = await pool.query(
      `SELECT event_type FROM audit_events
        WHERE tenant_id = $1 AND event_type = 'appointment.created'
          AND entity_type = 'appointment' AND entity_id = $2`,
      [tenantId, appointmentId],
    );
    expect(executionAudit.rowCount).toBe(1);

    // Cross-tenant isolation: a second tenant's owner cannot read this
    // proposal (404), and the appointment is invisible to their tenant id.
    const otherTenant = await createTestTenant(pool);
    const otherApp = buildAuthedApp({
      userId: otherTenant.userId,
      tenantId: otherTenant.tenantId,
      role: 'owner',
    });
    const crossRead = await request(otherApp).get(`/api/proposals/${proposalId}`);
    expect(crossRead.status).toBe(404);
    expect(await appointmentRepo.findById(otherTenant.tenantId, appointmentId)).toBeNull();
  });

  it('step f — evidence block', () => {
    // eslint-disable-next-line no-console
    console.log('\n=== Trial / provisioning proof pack — evidence ===');
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(evidence, null, 2));
    // eslint-disable-next-line no-console
    console.log('===================================================\n');
    expect(evidence.tenantId).toBeTruthy();
    expect(evidence.userId).toBeTruthy();
    expect(evidence.subscriptionStatus).toBe('trialing');
    expect(evidence.phoneE164).toBe(STUB_DEV_PHONE_E164);
    expect(evidence.proposalId).toBeTruthy();
    expect(evidence.appointmentId).toBeTruthy();
  });
});

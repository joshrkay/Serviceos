/**
 * B5.5 (AC-4) — "on my way" by voice, real Postgres.
 *
 * Proves, against a real database (conventions from
 * test/integration/voice-inbound-appointment.test.ts; cross-tenant pattern
 * from test/integration/onboarding-conversation.test.ts:128):
 *
 *   1. A voice-triggered en-route (`handleEnRouteVoiceIntent`, the exact
 *      orchestrator `workers/voice-action-router.ts` calls for the
 *      classified `en_route` intent) emits the
 *      `appointment.en_route_triggered` audit event with the TECH as actor
 *      (never a generic 'system' actor) — the same act the app en-route
 *      button and the SMS-keyword leg use (`dispatch/routes.ts
 *      triggerEnRoute`).
 *   2. A customer ETA SMS "dispatch row" lands via the EXISTING branded
 *      template path — `DelayNotificationCoordinator.enqueueEnRouteNotice`
 *      writes a real `delay_notice_state` row (channel 'sms', status
 *      'queued') keyed by the coordinator's own idempotency mechanism.
 *   3. Idempotence: a second "on my way" utterance inside the window does
 *      NOT double-text the customer — the SAME `delay_notice_state` row
 *      (by idempotency key) is reused, not duplicated, and the coordinator
 *      does not re-enter the render/upsert path.
 *   4. Cross-tenant negative: a technician in tenant B has zero assignments
 *      of their own; RLS-scoped appointment reads for tenant A's
 *      appointment ID return nothing under tenant B's context, so
 *      resolution honestly reports "no upcoming appointment" rather than
 *      leaking or acting on another tenant's row — no audit event, no
 *      delay_notice_state row is created for the cross-tenant attempt.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb, TestTenant } from './shared';
import { PgAppointmentRepository } from '../../src/appointments/pg-appointment';
import { PgAssignmentRepository } from '../../src/appointments/pg-assignment';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgLocationRepository } from '../../src/locations/pg-location';
import { PgUserRepository } from '../../src/users/pg-user';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { PgSettingsRepository } from '../../src/settings/pg-settings';
import { ensureTenantSettings } from '../../src/settings/settings';
import { PgDelayNoticeStateRepository } from '../../src/notifications/pg-delay-notice-state';
import {
  DelayNotificationCoordinator,
  NextCustomerSelector,
} from '../../src/notifications/delay-notifications';
import { InMemoryQueue } from '../../src/queues/queue';
import { handleEnRouteVoiceIntent } from '../../src/dispatch/en-route-voice';
import type { VoiceRepository } from '../../src/voice/voice-service';
// #847 — the phone and chat legs of the same act.
import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';
import { vi } from 'vitest';
import { VoiceSessionStore } from '../../src/ai/agents/customer-calling/voice-session-store';
import { answerPhoneEnRoute } from '../../src/ai/voice-turn/phone-en-route-surface';
import { createAssistantRouter } from '../../src/routes/assistant';
import { InMemoryProposalRepository } from '../../src/proposals/proposal';
import type { LLMGateway, LLMResponse } from '../../src/ai/gateway/gateway';
import type { AuthenticatedRequest } from '../../src/auth/clerk';

const NOW = new Date('2026-08-03T14:00:00.000Z'); // a Monday, well inside the appt windows below

async function insertTechnician(
  pool: Pool,
  tenantId: string,
  opts: { clerkUserId: string; email: string; firstName: string; lastName: string },
): Promise<string> {
  const userId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO users (id, tenant_id, clerk_user_id, email, role, first_name, last_name)
     VALUES ($1, $2, $3, $4, 'technician', $5, $6)`,
    [userId, tenantId, opts.clerkUserId, opts.email, opts.firstName, opts.lastName],
  );
  return userId;
}

describe('Integration — "on my way" by voice (real Postgres)', () => {
  let pool: Pool;
  let appointmentRepo: PgAppointmentRepository;
  let assignmentRepo: PgAssignmentRepository;
  let jobRepo: PgJobRepository;
  let customerRepo: PgCustomerRepository;
  let locationRepo: PgLocationRepository;
  let userRepo: PgUserRepository;
  let auditRepo: PgAuditRepository;
  let settingsRepo: PgSettingsRepository;
  let stateRepo: PgDelayNoticeStateRepository;
  let coordinator: DelayNotificationCoordinator;

  let tenantA: TestTenant;
  let tenantB: TestTenant;
  let techA: string;
  let techAClerkId: string;
  let techB: string;
  let techBClerkId: string;
  let appointmentId: string;
  let jobId: string;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    appointmentRepo = new PgAppointmentRepository(pool);
    assignmentRepo = new PgAssignmentRepository(pool);
    jobRepo = new PgJobRepository(pool);
    customerRepo = new PgCustomerRepository(pool);
    locationRepo = new PgLocationRepository(pool);
    userRepo = new PgUserRepository(pool);
    auditRepo = new PgAuditRepository(pool);
    settingsRepo = new PgSettingsRepository(pool);
    stateRepo = new PgDelayNoticeStateRepository(pool);

    const queue = new InMemoryQueue();
    const selector = new NextCustomerSelector(appointmentRepo, assignmentRepo, jobRepo, customerRepo);
    // The SAME coordinator class the app en-route button and the SMS-keyword
    // leg use — B5.5's whole premise is that all three legs call one act.
    coordinator = new DelayNotificationCoordinator(queue, selector, stateRepo);

    tenantA = await createTestTenant(pool);
    // The tenant's own zone, which is what bounds the service day. Previously
    // unset: the resolver fell back to UTC, and the tests passed on that
    // fallback. It now declines without a zone, because a UTC day for a
    // western tenant already contains the next local morning — so a real
    // tenant must have one here for these assertions to mean anything.
    await ensureTenantSettings(tenantA.tenantId, settingsRepo);
    await settingsRepo.upsertIdentityFields(tenantA.tenantId, { timezone: 'America/Chicago' });
    tenantB = await createTestTenant(pool);
    // Tenant B needs a zone too, or the cross-tenant negative below would
    // pass for the WRONG reason — declining on a missing timezone rather than
    // proving it cannot see tenant A's appointment.
    await ensureTenantSettings(tenantB.tenantId, settingsRepo);
    await settingsRepo.upsertIdentityFields(tenantB.tenantId, { timezone: 'America/Chicago' });

    techAClerkId = `clerk-tech-a-${crypto.randomUUID()}`;
    techA = await insertTechnician(pool, tenantA.tenantId, {
      clerkUserId: techAClerkId,
      email: 'tech-a@example.com',
      firstName: 'Carlos',
      lastName: 'Ruiz',
    });
    techBClerkId = `clerk-tech-b-${crypto.randomUUID()}`;
    techB = await insertTechnician(pool, tenantB.tenantId, {
      clerkUserId: techBClerkId,
      email: 'tech-b@example.com',
      firstName: 'Dana',
      lastName: 'Lee',
    });

    const customerId = crypto.randomUUID();
    await customerRepo.create({
      id: customerId,
      tenantId: tenantA.tenantId,
      firstName: 'Jamie',
      lastName: 'Garcia',
      displayName: 'Jamie Garcia',
      primaryPhone: '+15125551234',
      preferredChannel: 'sms',
      smsConsent: true,
      isArchived: false,
      createdBy: tenantA.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const locationId = crypto.randomUUID();
    await locationRepo.create({
      id: locationId,
      tenantId: tenantA.tenantId,
      customerId,
      street1: '77 Garcia Lane',
      city: 'Austin',
      state: 'TX',
      postalCode: '78701',
      country: 'USA',
      isPrimary: true,
      isArchived: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    jobId = crypto.randomUUID();
    await jobRepo.create({
      id: jobId,
      tenantId: tenantA.tenantId,
      customerId,
      locationId,
      jobNumber: 'JOB-EN-ROUTE-1',
      // An ordinary summary: what the work IS. "Garcia" appears nowhere on
      // the job row — only on the customer it links to — so "the Garcia job"
      // can only reach this appointment through jobs.customer_id → customers.
      summary: 'AC repair',
      status: 'scheduled',
      priority: 'normal',
      createdBy: tenantA.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    appointmentId = crypto.randomUUID();
    await appointmentRepo.create({
      id: appointmentId,
      tenantId: tenantA.tenantId,
      jobId,
      scheduledStart: new Date(NOW.getTime() + 60 * 60 * 1000),
      scheduledEnd: new Date(NOW.getTime() + 2 * 60 * 60 * 1000),
      timezone: 'America/Chicago',
      status: 'scheduled',
      holdPendingApproval: false,
      createdBy: tenantA.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await assignmentRepo.create({
      id: crypto.randomUUID(),
      tenantId: tenantA.tenantId,
      appointmentId,
      technicianId: techA,
      isPrimary: true,
      assignedBy: tenantA.userId,
      assignedAt: new Date(),
    });
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  function voiceRepoFor(clerkId: string): Pick<VoiceRepository, 'findById'> {
    return {
      findById: async (_tenantId: string, id: string) =>
        ({
          id,
          tenantId: tenantA.tenantId,
          createdBy: clerkId,
        }) as Awaited<ReturnType<VoiceRepository['findById']>>,
    };
  }

  it('the seeded job is an ORDINARY one — "the Garcia job" is unreachable from its summary, so only the customer traversal can answer it', async () => {
    // The fixture is arranged against the weak match, not for it. This is the
    // assertion that makes the three proofs below non-vacuous: if a future
    // change re-plants the customer's name in the summary, this fails first.
    const job = await jobRepo.findById(tenantA.tenantId, jobId);
    expect(job).not.toBeNull();
    expect(job!.summary.toLowerCase()).not.toContain('garcia');
    expect(job!.jobNumber.toLowerCase()).not.toContain('garcia');
    // ...while the relationship the resolver now walks does reach the name.
    const customer = await customerRepo.findById(tenantA.tenantId, job!.customerId);
    expect(customer?.displayName).toBe('Jamie Garcia');
  });

  it('AC-4.1/4.2: a voice-triggered en-route emits the audit event (TECH actor) + a customer ETA SMS dispatch row', async () => {
    const outcome = await handleEnRouteVoiceIntent(
      {
        userRepo,
        voiceRepo: voiceRepoFor(techAClerkId),
        assignmentRepo,
        appointmentRepo,
        jobRepo,
        customerRepo,
        enRouteCoordinator: coordinator,
        auditRepo,
        settingsRepo,
        now: () => NOW,
      },
      { tenantId: tenantA.tenantId, recordingId: 'rec-1', jobReference: 'the Garcia job' },
    );

    expect(outcome.kind).toBe('answered');
    if (outcome.kind === 'answered') {
      expect(outcome.answer.result).toBe('found');
    }

    // 1. Audit event, real Postgres, TECH actor.
    const auditRows = await pool.query(
      `SELECT actor_id, actor_role, event_type FROM audit_events
        WHERE tenant_id = $1 AND event_type = 'appointment.en_route_triggered'
          AND entity_type = 'appointment' AND entity_id = $2`,
      [tenantA.tenantId, appointmentId],
    );
    expect(auditRows.rows).toHaveLength(1);
    expect(auditRows.rows[0].actor_id).toBe(techA);
    expect(auditRows.rows[0].actor_role).toBe('technician');

    // 2. Customer ETA SMS dispatch row — the existing branded template path.
    const stateRows = await pool.query(
      `SELECT idempotency_key, channel, status, appointment_id FROM delay_notice_state
        WHERE tenant_id = $1 AND appointment_id = $2`,
      [tenantA.tenantId, appointmentId],
    );
    expect(stateRows.rows).toHaveLength(1);
    expect(stateRows.rows[0].idempotency_key).toBe(`${appointmentId}:en_route`);
    expect(stateRows.rows[0].channel).toBe('sms');
    expect(stateRows.rows[0].status).toBe('queued');
  });

  it('AC-4.3: idempotence — a second "on my way" in-window does not double-text (same delay_notice_state row, no duplicate audit event count explosion)', async () => {
    // Second utterance for the SAME appointment, moments later.
    const outcome = await handleEnRouteVoiceIntent(
      {
        userRepo,
        voiceRepo: voiceRepoFor(techAClerkId),
        assignmentRepo,
        appointmentRepo,
        jobRepo,
        customerRepo,
        enRouteCoordinator: coordinator,
        auditRepo,
        settingsRepo,
        now: () => new Date(NOW.getTime() + 60_000),
      },
      { tenantId: tenantA.tenantId, recordingId: 'rec-2', jobReference: 'the Garcia job' },
    );

    expect(outcome.kind).toBe('answered');

    // Still exactly ONE delay_notice_state row for this appointment — the
    // coordinator's idempotency key (`${appointmentId}:en_route`) dedups the
    // second call rather than sending (or queueing) a second customer text.
    const stateRows = await pool.query(
      `SELECT idempotency_key, status FROM delay_notice_state
        WHERE tenant_id = $1 AND appointment_id = $2`,
      [tenantA.tenantId, appointmentId],
    );
    expect(stateRows.rows).toHaveLength(1);

    // The audited direct status act itself is NOT deduped (each spoken "on
    // my way" is a real, distinct technician action worth its own audit
    // trail) — but the underlying customer SMS is: both calls resolve to
    // the SAME idempotencyKey, proving the dedup mechanism actually fired
    // rather than two unrelated keys happening to queue twice.
    const auditRows = await pool.query(
      `SELECT correlation_id FROM audit_events
        WHERE tenant_id = $1 AND event_type = 'appointment.en_route_triggered'
          AND entity_type = 'appointment' AND entity_id = $2
        ORDER BY created_at ASC`,
      [tenantA.tenantId, appointmentId],
    );
    expect(auditRows.rows.length).toBeGreaterThanOrEqual(2);
    const correlationIds = new Set(auditRows.rows.map((r) => r.correlation_id));
    expect(correlationIds).toEqual(new Set([`${appointmentId}:en_route`]));
  });

  it('AC-4.4: cross-tenant negative — a tenant B technician resolves to "no upcoming appointment", never tenant A\'s row', async () => {
    const outcome = await handleEnRouteVoiceIntent(
      {
        userRepo,
        voiceRepo: voiceRepoFor(techBClerkId),
        assignmentRepo,
        appointmentRepo,
        jobRepo,
        customerRepo,
        enRouteCoordinator: coordinator,
        auditRepo,
        settingsRepo,
        now: () => NOW,
      },
      { tenantId: tenantB.tenantId, recordingId: 'rec-cross-tenant', jobReference: 'the Garcia job' },
    );

    expect(outcome.kind).toBe('answered');
    if (outcome.kind === 'answered') {
      expect(outcome.answer.result).toBe('none');
    }

    // The RLS-scoped read for tenant B never sees tenant A's appointment.
    const crossTenantRead = await appointmentRepo.findById(tenantB.tenantId, appointmentId);
    expect(crossTenantRead).toBeNull();

    // No en-route audit event was recorded for tenant B's attempt.
    const auditRows = await pool.query(
      `SELECT id FROM audit_events
        WHERE tenant_id = $1 AND event_type = 'appointment.en_route_triggered'`,
      [tenantB.tenantId],
    );
    expect(auditRows.rows).toHaveLength(0);

    // And tenant A's appointment/dispatch state is untouched by tenant B's attempt.
    const stateRows = await pool.query(
      `SELECT idempotency_key FROM delay_notice_state WHERE tenant_id = $1 AND appointment_id = $2`,
      [tenantA.tenantId, appointmentId],
    );
    expect(stateRows.rows).toHaveLength(1);
  });

  // ── #847 — the phone and chat legs of the SAME act ────────────────────────
  // Fresh tenant per leg so the audit / delay_notice_state assertions are
  // exact counts, never entangled with the memo-leg fixtures above.
  async function seedTenantFixture(label: string) {
    const t = await createTestTenant(pool);
    await ensureTenantSettings(t.tenantId, settingsRepo);
    await settingsRepo.upsertIdentityFields(t.tenantId, { timezone: 'America/Chicago' });
    const clerkId = `clerk-${label}-${crypto.randomUUID()}`;
    const techId = await insertTechnician(pool, t.tenantId, {
      clerkUserId: clerkId,
      email: `${label}@example.com`,
      firstName: 'Terry',
      lastName: 'Field',
    });
    const customerId = crypto.randomUUID();
    await customerRepo.create({
      id: customerId,
      tenantId: t.tenantId,
      firstName: 'Robin',
      lastName: 'Nguyen',
      displayName: 'Robin Nguyen',
      primaryPhone: '+15125559876',
      preferredChannel: 'sms',
      smsConsent: true,
      isArchived: false,
      createdBy: t.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const locationId = crypto.randomUUID();
    await locationRepo.create({
      id: locationId,
      tenantId: t.tenantId,
      customerId,
      street1: '9 Nguyen Court',
      city: 'Austin',
      state: 'TX',
      postalCode: '78701',
      country: 'USA',
      isPrimary: true,
      isArchived: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const fixtureJobId = crypto.randomUUID();
    await jobRepo.create({
      id: fixtureJobId,
      tenantId: t.tenantId,
      customerId,
      locationId,
      jobNumber: `JOB-${label.toUpperCase()}`,
      summary: 'Water heater replacement',
      status: 'scheduled',
      priority: 'normal',
      createdBy: t.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const apptId = crypto.randomUUID();
    await appointmentRepo.create({
      id: apptId,
      tenantId: t.tenantId,
      jobId: fixtureJobId,
      scheduledStart: new Date(NOW.getTime() + 60 * 60 * 1000),
      scheduledEnd: new Date(NOW.getTime() + 2 * 60 * 60 * 1000),
      timezone: 'America/Chicago',
      status: 'scheduled',
      holdPendingApproval: false,
      createdBy: t.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await assignmentRepo.create({
      id: crypto.randomUUID(),
      tenantId: t.tenantId,
      appointmentId: apptId,
      technicianId: techId,
      isPrimary: true,
      assignedBy: t.userId,
      assignedAt: new Date(),
    });
    return { tenant: t, clerkId, techId, apptId };
  }

  function phoneBundle() {
    return {
      userRepo,
      assignmentRepo,
      appointmentRepo,
      jobRepo,
      customerRepo,
      settingsRepo,
      auditRepo,
      enRouteCoordinator: coordinator,
      now: () => NOW,
    };
  }

  it('#847 phone leg: a Gather session actor fires the audited act through the phone surface (real rows)', async () => {
    const fx = await seedTenantFixture('phone-leg');
    const store = new VoiceSessionStore({ startInterval: false });
    const session = store.create(fx.tenant.tenantId, 'telephony', { callSid: 'CA-int-enroute-phone' });
    // The phone surface's identity source: the actor resolved once at
    // session establishment (telephony/phone-actor.ts). Here it is the
    // seeded technician's CANONICAL users.id — role is then re-read from
    // the REAL users row by the surface's role gate.
    session.actorUserId = fx.techId;

    const line = await answerPhoneEnRoute(phoneBundle(), {
      session,
      tenantId: fx.tenant.tenantId,
    });

    expect(line).toContain('Sent the customer an on-my-way text');

    // Audit event with the TECH actor — the same act as the app button.
    const auditRows = await pool.query(
      `SELECT actor_id, actor_role FROM audit_events
        WHERE tenant_id = $1 AND event_type = 'appointment.en_route_triggered' AND entity_id = $2`,
      [fx.tenant.tenantId, fx.apptId],
    );
    expect(auditRows.rows).toHaveLength(1);
    expect(auditRows.rows[0].actor_id).toBe(fx.techId);
    expect(auditRows.rows[0].actor_role).toBe('technician');

    // Customer ETA SMS dispatch row via the same coordinator instance.
    const stateRows = await pool.query(
      `SELECT idempotency_key, channel, status FROM delay_notice_state
        WHERE tenant_id = $1 AND appointment_id = $2`,
      [fx.tenant.tenantId, fx.apptId],
    );
    expect(stateRows.rows).toHaveLength(1);
    expect(stateRows.rows[0].idempotency_key).toBe(`${fx.apptId}:en_route`);
    expect(stateRows.rows[0].channel).toBe('sms');
    expect(stateRows.rows[0].status).toBe('queued');
  });

  it('#847 phone leg: a non-technician actor is refused against the REAL users row and nothing fires', async () => {
    const fx = await seedTenantFixture('phone-owner');
    // A dispatcher on the roster whose number resolved — still not a tech.
    const dispatcherId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO users (id, tenant_id, clerk_user_id, email, role, first_name, last_name)
       VALUES ($1, $2, $3, $4, 'dispatcher', 'Dana', 'Desk')`,
      [dispatcherId, fx.tenant.tenantId, `clerk-dispatcher-${crypto.randomUUID()}`, 'desk@example.com'],
    );
    const store = new VoiceSessionStore({ startInterval: false });
    const session = store.create(fx.tenant.tenantId, 'telephony', { callSid: 'CA-int-enroute-owner' });
    session.actorUserId = dispatcherId;

    const line = await answerPhoneEnRoute(phoneBundle(), {
      session,
      tenantId: fx.tenant.tenantId,
    });

    expect(line).toContain('sent by the technician on the job');
    const auditRows = await pool.query(
      `SELECT id FROM audit_events
        WHERE tenant_id = $1 AND event_type = 'appointment.en_route_triggered'`,
      [fx.tenant.tenantId],
    );
    expect(auditRows.rows).toHaveLength(0);
    const stateRows = await pool.query(
      `SELECT idempotency_key FROM delay_notice_state WHERE tenant_id = $1`,
      [fx.tenant.tenantId],
    );
    expect(stateRows.rows).toHaveLength(0);
  });

  it('#847 chat leg: the auth subject (Clerk id) resolves through REAL users rows and fires the act', async () => {
    const fx = await seedTenantFixture('chat-leg');
    const gateway = {
      complete: vi.fn(async () => ({
        content: JSON.stringify({
          intentType: 'en_route',
          confidence: 0.95,
          reasoning: 'test',
          extractedEntities: {},
        }),
        model: 'mock',
        provider: 'mock',
        tokenUsage: { input: 1, output: 1, total: 2 },
        latencyMs: 1,
      } satisfies LLMResponse)),
    } as unknown as LLMGateway;

    const app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as AuthenticatedRequest).auth = {
        userId: fx.clerkId,
        sessionId: 'sess-int-enroute',
        tenantId: fx.tenant.tenantId,
        role: 'technician',
      };
      next();
    });
    app.use(
      '/api/assistant',
      createAssistantRouter({
        gateway,
        proposalRepo: new InMemoryProposalRepository(),
        enRoute: phoneBundle(),
      }),
    );

    const res = await request(app)
      .post('/api/assistant/chat')
      .send({ messages: [{ role: 'user', content: "I'm on my way" }] });

    expect(res.status).toBe(200);
    expect(res.body.taskType).toBe('assistant.en_route');
    expect(res.body.message.content).toContain('Sent the customer an on-my-way text');

    const auditRows = await pool.query(
      `SELECT actor_id, actor_role FROM audit_events
        WHERE tenant_id = $1 AND event_type = 'appointment.en_route_triggered' AND entity_id = $2`,
      [fx.tenant.tenantId, fx.apptId],
    );
    expect(auditRows.rows).toHaveLength(1);
    expect(auditRows.rows[0].actor_id).toBe(fx.techId);
    expect(auditRows.rows[0].actor_role).toBe('technician');

    const stateRows = await pool.query(
      `SELECT idempotency_key, channel, status FROM delay_notice_state
        WHERE tenant_id = $1 AND appointment_id = $2`,
      [fx.tenant.tenantId, fx.apptId],
    );
    expect(stateRows.rows).toHaveLength(1);
    expect(stateRows.rows[0].idempotency_key).toBe(`${fx.apptId}:en_route`);
  });
});

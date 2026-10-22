import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgDripRepository, PgDripSignals } from '../../src/marketing/drip/pg-drip-repository';
import type { DripSequence } from '../../src/marketing/drip/sequence';

/**
 * #1735 — pins the real columns the drip repository + signals read and write
 * (migrations 336/337): enrollment lifecycle, the lease, targeting queries,
 * and the booking / reply exit signals.
 */
describe('Postgres integration — drip campaigns (migrations 336/337/350)', () => {
  let pool: Pool;
  let repo: PgDripRepository;
  let signals: PgDripSignals;
  let tenant: { tenantId: string; userId: string };
  const now = new Date();
  const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000);

  async function seedCustomer(name: string): Promise<string> {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO customers (id, tenant_id, first_name, display_name, created_by) VALUES ($1, $2, $3, $3, $4)`,
      [id, tenant.tenantId, name, tenant.userId],
    );
    return id;
  }

  async function seedJob(customerId: string, status: string, createdAt: Date): Promise<string> {
    const locationId = randomUUID();
    await pool.query(
      `INSERT INTO service_locations (id, tenant_id, customer_id, street1, city, state, postal_code)
       VALUES ($1, $2, $3, '1 Main', 'Austin', 'TX', '78701')`,
      [locationId, tenant.tenantId, customerId],
    );
    const id = randomUUID();
    await pool.query(
      `INSERT INTO jobs (id, tenant_id, customer_id, location_id, job_number, summary, status, created_by, created_at)
       VALUES ($1, $2, $3, $4, $5, 'x', $6, $7, $8)`,
      [id, tenant.tenantId, customerId, locationId, `J-${id.slice(0, 8)}`, status, tenant.userId, createdAt],
    );
    return id;
  }

  const daysAhead = (d: number) => new Date(now.getTime() + d * 86_400_000).toISOString().slice(0, 10);

  async function seedAgreement(
    customerId: string,
    over: { endsOn?: string | null; autoRenew?: boolean; status?: string; createdAt?: Date } = {},
  ): Promise<string> {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO service_agreements
         (id, tenant_id, customer_id, name, recurrence_rule, next_run_at, starts_on, ends_on,
          status, auto_renew, renewal_term_months, created_by, created_at)
       VALUES ($1, $2, $3, 'Comfort Club', 'FREQ=YEARLY', $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        id,
        tenant.tenantId,
        customerId,
        now,
        daysAhead(-335),
        over.endsOn === undefined ? daysAhead(20) : over.endsOn,
        over.status ?? 'active',
        over.autoRenew ?? false,
        over.autoRenew ? 12 : null,
        tenant.userId,
        over.createdAt ?? daysAgo(335),
      ],
    );
    return id;
  }

  function sequence(over: Partial<DripSequence> = {}): DripSequence {
    return {
      id: randomUUID(),
      tenantId: tenant.tenantId,
      name: 'Win back',
      targetKind: 'lapsed_customers',
      targetDays: 180,
      steps: [{ channel: 'sms', delayMinutes: 0, body: 'Hi' }],
      status: 'active',
      createdBy: tenant.userId,
      createdAt: now,
      updatedAt: now,
      ...over,
    };
  }

  beforeAll(async () => {
    pool = await getSharedTestDb();
    repo = new PgDripRepository(pool);
    signals = new PgDripSignals(pool);
    tenant = await createTestTenant(pool);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('persists a sequence (steps round-trip as JSON) and toggles its status', async () => {
    const created = await repo.createSequence(
      sequence({ steps: [{ channel: 'call', delayMinutes: 5, agentPhone: '+15551234567' }], status: 'paused' }),
    );
    expect((await repo.findSequence(tenant.tenantId, created.id))?.steps).toEqual(created.steps);
    expect((await repo.setSequenceStatus(tenant.tenantId, created.id, 'active'))?.status).toBe('active');
    expect(await repo.setSequenceStatus(tenant.tenantId, randomUUID(), 'active')).toBeNull();
  });

  it('enrolls once per customer, leases a due enrollment once, and reports stats', async () => {
    const seq = await repo.createSequence(sequence());
    const c1 = await seedCustomer('Ann');
    const target = { customerId: c1, sourceEntityType: null, sourceEntityId: null };
    expect(await repo.enroll(tenant.tenantId, seq.id, [target], daysAgo(0))).toBe(1);
    expect(await repo.enroll(tenant.tenantId, seq.id, [target], daysAgo(0))).toBe(0);

    const due = await repo.listDue(tenant.tenantId, new Date(now.getTime() + 1000), 10);
    const mine = due.filter((e) => e.sequenceId === seq.id);
    expect(mine).toHaveLength(1);

    const lease = new Date(now.getTime() + 15 * 60_000);
    expect(await repo.claim(tenant.tenantId, mine[0].id, new Date(now.getTime() + 1000), lease)).toBe(true);
    expect(await repo.claim(tenant.tenantId, mine[0].id, new Date(now.getTime() + 1000), lease)).toBe(false);

    await repo.updateEnrollment(tenant.tenantId, mine[0].id, {
      status: 'completed',
      exitReason: 'completed',
      currentStep: 0,
      stepAttempts: 0,
      nextRunAt: now,
      finishedAt: now,
    });
    await repo.addStepEvent({
      tenantId: tenant.tenantId,
      enrollmentId: mine[0].id,
      stepIndex: 0,
      channel: 'sms',
      outcome: 'sent',
    });
    await repo.recordBooking(tenant.tenantId, mine[0].id, { appointmentId: randomUUID(), bookedAt: now });
    const stat = (await repo.stats(tenant.tenantId)).find((s) => s.sequenceId === seq.id);
    expect(stat).toEqual({ sequenceId: seq.id, enrolled: 1, active: 0, completed: 1, booked: 1 });
  });

  it('does not list due enrollments of a paused sequence', async () => {
    const seq = await repo.createSequence(sequence({ status: 'paused' }));
    await repo.enroll(
      tenant.tenantId,
      seq.id,
      [{ customerId: await seedCustomer('Bo'), sourceEntityType: null, sourceEntityId: null }],
      daysAgo(1),
    );
    const due = await repo.listDue(tenant.tenantId, now, 100);
    expect(due.some((e) => e.sequenceId === seq.id)).toBe(false);
  });

  it('targets lapsed customers: a completed job once, nothing recent, not archived', async () => {
    const lapsed = await seedCustomer('Lapsed');
    await seedJob(lapsed, 'completed', daysAgo(400));
    const recent = await seedCustomer('Recent');
    await seedJob(recent, 'completed', daysAgo(400));
    await seedJob(recent, 'new', daysAgo(10));
    const never = await seedCustomer('NeverBought');
    void never;

    const targets = await signals.findTargets(tenant.tenantId, 'lapsed_customers', 180, now, 100);
    const ids = targets.map((t) => t.customerId);
    expect(ids).toContain(lapsed);
    expect(ids).not.toContain(recent);
    expect(ids).not.toContain(never);
  });

  it('targets unsold estimates: still sent after N days, no later acceptance', async () => {
    const unsold = await seedCustomer('Unsold');
    const jobId = await seedJob(unsold, 'new', daysAgo(30));
    const estimateId = randomUUID();
    await pool.query(
      `INSERT INTO estimates (id, tenant_id, job_id, estimate_number, status, created_by, updated_at)
       VALUES ($1, $2, $3, $4, 'sent', $5, $6)`,
      [estimateId, tenant.tenantId, jobId, `E-${estimateId.slice(0, 8)}`, tenant.userId, daysAgo(10)],
    );
    const sold = await seedCustomer('Sold');
    const soldJob = await seedJob(sold, 'new', daysAgo(30));
    const soldEstimate = randomUUID();
    await pool.query(
      `INSERT INTO estimates (id, tenant_id, job_id, estimate_number, status, created_by, updated_at)
       VALUES ($1, $2, $3, $4, 'accepted', $5, $6)`,
      [soldEstimate, tenant.tenantId, soldJob, `E-${soldEstimate.slice(0, 8)}`, tenant.userId, daysAgo(10)],
    );

    const targets = await signals.findTargets(tenant.tenantId, 'unsold_estimates', 3, now, 100);
    expect(targets).toContainEqual({ customerId: unsold, sourceEntityType: 'estimate', sourceEntityId: estimateId });
    expect(targets.map((t) => t.customerId)).not.toContain(sold);
  });

  it('targets membership renewals: active, not auto-renewing, ending inside the window, not already covered (#1735, migration 350)', async () => {
    const due = await seedCustomer('RenewSoon');
    const dueAgreement = await seedAgreement(due);
    const auto = await seedCustomer('AutoRenews');
    await seedAgreement(auto, { autoRenew: true });
    const far = await seedCustomer('EndsLater');
    await seedAgreement(far, { endsOn: daysAhead(90) });
    const past = await seedCustomer('AlreadyEnded');
    await seedAgreement(past, { endsOn: daysAhead(-5) });
    const cancelled = await seedCustomer('Cancelled');
    await seedAgreement(cancelled, { status: 'cancelled' });
    const covered = await seedCustomer('AlreadyRenewed');
    await seedAgreement(covered);
    await seedAgreement(covered, { endsOn: daysAhead(385), createdAt: daysAgo(1) });

    const targets = await signals.findTargets(tenant.tenantId, 'membership_renewals', 30, now, 100);
    expect(targets).toContainEqual({ customerId: due, sourceEntityType: 'service_agreement', sourceEntityId: dueAgreement });
    const ids = targets.map((t) => t.customerId);
    for (const skipped of [auto, far, past, cancelled, covered]) expect(ids).not.toContain(skipped);

    // The widened CHECKs accept the new kind and exit reason.
    const seq = await repo.createSequence(sequence({ targetKind: 'membership_renewals', targetDays: 30 }));
    expect(await repo.enroll(tenant.tenantId, seq.id, targets.filter((t) => t.customerId === due), daysAgo(0))).toBe(1);
    const [enrollment] = (await repo.listDue(tenant.tenantId, new Date(now.getTime() + 1000), 100)).filter(
      (e) => e.sequenceId === seq.id,
    );
    expect(enrollment).toMatchObject({ sourceEntityType: 'service_agreement', sourceEntityId: dueAgreement });
    await repo.updateEnrollment(tenant.tenantId, enrollment.id, {
      status: 'exited',
      exitReason: 'renewed',
      currentStep: 0,
      stepAttempts: 0,
      nextRunAt: now,
      finishedAt: now,
    });
  });

  it('knows when a membership was renewed: term extended, auto-renew on, or a new one started', async () => {
    const renewBy = new Date(now.getTime() + 30 * 86_400_000);
    const since = daysAgo(1);
    const check = (agreementId: string, customerId: string) =>
      signals.hasRenewedMembership(tenant.tenantId, { agreementId, customerId, renewBy, since });

    const waiting = await seedCustomer('StillWaiting');
    const waitingAgreement = await seedAgreement(waiting);
    expect(await check(waitingAgreement, waiting)).toBe(false);

    await pool.query(`UPDATE service_agreements SET ends_on = $2 WHERE id = $1`, [waitingAgreement, daysAhead(385)]);
    expect(await check(waitingAgreement, waiting)).toBe(true);

    const switched = await seedCustomer('TurnedOnAutoRenew');
    const switchedAgreement = await seedAgreement(switched);
    await pool.query(`UPDATE service_agreements SET auto_renew = true, renewal_term_months = 12 WHERE id = $1`, [switchedAgreement]);
    expect(await check(switchedAgreement, switched)).toBe(true);

    const replaced = await seedCustomer('NewMembership');
    const oldAgreement = await seedAgreement(replaced);
    await seedAgreement(replaced, { endsOn: daysAhead(385), createdAt: now });
    expect(await check(oldAgreement, replaced)).toBe(true);

    const lapsedOut = await seedCustomer('Cancelled');
    const lapsedAgreement = await seedAgreement(lapsedOut, { status: 'cancelled', endsOn: daysAhead(385) });
    expect(await check(lapsedAgreement, lapsedOut)).toBe(false);
  });

  it('detects a booking after a date (ignoring cancelled) and a customer reply', async () => {
    const customerId = await seedCustomer('Booker');
    const jobId = await seedJob(customerId, 'new', daysAgo(1));
    const cancelled = randomUUID();
    const booked = randomUUID();
    const insertAppt = (id: string, status: string, createdAt: Date) =>
      pool.query(
        `INSERT INTO appointments (id, tenant_id, job_id, scheduled_start, scheduled_end, timezone, status, created_by, created_at)
         VALUES ($1, $2, $3, NOW() + interval '2 days', NOW() + interval '2 days 1 hour', 'America/Chicago', $4, $5, $6)`,
        [id, tenant.tenantId, jobId, status, tenant.userId, createdAt],
      );
    await insertAppt(cancelled, 'canceled', daysAgo(0.5));
    expect(await signals.findBookingSince(tenant.tenantId, customerId, daysAgo(2))).toBeNull();
    await insertAppt(booked, 'scheduled', daysAgo(0.25));
    expect((await signals.findBookingSince(tenant.tenantId, customerId, daysAgo(2)))?.appointmentId).toBe(booked);
    expect(await signals.findBookingSince(tenant.tenantId, customerId, now)).toBeNull();

    const conversationId = randomUUID();
    await pool.query(
      `INSERT INTO conversations (id, tenant_id, entity_type, entity_id, created_by) VALUES ($1, $2, 'customer', $3, $4)`,
      [conversationId, tenant.tenantId, customerId, tenant.userId],
    );
    expect(await signals.hasRepliedSince(tenant.tenantId, customerId, daysAgo(1))).toBe(false);
    await pool.query(
      `INSERT INTO messages (tenant_id, conversation_id, message_type, content, sender_id, sender_role, source)
       VALUES ($1, $2, 'text', 'yes please', 'cust', 'customer', 'sms')`,
      [tenant.tenantId, conversationId],
    );
    expect(await signals.hasRepliedSince(tenant.tenantId, customerId, daysAgo(1))).toBe(true);
  });

  it('isolates tenants', async () => {
    const other = await createTestTenant(pool);
    const seq = await repo.createSequence(sequence());
    expect(await repo.findSequence(other.tenantId, seq.id)).toBeNull();
    expect(await repo.listSequences(other.tenantId)).toEqual([]);
  });
});

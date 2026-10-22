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
describe('Postgres integration — drip campaigns (migrations 336/337)', () => {
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

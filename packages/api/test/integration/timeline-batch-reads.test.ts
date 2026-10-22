/**
 * Docker-gated integration test — the batched job-scoped reads behind the
 * customer timeline (no N+1):
 *   PgJobTimelineRepository.findByJobs   job_timeline_events.job_id = ANY($2::uuid[])
 *   PgAppointmentRepository.findByJobs   appointments.job_id = ANY($2::uuid[])
 *   PgConversationRepository.findByEntities  conversations.entity_id = ANY($3::text[])
 *
 * Pins the real columns/casts against migrated Postgres (CLAUDE.md: a mocked
 * Pool is never the only proof a query works), their tenant scoping, ordering,
 * the empty-list short-circuit, and getCustomerTimeline end-to-end over the
 * Pg repos (including the existing estimate/invoice findByJobs and the
 * estimate soft-delete filter).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb, type TestTenant } from './shared';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { PgJobTimelineRepository } from '../../src/jobs/pg-job-lifecycle';
import { PgAppointmentRepository } from '../../src/appointments/pg-appointment';
import { PgConversationRepository } from '../../src/conversations/pg-conversation';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgLocationRepository } from '../../src/locations/pg-location';
import { PgEstimateRepository } from '../../src/estimates/pg-estimate';
import { PgInvoiceRepository } from '../../src/invoices/pg-invoice';
import { PgPaymentRepository } from '../../src/invoices/pg-payment';
import { PgNoteRepository } from '../../src/notes/pg-note';
import { getCustomerTimeline } from '../../src/customers/timeline-service';
import type { Estimate } from '../../src/estimates/estimate';
import type { Invoice } from '../../src/invoices/invoice';

describe('Postgres integration — batched timeline reads (findByJobs / findByEntities)', () => {
  let pool: Pool;
  let jobRepo: PgJobRepository;
  let timelineRepo: PgJobTimelineRepository;
  let appointmentRepo: PgAppointmentRepository;
  let conversationRepo: PgConversationRepository;
  let estimateRepo: PgEstimateRepository;
  let invoiceRepo: PgInvoiceRepository;

  let tenant: TestTenant;
  let other: TestTenant;
  let customerId: string;
  let jobA: string;
  let jobB: string;
  let jobC: string; // same tenant + customer, never requested in the direct-method tests
  let otherJob: string; // another tenant's job

  async function seedCustomer(t: TestTenant): Promise<{ customerId: string; locationId: string }> {
    const cid = crypto.randomUUID();
    await new PgCustomerRepository(pool).create({
      id: cid,
      tenantId: t.tenantId,
      firstName: 'Batch',
      lastName: 'Customer',
      displayName: 'Batch Customer',
      preferredChannel: 'phone',
      smsConsent: false,
      isArchived: false,
      createdBy: t.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const lid = crypto.randomUUID();
    await new PgLocationRepository(pool).create({
      id: lid,
      tenantId: t.tenantId,
      customerId: cid,
      addressType: 'service',
      street1: '1 Batch St',
      city: 'Austin',
      state: 'TX',
      postalCode: '78701',
      country: 'USA',
      isPrimary: true,
      isArchived: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return { customerId: cid, locationId: lid };
  }

  async function seedJob(t: TestTenant, cid: string, lid: string, n: string): Promise<string> {
    const id = crypto.randomUUID();
    await jobRepo.create({
      id,
      tenantId: t.tenantId,
      customerId: cid,
      locationId: lid,
      jobNumber: `JOB-${n}`,
      summary: `Job ${n}`,
      status: 'scheduled',
      priority: 'normal',
      createdBy: t.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return id;
  }

  async function seedTimeline(t: TestTenant, jobId: string, at: string, description: string) {
    await timelineRepo.create({
      id: crypto.randomUUID(),
      tenantId: t.tenantId,
      jobId,
      eventType: 'status_change',
      fromStatus: 'new',
      toStatus: 'scheduled',
      description,
      actorId: t.userId,
      actorRole: 'owner',
      createdAt: new Date(at),
    });
  }

  async function seedAppointment(t: TestTenant, jobId: string, start: string) {
    const s = new Date(start);
    await appointmentRepo.create({
      id: crypto.randomUUID(),
      tenantId: t.tenantId,
      jobId,
      scheduledStart: s,
      scheduledEnd: new Date(s.getTime() + 3_600_000),
      timezone: 'America/Chicago',
      status: 'scheduled',
      holdPendingApproval: false,
      createdBy: t.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  async function seedConversation(t: TestTenant, entityType: string, entityId: string, at: string, title: string) {
    const c = await conversationRepo.createConversation({
      tenantId: t.tenantId,
      entityType,
      entityId,
      title,
      createdBy: t.userId,
    });
    // Fixed timestamps so the created_at DESC ordering is deterministic.
    await pool.query('UPDATE conversations SET created_at = $1 WHERE id = $2', [new Date(at), c.id]);
    return c.id;
  }

  function estimate(t: TestTenant, jobId: string, n: string, createdAt: string): Estimate {
    return {
      id: crypto.randomUUID(),
      tenantId: t.tenantId,
      jobId,
      estimateNumber: `EST-${n}`,
      status: 'sent',
      version: 1,
      lineItems: [],
      totals: { subtotalCents: 1000, taxableSubtotalCents: 1000, discountCents: 0, taxRateBps: 0, taxCents: 0, totalCents: 1000 },
      sentAt: new Date(createdAt),
      createdBy: t.userId,
      createdAt: new Date(createdAt),
      updatedAt: new Date(createdAt),
    };
  }

  function invoice(t: TestTenant, jobId: string, n: string, createdAt: string): Invoice {
    return {
      id: crypto.randomUUID(),
      tenantId: t.tenantId,
      jobId,
      invoiceNumber: `INV-${n}`,
      status: 'open',
      lineItems: [],
      totals: { subtotalCents: 500, taxableSubtotalCents: 500, discountCents: 0, taxRateBps: 0, taxCents: 0, totalCents: 500 },
      amountPaidCents: 0,
      amountDueCents: 500,
      sentAt: new Date(createdAt),
      createdBy: t.userId,
      createdAt: new Date(createdAt),
      updatedAt: new Date(createdAt),
    };
  }

  beforeAll(async () => {
    pool = await getSharedTestDb();
    jobRepo = new PgJobRepository(pool);
    timelineRepo = new PgJobTimelineRepository(pool);
    appointmentRepo = new PgAppointmentRepository(pool);
    conversationRepo = new PgConversationRepository(pool);
    estimateRepo = new PgEstimateRepository(pool);
    invoiceRepo = new PgInvoiceRepository(pool);

    tenant = await createTestTenant(pool);
    other = await createTestTenant(pool);
    const mine = await seedCustomer(tenant);
    customerId = mine.customerId;
    const theirs = await seedCustomer(other);

    jobA = await seedJob(tenant, mine.customerId, mine.locationId, 'A');
    jobB = await seedJob(tenant, mine.customerId, mine.locationId, 'B');
    jobC = await seedJob(tenant, mine.customerId, mine.locationId, 'C');
    otherJob = await seedJob(other, theirs.customerId, theirs.locationId, 'X');

    // Timeline entries, deliberately interleaved across jobs in time.
    await seedTimeline(tenant, jobB, '2026-06-01T10:00:00Z', 'B-1');
    await seedTimeline(tenant, jobA, '2026-06-01T09:00:00Z', 'A-1');
    await seedTimeline(tenant, jobA, '2026-06-01T11:00:00Z', 'A-2');
    await seedTimeline(tenant, jobC, '2026-06-01T08:00:00Z', 'C-1');
    await seedTimeline(other, otherJob, '2026-06-01T07:00:00Z', 'X-1');

    await seedAppointment(tenant, jobA, '2026-07-03T15:00:00Z');
    await seedAppointment(tenant, jobB, '2026-07-01T15:00:00Z');
    await seedAppointment(tenant, jobA, '2026-07-02T15:00:00Z');
    await seedAppointment(tenant, jobC, '2026-06-30T15:00:00Z');
    await seedAppointment(other, otherJob, '2026-06-29T15:00:00Z');

    await seedConversation(tenant, 'job', jobA, '2026-06-02T09:00:00Z', 'conv-A-old');
    await seedConversation(tenant, 'job', jobB, '2026-06-02T10:00:00Z', 'conv-B');
    await seedConversation(tenant, 'job', jobA, '2026-06-02T11:00:00Z', 'conv-A-new');
    await seedConversation(tenant, 'job', jobC, '2026-06-02T12:00:00Z', 'conv-C');
    // Same entity id under a different entity_type must not match.
    await seedConversation(tenant, 'estimate', jobA, '2026-06-02T13:00:00Z', 'conv-wrong-type');
    await seedConversation(tenant, 'customer', customerId, '2026-06-02T14:00:00Z', 'conv-customer');
    await seedConversation(other, 'job', otherJob, '2026-06-02T15:00:00Z', 'conv-X');
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  describe('PgJobTimelineRepository.findByJobs', () => {
    it('returns only the requested jobs, tenant-scoped, ordered created_at ASC', async () => {
      const rows = await timelineRepo.findByJobs(tenant.tenantId, [jobA, jobB, otherJob]);
      expect(rows.map((r) => r.description)).toEqual(['A-1', 'B-1', 'A-2']);
      expect(rows.every((r) => r.tenantId === tenant.tenantId)).toBe(true);
    });

    it('matches findByJob per job (same rows, same order)', async () => {
      const batch = await timelineRepo.findByJobs(tenant.tenantId, [jobA, jobB, jobC]);
      for (const id of [jobA, jobB, jobC]) {
        expect(batch.filter((r) => r.jobId === id)).toEqual(await timelineRepo.findByJob(tenant.tenantId, id));
      }
    });

    it('returns [] for an empty id list and another tenant sees nothing', async () => {
      expect(await timelineRepo.findByJobs(tenant.tenantId, [])).toEqual([]);
      expect(await timelineRepo.findByJobs(other.tenantId, [jobA, jobB])).toEqual([]);
    });
  });

  describe('PgAppointmentRepository.findByJobs', () => {
    it('returns only the requested jobs, tenant-scoped, ordered scheduled_start ASC', async () => {
      const rows = await appointmentRepo.findByJobs(tenant.tenantId, [jobA, jobB, otherJob]);
      expect(rows.map((r) => [r.jobId, r.scheduledStart.toISOString()])).toEqual([
        [jobB, '2026-07-01T15:00:00.000Z'],
        [jobA, '2026-07-02T15:00:00.000Z'],
        [jobA, '2026-07-03T15:00:00.000Z'],
      ]);
    });

    it('matches findByJob per job', async () => {
      const batch = await appointmentRepo.findByJobs(tenant.tenantId, [jobA, jobB, jobC]);
      for (const id of [jobA, jobB, jobC]) {
        expect(batch.filter((r) => r.jobId === id)).toEqual(await appointmentRepo.findByJob(tenant.tenantId, id));
      }
    });

    it('skips non-UUID ids instead of raising 22P02, and returns [] for an empty list', async () => {
      const rows = await appointmentRepo.findByJobs(tenant.tenantId, ['not-a-uuid', jobB]);
      expect(rows.map((r) => r.jobId)).toEqual([jobB]);
      expect(await appointmentRepo.findByJobs(tenant.tenantId, ['not-a-uuid'])).toEqual([]);
      expect(await appointmentRepo.findByJobs(tenant.tenantId, [])).toEqual([]);
    });
  });

  describe('PgConversationRepository.findByEntities', () => {
    it('filters by entity_type + text entity ids, tenant-scoped, ordered created_at DESC', async () => {
      const rows = await conversationRepo.findByEntities(tenant.tenantId, 'job', [jobA, jobB, otherJob]);
      expect(rows.map((r) => r.title)).toEqual(['conv-A-new', 'conv-B', 'conv-A-old']);
    });

    it('matches findByEntity per entity', async () => {
      const batch = await conversationRepo.findByEntities(tenant.tenantId, 'job', [jobA, jobB, jobC]);
      for (const id of [jobA, jobB, jobC]) {
        expect(batch.filter((r) => r.entityId === id)).toEqual(
          await conversationRepo.findByEntity(tenant.tenantId, 'job', id),
        );
      }
    });

    it('accepts non-UUID text ids (entity_id is TEXT) and returns [] for an empty list', async () => {
      expect(await conversationRepo.findByEntities(tenant.tenantId, 'job', ['not-a-uuid'])).toEqual([]);
      expect(await conversationRepo.findByEntities(tenant.tenantId, 'job', [])).toEqual([]);
      expect(await conversationRepo.findByEntities(other.tenantId, 'job', [jobA])).toEqual([]);
    });
  });

  it('getCustomerTimeline over the Pg repos returns every job-scoped source exactly once', async () => {
    await estimateRepo.create(estimate(tenant, jobA, 'A1', '2026-06-05T09:00:00Z'));
    await estimateRepo.create(estimate(tenant, jobB, 'B1', '2026-06-05T10:00:00Z'));
    const deleted = await estimateRepo.create(estimate(tenant, jobC, 'C1', '2026-06-05T11:00:00Z'));
    await pool.query('UPDATE estimates SET deleted_at = NOW() WHERE id = $1', [deleted.id]);
    const inv = await invoiceRepo.create(invoice(tenant, jobB, 'B1', '2026-06-06T09:00:00Z'));
    // create() does not persist sent_at; mark it sent so it yields an event.
    await pool.query('UPDATE invoices SET sent_at = $1 WHERE id = $2', [new Date('2026-06-06T09:00:00Z'), inv.id]);

    const result = await getCustomerTimeline(
      tenant.tenantId,
      customerId,
      {
        noteRepo: new PgNoteRepository(pool),
        jobRepo,
        jobTimelineRepo: timelineRepo,
        estimateRepo,
        invoiceRepo,
        paymentRepo: new PgPaymentRepository(pool),
        conversationRepo,
        appointmentRepo,
      },
      { limit: 200 },
    );

    const count = (kind: string) => result.events.filter((e) => e.kind === kind).length;
    expect(count('job_created')).toBe(3);
    expect(count('job_status_changed')).toBe(4); // A-1, A-2, B-1, C-1 — not X-1
    expect(count('appointment_scheduled')).toBe(4);
    expect(count('estimate_sent')).toBe(2); // soft-deleted C1 excluded
    expect(count('invoice_sent')).toBe(1);
    expect(result.events.some((e) => e.sourceEntityId === otherJob)).toBe(false);
    const times = result.events.map((e) => e.occurredAt.getTime());
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });
});

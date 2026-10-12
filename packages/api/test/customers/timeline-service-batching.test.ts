/**
 * getCustomerTimeline reads every job-scoped source with ONE batched call
 * (findByJobs / findByEntities) instead of one call per job, and produces
 * exactly the output the old per-job loop did.
 *
 * The "reference" deps answer the batch methods by looping the per-job
 * methods in job order (the old algorithm's row order); the "interleaved"
 * deps return the same rows with jobs reversed and rows interleaved across
 * jobs (each job's own rows keep their repo order), as a DB
 * `ORDER BY created_at` over `job_id = ANY(...)` may. Both must yield
 * identical timelines.
 */
import { describe, it, expect, vi } from 'vitest';
import { getCustomerTimeline, type CustomerTimelineDeps } from '../../src/customers/timeline-service';
import { InMemoryNoteRepository } from '../../src/notes/note';
import { InMemoryJobRepository, createJob } from '../../src/jobs/job';
import { InMemoryJobTimelineRepository, transitionJobStatus } from '../../src/jobs/job-lifecycle';
import { InMemoryEstimateRepository, type Estimate } from '../../src/estimates/estimate';
import { InMemoryInvoiceRepository, type Invoice } from '../../src/invoices/invoice';
import { InMemoryPaymentRepository } from '../../src/invoices/payment';
import { InMemoryConversationRepository } from '../../src/conversations/conversation-service';
import { InMemoryAppointmentRepository, createAppointment } from '../../src/appointments/appointment';

const TENANT = 'tenant-batch';
const CUSTOMER = 'customer-batch';

async function seedStores() {
  const stores = {
    noteRepo: new InMemoryNoteRepository(),
    jobRepo: new InMemoryJobRepository(),
    jobTimelineRepo: new InMemoryJobTimelineRepository(),
    estimateRepo: new InMemoryEstimateRepository(),
    invoiceRepo: new InMemoryInvoiceRepository(),
    paymentRepo: new InMemoryPaymentRepository(),
    conversationRepo: new InMemoryConversationRepository(),
    appointmentRepo: new InMemoryAppointmentRepository(),
  };

  const jobIds: string[] = [];
  for (let i = 0; i < 3; i++) {
    const job = await createJob(
      { tenantId: TENANT, customerId: CUSTOMER, locationId: 'loc-1', summary: `Job ${i}`, createdBy: 'u1' },
      stores.jobRepo,
    );
    jobIds.push(job.id);
    await transitionJobStatus(TENANT, job.id, 'scheduled', 'u1', 'owner', stores.jobRepo, stores.jobTimelineRepo);

    // Two estimates per job — one sharing a timestamp across jobs to exercise tie order.
    for (let k = 0; k < 2; k++) {
      await stores.estimateRepo.create({
        id: `est-${i}-${k}`,
        tenantId: TENANT,
        jobId: job.id,
        estimateNumber: `EST-${i}${k}`,
        status: 'sent',
        version: 1,
        lineItems: [],
        totals: { subtotalCents: 1000, discountCents: 0, taxCents: 0, totalCents: 1000 } as Estimate['totals'],
        sentAt: new Date(`2026-04-0${k + 2}T10:00:00Z`),
        createdBy: 'u1',
        createdAt: new Date(`2026-04-01T1${i}:00:00Z`),
        updatedAt: new Date(`2026-04-0${k + 2}T10:00:00Z`),
      });
    }
    await stores.invoiceRepo.create({
      id: `inv-${i}`,
      tenantId: TENANT,
      jobId: job.id,
      invoiceNumber: `INV-${i}`,
      status: 'open',
      lineItems: [],
      totals: { subtotalCents: 500, discountCents: 0, taxCents: 0, totalCents: 500 } as Invoice['totals'],
      amountPaidCents: 0,
      amountDueCents: 500,
      sentAt: new Date(`2026-04-1${i}T09:00:00Z`),
      createdBy: 'u1',
      createdAt: new Date(`2026-04-1${i}T08:00:00Z`),
      updatedAt: new Date(`2026-04-1${i}T09:00:00Z`),
    });
    await createAppointment(
      {
        tenantId: TENANT,
        jobId: job.id,
        scheduledStart: new Date(`2026-05-0${i + 1}T10:00:00Z`),
        scheduledEnd: new Date(`2026-05-0${i + 1}T12:00:00Z`),
        timezone: 'America/Los_Angeles',
        createdBy: 'u1',
      },
      stores.appointmentRepo,
    );
    const convo = await stores.conversationRepo.createConversation({
      tenantId: TENANT,
      entityType: 'job',
      entityId: job.id,
      createdBy: 'u1',
    });
    await stores.conversationRepo.addMessage({
      tenantId: TENANT,
      conversationId: convo.id,
      messageType: 'text',
      content: `About job ${i}`,
      senderId: 'cust-1',
      senderRole: 'customer',
      source: 'sms',
      metadata: { direction: 'inbound', channel: 'sms' },
    });
  }

  // Another customer's job — its rows must never appear.
  const other = await createJob(
    { tenantId: TENANT, customerId: 'someone-else', locationId: 'loc-2', summary: 'Other', createdBy: 'u1' },
    stores.jobRepo,
  );
  await transitionJobStatus(TENANT, other.id, 'scheduled', 'u1', 'owner', stores.jobRepo, stores.jobTimelineRepo);

  return { stores, jobIds, otherJobId: other.id };
}

type Stores = Awaited<ReturnType<typeof seedStores>>['stores'];

/**
 * Deps whose batch methods are answered from the per-job methods. `reorder`
 * shapes the cross-job order of the batch result; the per-job methods are
 * spies so the test can prove the service never calls them.
 */
function buildDeps(stores: Stores, reorder: <T>(perJobLists: T[][]) => T[]) {
  const perJob = <T>(fn: (t: string, id: string) => Promise<T[]>) =>
    async (t: string, ids: string[]) =>
      reorder(await Promise.all(ids.map((id) => fn(t, id))));

  const s = stores;
  const spies = {
    jobTimelineFindByJob: vi.fn(s.jobTimelineRepo.findByJob.bind(s.jobTimelineRepo)),
    jobTimelineFindByJobs: vi.fn(perJob(s.jobTimelineRepo.findByJob.bind(s.jobTimelineRepo))),
    estimateFindByJob: vi.fn(s.estimateRepo.findByJob.bind(s.estimateRepo)),
    estimateFindByJobs: vi.fn(perJob(s.estimateRepo.findByJob.bind(s.estimateRepo))),
    invoiceFindByJob: vi.fn(s.invoiceRepo.findByJob.bind(s.invoiceRepo)),
    invoiceFindByJobs: vi.fn(perJob(s.invoiceRepo.findByJob.bind(s.invoiceRepo))),
    appointmentFindByJob: vi.fn(s.appointmentRepo.findByJob.bind(s.appointmentRepo)),
    appointmentFindByJobs: vi.fn(perJob(s.appointmentRepo.findByJob.bind(s.appointmentRepo))),
    conversationFindByEntity: vi.fn(s.conversationRepo.findByEntity.bind(s.conversationRepo)),
    conversationFindByEntities: vi.fn(async (t: string, type: string, ids: string[]) =>
      reorder(await Promise.all(ids.map((id) => s.conversationRepo.findByEntity(t, type, id)))),
    ),
  };

  const deps: CustomerTimelineDeps = {
    noteRepo: s.noteRepo,
    jobRepo: s.jobRepo,
    paymentRepo: s.paymentRepo,
    jobTimelineRepo: Object.assign(Object.create(s.jobTimelineRepo), {
      findByJob: spies.jobTimelineFindByJob,
      findByJobs: spies.jobTimelineFindByJobs,
    }),
    estimateRepo: Object.assign(Object.create(s.estimateRepo), {
      findByJob: spies.estimateFindByJob,
      findByJobs: spies.estimateFindByJobs,
    }),
    invoiceRepo: Object.assign(Object.create(s.invoiceRepo), {
      findByJob: spies.invoiceFindByJob,
      findByJobs: spies.invoiceFindByJobs,
    }),
    appointmentRepo: Object.assign(Object.create(s.appointmentRepo), {
      findByJob: spies.appointmentFindByJob,
      findByJobs: spies.appointmentFindByJobs,
    }),
    conversationRepo: Object.assign(Object.create(s.conversationRepo), {
      findByEntity: spies.conversationFindByEntity,
      findByEntities: spies.conversationFindByEntities,
    }),
  };
  return { deps, spies };
}

const inJobOrder = <T>(lists: T[][]): T[] => lists.flat();
/** Jobs reversed, rows round-robin across jobs; per-job relative order kept. */
const interleaved = <T>(lists: T[][]): T[] => {
  const queues = [...lists].reverse().map((l) => [...l]);
  const out: T[] = [];
  while (queues.some((q) => q.length > 0)) {
    for (const q of queues) {
      const next = q.shift();
      if (next !== undefined) out.push(next);
    }
  }
  return out;
};

describe('getCustomerTimeline — batched job-scoped reads', () => {
  it('issues ONE batched call per job-scoped source and never a per-job call', async () => {
    const { stores, jobIds } = await seedStores();
    const { deps, spies } = buildDeps(stores, interleaved);

    await getCustomerTimeline(TENANT, CUSTOMER, deps);

    for (const batch of [
      spies.jobTimelineFindByJobs,
      spies.estimateFindByJobs,
      spies.invoiceFindByJobs,
      spies.appointmentFindByJobs,
    ]) {
      expect(batch).toHaveBeenCalledTimes(1);
      expect(batch.mock.calls[0][0]).toBe(TENANT);
      expect([...batch.mock.calls[0][1]].sort()).toEqual([...jobIds].sort());
    }
    expect(spies.conversationFindByEntities).toHaveBeenCalledTimes(1);
    expect(spies.conversationFindByEntities.mock.calls[0][0]).toBe(TENANT);
    expect(spies.conversationFindByEntities.mock.calls[0][1]).toBe('job');
    expect([...spies.conversationFindByEntities.mock.calls[0][2]].sort()).toEqual([...jobIds].sort());

    expect(spies.jobTimelineFindByJob).not.toHaveBeenCalled();
    expect(spies.estimateFindByJob).not.toHaveBeenCalled();
    expect(spies.invoiceFindByJob).not.toHaveBeenCalled();
    expect(spies.appointmentFindByJob).not.toHaveBeenCalled();
    // Only the customer-level lookup remains on the per-entity method.
    expect(spies.conversationFindByEntity).toHaveBeenCalledTimes(1);
    expect(spies.conversationFindByEntity).toHaveBeenCalledWith(TENANT, 'customer', CUSTOMER);
  });

  it('produces the same timeline as the per-job loop, whatever cross-job order the batch returns', async () => {
    const { stores, jobIds, otherJobId } = await seedStores();
    const reference = await getCustomerTimeline(TENANT, CUSTOMER, buildDeps(stores, inJobOrder).deps, { limit: 200 });
    const shuffled = await getCustomerTimeline(TENANT, CUSTOMER, buildDeps(stores, interleaved).deps, { limit: 200 });

    expect(shuffled).toEqual(reference);
    // Sanity: every job contributed and the other customer's job did not.
    const kinds = new Set(reference.events.map((e) => e.kind));
    for (const k of ['job_created', 'job_status_changed', 'estimate_sent', 'invoice_sent', 'sms_received', 'appointment_scheduled']) {
      expect(kinds.has(k as never)).toBe(true);
    }
    expect(reference.events.filter((e) => e.kind === 'job_created')).toHaveLength(jobIds.length);
    expect(reference.events.some((e) => e.sourceEntityId === otherJobId)).toBe(false);

    // Paged reads agree too.
    const refPage = await getCustomerTimeline(TENANT, CUSTOMER, buildDeps(stores, inJobOrder).deps, { limit: 5 });
    const shufPage = await getCustomerTimeline(TENANT, CUSTOMER, buildDeps(stores, interleaved).deps, { limit: 5 });
    expect(shufPage).toEqual(refPage);
  });

  it('passes an empty id list for a customer with no jobs and returns an empty timeline', async () => {
    const { stores } = await seedStores();
    const { deps, spies } = buildDeps(stores, inJobOrder);

    const result = await getCustomerTimeline(TENANT, 'customer-without-jobs', deps);

    expect(result).toEqual({ events: [], nextCursor: null });
    expect(spies.estimateFindByJobs).toHaveBeenCalledWith(TENANT, []);
    expect(spies.conversationFindByEntities).toHaveBeenCalledWith(TENANT, 'job', []);
  });
});

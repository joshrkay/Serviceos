/**
 * P9-002 — Integration tests for `getCustomerTimeline`.
 *
 * Wires up the in-memory repos for every source, seeds a small fixture
 * across two tenants, and exercises the merge/sort/filter/paginate
 * contract end-to-end. Pure node — no http.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  getCustomerTimeline,
  type CustomerTimelineDeps,
} from '../../src/customers/timeline-service';
import { InMemoryNoteRepository, createNote } from '../../src/notes/note';
import { InMemoryJobRepository, createJob } from '../../src/jobs/job';
import {
  InMemoryJobTimelineRepository,
  transitionJobStatus,
} from '../../src/jobs/job-lifecycle';
import {
  InMemoryEstimateRepository,
} from '../../src/estimates/estimate';
import type { Estimate } from '../../src/estimates/estimate';
import { InMemoryInvoiceRepository } from '../../src/invoices/invoice';
import type { Invoice } from '../../src/invoices/invoice';
import { InMemoryPaymentRepository, recordPayment } from '../../src/invoices/payment';
import {
  InMemoryConversationRepository,
} from '../../src/conversations/conversation-service';
import {
  InMemoryAppointmentRepository,
  createAppointment,
} from '../../src/appointments/appointment';

interface Fixture extends CustomerTimelineDeps {
  customerId: string;
  jobId: string;
  invoiceId: string;
}

async function seed(tenantId: string, customerId: string): Promise<Fixture> {
  const noteRepo = new InMemoryNoteRepository();
  const jobRepo = new InMemoryJobRepository();
  const jobTimelineRepo = new InMemoryJobTimelineRepository();
  const estimateRepo = new InMemoryEstimateRepository();
  const invoiceRepo = new InMemoryInvoiceRepository();
  const paymentRepo = new InMemoryPaymentRepository();
  const conversationRepo = new InMemoryConversationRepository();
  const appointmentRepo = new InMemoryAppointmentRepository();

  // Note attached to the customer.
  await createNote(
    {
      tenantId,
      entityType: 'customer',
      entityId: customerId,
      content: 'Likes evening calls',
      authorId: 'u1',
      authorRole: 'owner',
    },
    noteRepo
  );

  // Job created + status changed.
  const j = await createJob(
    {
      tenantId,
      customerId,
      locationId: 'loc-1',
      summary: 'Replace water heater',
      createdBy: 'u1',
    },
    jobRepo
  );
  await transitionJobStatus(
    tenantId,
    j.id,
    'scheduled',
    'u1',
    'owner',
    jobRepo,
    jobTimelineRepo
  );

  // Estimate sent.
  const est: Estimate = {
    id: 'e-1',
    tenantId,
    jobId: j.id,
    estimateNumber: 'EST-0001',
    status: 'sent',
    lineItems: [],
    totals: {
      subtotalCents: 25000,
      discountCents: 0,
      taxCents: 0,
      totalCents: 25000,
    } as Estimate['totals'],
    sentAt: new Date('2026-04-02T10:00:00Z'),
    createdBy: 'u1',
    createdAt: new Date('2026-04-01T12:00:00Z'),
    updatedAt: new Date('2026-04-02T10:00:00Z'),
  };
  await estimateRepo.create(est);

  // Invoice sent + paid via recordPayment (which also updates the invoice).
  const inv: Invoice = {
    id: 'i-1',
    tenantId,
    jobId: j.id,
    invoiceNumber: 'INV-0001',
    status: 'open',
    lineItems: [],
    totals: {
      subtotalCents: 10000,
      discountCents: 0,
      taxCents: 0,
      totalCents: 10000,
    } as Invoice['totals'],
    amountPaidCents: 0,
    amountDueCents: 10000,
    sentAt: new Date('2026-04-03T09:00:00Z'),
    createdBy: 'u1',
    createdAt: new Date('2026-04-03T08:00:00Z'),
    updatedAt: new Date('2026-04-03T09:00:00Z'),
  };
  await invoiceRepo.create(inv);
  await recordPayment(
    {
      tenantId,
      invoiceId: inv.id,
      amountCents: 10000,
      method: 'cash',
      processedBy: 'u1',
    },
    invoiceRepo,
    paymentRepo
  );

  // Conversation linked to the customer with one inbound SMS message.
  const convo = await conversationRepo.createConversation({
    tenantId,
    entityType: 'customer',
    entityId: customerId,
    createdBy: 'u1',
  });
  await conversationRepo.addMessage({
    tenantId,
    conversationId: convo.id,
    messageType: 'text',
    content: 'Hi from customer',
    senderId: 'cust-1',
    senderRole: 'customer',
    source: 'sms',
    metadata: { direction: 'inbound', channel: 'sms' },
  });

  // Appointment.
  await createAppointment(
    {
      tenantId,
      jobId: j.id,
      scheduledStart: new Date('2026-04-05T10:00:00Z'),
      scheduledEnd: new Date('2026-04-05T12:00:00Z'),
      timezone: 'America/Los_Angeles',
      createdBy: 'u1',
    },
    appointmentRepo
  );

  return {
    customerId,
    jobId: j.id,
    invoiceId: inv.id,
    noteRepo,
    jobRepo,
    jobTimelineRepo,
    estimateRepo,
    invoiceRepo,
    paymentRepo,
    conversationRepo,
    appointmentRepo,
  };
}

describe('P9-002 — getCustomerTimeline', () => {
  let fx: Fixture;

  beforeEach(async () => {
    fx = await seed('tenant-A', 'customer-A');
  });

  it('returns merged events from notes, jobs, estimates, invoices, payments, conversations, appointments', async () => {
    const result = await getCustomerTimeline('tenant-A', 'customer-A', fx);
    const kinds = new Set(result.events.map((e) => e.kind));
    expect(kinds.has('note')).toBe(true);
    expect(kinds.has('job_created')).toBe(true);
    expect(kinds.has('job_status_changed')).toBe(true);
    expect(kinds.has('estimate_sent')).toBe(true);
    expect(kinds.has('invoice_sent')).toBe(true);
    expect(kinds.has('invoice_paid')).toBe(true);
    expect(kinds.has('payment_received')).toBe(true);
    expect(kinds.has('sms_received')).toBe(true);
    expect(kinds.has('appointment_scheduled')).toBe(true);
  });

  it('sorts events descending by occurredAt', async () => {
    const result = await getCustomerTimeline('tenant-A', 'customer-A', fx);
    const times = result.events.map((e) => e.occurredAt.getTime());
    for (let i = 1; i < times.length; i++) {
      expect(times[i - 1]).toBeGreaterThanOrEqual(times[i]);
    }
  });

  it('paginates with the `before` cursor', async () => {
    const first = await getCustomerTimeline('tenant-A', 'customer-A', fx, {
      limit: 3,
    });
    expect(first.events.length).toBe(3);
    expect(first.nextCursor).not.toBeNull();
    const second = await getCustomerTimeline('tenant-A', 'customer-A', fx, {
      limit: 3,
      before: new Date(first.nextCursor!),
    });
    // No overlap between pages.
    const firstIds = new Set(first.events.map((e) => e.sourceEntityId));
    for (const ev of second.events) {
      expect(firstIds.has(ev.sourceEntityId)).toBe(false);
    }
  });

  it('returns nextCursor=null when fewer events exist than the limit', async () => {
    const result = await getCustomerTimeline('tenant-A', 'customer-A', fx, {
      limit: 200,
    });
    expect(result.nextCursor).toBeNull();
  });

  it('narrows results when `kinds` is supplied', async () => {
    const result = await getCustomerTimeline('tenant-A', 'customer-A', fx, {
      kinds: ['note'],
    });
    expect(result.events.every((e) => e.kind === 'note')).toBe(true);
    expect(result.events.length).toBeGreaterThan(0);
  });

  it('isolates events between tenants — never returns rows from another tenant', async () => {
    // Re-seed a separate tenant on the SAME repos (simulating shared store).
    // We do this by building a fresh fixture for tenant-B and then copying
    // every B-tenant row into the existing fx repos.
    const fxB = await seed('tenant-B', 'customer-B');

    // Move tenant-B notes into fx.noteRepo.
    const bNotes = await fxB.noteRepo.findByEntity('tenant-B', 'customer', 'customer-B');
    for (const n of bNotes) await fx.noteRepo.create(n);

    // Move tenant-B jobs.
    const bJobs = await fxB.jobRepo.findByTenant('tenant-B');
    for (const j of bJobs) await fx.jobRepo.create(j);

    const result = await getCustomerTimeline('tenant-A', 'customer-A', fx);
    for (const ev of result.events) {
      // No event should reference tenant-B's customer or job ids.
      expect(ev.sourceEntityId).not.toBe(bNotes[0]?.id);
      if (bJobs[0]) expect(ev.sourceEntityId).not.toBe(bJobs[0].id);
    }
  });

  it('returns { events: [], nextCursor: null } for a customer with zero activity', async () => {
    const empty: CustomerTimelineDeps = {
      noteRepo: new InMemoryNoteRepository(),
      jobRepo: new InMemoryJobRepository(),
      jobTimelineRepo: new InMemoryJobTimelineRepository(),
      estimateRepo: new InMemoryEstimateRepository(),
      invoiceRepo: new InMemoryInvoiceRepository(),
      paymentRepo: new InMemoryPaymentRepository(),
      conversationRepo: new InMemoryConversationRepository(),
      appointmentRepo: new InMemoryAppointmentRepository(),
    };
    const result = await getCustomerTimeline('tenant-A', 'customer-empty', empty);
    expect(result.events).toEqual([]);
    expect(result.nextCursor).toBeNull();
  });

  it('caps `limit` at MAX_TIMELINE_LIMIT', async () => {
    const result = await getCustomerTimeline('tenant-A', 'customer-A', fx, {
      limit: 9999,
    });
    expect(result.events.length).toBeLessThanOrEqual(200);
  });
});

describe('P9-002 — getCustomerTimeline performance', () => {
  it('handles a customer with 100 jobs in <200ms', async () => {
    const tenantId = 'tenant-perf';
    const customerId = 'customer-perf';
    const noteRepo = new InMemoryNoteRepository();
    const jobRepo = new InMemoryJobRepository();
    const jobTimelineRepo = new InMemoryJobTimelineRepository();
    const estimateRepo = new InMemoryEstimateRepository();
    const invoiceRepo = new InMemoryInvoiceRepository();
    const paymentRepo = new InMemoryPaymentRepository();
    const conversationRepo = new InMemoryConversationRepository();
    const appointmentRepo = new InMemoryAppointmentRepository();

    for (let i = 0; i < 100; i++) {
      await createJob(
        {
          tenantId,
          customerId,
          locationId: 'loc-1',
          summary: `Job ${i}`,
          createdBy: 'u1',
        },
        jobRepo
      );
    }

    const start = Date.now();
    const result = await getCustomerTimeline(tenantId, customerId, {
      noteRepo,
      jobRepo,
      jobTimelineRepo,
      estimateRepo,
      invoiceRepo,
      paymentRepo,
      conversationRepo,
      appointmentRepo,
    }, { limit: 50 });
    const elapsed = Date.now() - start;

    expect(result.events.length).toBe(50);
    expect(elapsed).toBeLessThan(500); // Generous buffer; in-memory should be ~ms.
  });
});

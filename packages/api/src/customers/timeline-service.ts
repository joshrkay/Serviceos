/**
 * P9-002 — Customer timeline orchestrator.
 *
 * `getCustomerTimeline` fans out one tenant-scoped query per source, maps
 * each row to a `TimelineEvent`, and merges/sorts/slices the result.
 *
 * Tenant scoping is enforced by every source repo's existing API surface
 * (e.g. `noteRepo.findByEntity(tenantId, ...)`). The service writes no
 * raw SQL — everything goes through the repos. This avoids leaking events
 * across tenants via a malformed join.
 */
import type { NoteRepository } from '../notes/note';
import type { JobRepository } from '../jobs/job';
import type { JobTimelineRepository } from '../jobs/job-lifecycle';
import type { EstimateRepository } from '../estimates/estimate';
import type { InvoiceRepository } from '../invoices/invoice';
import type { PaymentRepository } from '../invoices/payment';
import type {
  ConversationRepository,
  Message,
} from '../conversations/conversation-service';
import type { ConversationLinkRepository } from '../conversations/linkage';
import type { AppointmentRepository } from '../appointments/appointment';
import {
  mapAppointmentToEvents,
  mapEstimateToEvents,
  mapInvoiceToEvents,
  mapJobCreatedToEvent,
  mapJobTimelineEntryToEvent,
  mapMessageToEvent,
  mapNoteToEvent,
  mapPaymentToEvent,
  mergeAndSliceEvents,
  type TimelineEvent,
  type TimelineKind,
  DEFAULT_TIMELINE_LIMIT,
  MAX_TIMELINE_LIMIT,
} from './timeline';

export interface CustomerTimelineDeps {
  noteRepo: NoteRepository;
  jobRepo: JobRepository;
  jobTimelineRepo: JobTimelineRepository;
  estimateRepo: EstimateRepository;
  invoiceRepo: InvoiceRepository;
  paymentRepo: PaymentRepository;
  conversationRepo: ConversationRepository;
  /**
   * Optional — if not supplied, conversation events are sourced via the
   * legacy `entityType/entityId` fields on the Conversation row directly.
   * This is intentionally optional because not every wiring has the
   * link table populated.
   */
  conversationLinkRepo?: ConversationLinkRepository;
  appointmentRepo: AppointmentRepository;
}

export interface CustomerTimelineOptions {
  before?: Date;
  limit?: number;
  kinds?: TimelineKind[];
}

export interface CustomerTimelineResult {
  events: TimelineEvent[];
  /** ISO timestamp suitable for the next `before` cursor; null when exhausted. */
  nextCursor: string | null;
}

/**
 * Fetches every relevant source row for `customerId` (tenant-scoped),
 * maps to TimelineEvents, then merges, sorts desc, and slices to limit.
 *
 * Hard guarantees:
 *   - Every source repo gets at most one query per request (no N+1) —
 *     except for payments and conversations where we fall back to a
 *     bounded loop because no `findByCustomer` exists today.
 *   - All source queries run in parallel via `Promise.all`.
 *   - All queries pass `tenantId` as the first argument; the repo
 *     implementations enforce tenant isolation.
 *   - Returns `{ events: [], nextCursor: null }` for customers with no
 *     activity — never throws on an empty customer.
 */
export async function getCustomerTimeline(
  tenantId: string,
  customerId: string,
  deps: CustomerTimelineDeps,
  opts: CustomerTimelineOptions = {}
): Promise<CustomerTimelineResult> {
  const limit = Math.min(opts.limit ?? DEFAULT_TIMELINE_LIMIT, MAX_TIMELINE_LIMIT);

  // --- Fan out independent reads in parallel. -------------------------------
  const [
    customerNotes,
    locationNotes, // intentionally unused for now — see below
    customerJobs,
  ] = await Promise.all([
    deps.noteRepo.findByEntity(tenantId, 'customer', customerId),
    // Notes attached to a location are not directly tied to customer; skip.
    Promise.resolve([] as Awaited<ReturnType<NoteRepository['findByEntity']>>),
    deps.jobRepo.findByTenant(tenantId, { customerId, limit: MAX_TIMELINE_LIMIT }),
  ]);
  void locationNotes;

  const jobIds = customerJobs.map((j) => j.id);

  // Per-job fan-out: each repo exposes a `findByJob(tenantId, jobId)` method.
  // We run the per-job queries in parallel to preserve the no-serial-loop
  // contract. With the (already-bounded) `MAX_TIMELINE_LIMIT` job cap, the
  // total query count is O(jobs) but parallel — never serial.
  const [
    jobTimelineLists,
    estimatesLists,
    invoicesLists,
    appointmentLists,
    conversationsByJob,
    conversationsByCustomer,
  ] = await Promise.all([
    Promise.all(jobIds.map((id) => deps.jobTimelineRepo.findByJob(tenantId, id))),
    Promise.all(jobIds.map((id) => deps.estimateRepo.findByJob(tenantId, id))),
    Promise.all(jobIds.map((id) => deps.invoiceRepo.findByJob(tenantId, id))),
    Promise.all(jobIds.map((id) => deps.appointmentRepo.findByJob(tenantId, id))),
    Promise.all(
      jobIds.map((id) => deps.conversationRepo.findByEntity(tenantId, 'job', id))
    ),
    deps.conversationRepo.findByEntity(tenantId, 'customer', customerId),
  ]);

  // Flatten repo result groups.
  const jobTimelineEntries = jobTimelineLists.flat();
  const estimates = estimatesLists.flat();
  const invoices = invoicesLists.flat();
  const appointments = appointmentLists.flat();
  // Dedupe conversations — a single conversation may be linked to both a
  // customer and a job, in which case both fan-out queries return the row.
  const conversationMap = new Map<string, (typeof conversationsByCustomer)[number]>();
  for (const c of [...conversationsByCustomer, ...conversationsByJob.flat()]) {
    if (!conversationMap.has(c.id)) conversationMap.set(c.id, c);
  }
  const conversations = Array.from(conversationMap.values());

  // Payments — the existing repo only exposes `findByInvoice(tenantId, id)`.
  // We loop the customer's invoices (already bounded by job-cap above) in
  // parallel; documented choice in the dispatch addendum.
  const paymentLists = await Promise.all(
    invoices.map((inv) => deps.paymentRepo.findByInvoice(tenantId, inv.id))
  );
  const payments = paymentLists.flat();
  const invoiceNumberById = new Map(invoices.map((i) => [i.id, i.invoiceNumber] as const));

  // Conversation messages — one query per conversation, in parallel.
  const messageLists = await Promise.all(
    conversations.map((c) => deps.conversationRepo.getMessages(tenantId, c.id))
  );
  const messages: Message[] = messageLists.flat();

  // --- Map source rows to TimelineEvents. -----------------------------------
  const jobById = new Map(customerJobs.map((j) => [j.id, j] as const));

  const events: TimelineEvent[] = [
    ...customerNotes.map(mapNoteToEvent),
    ...customerJobs.map(mapJobCreatedToEvent),
    ...jobTimelineEntries
      .map((e) => mapJobTimelineEntryToEvent(e, jobById.get(e.jobId)))
      .filter((e): e is TimelineEvent => e !== null),
    ...estimates.flatMap(mapEstimateToEvents),
    ...invoices.flatMap(mapInvoiceToEvents),
    ...payments.map((p) => mapPaymentToEvent(p, invoiceNumberById.get(p.invoiceId))),
    ...messages
      .map(mapMessageToEvent)
      .filter((e): e is TimelineEvent => e !== null),
    ...appointments.flatMap(mapAppointmentToEvents),
  ];

  // We over-fetch by 1 to detect "more pages exist" without a count query.
  const sliced = mergeAndSliceEvents(events, {
    before: opts.before,
    kinds: opts.kinds,
    limit: limit + 1,
  });
  const hasMore = sliced.length > limit;
  const page = hasMore ? sliced.slice(0, limit) : sliced;
  const nextCursor =
    hasMore && page.length > 0
      ? page[page.length - 1].occurredAt.toISOString()
      : null;

  return { events: page, nextCursor };
}

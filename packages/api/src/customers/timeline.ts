/**
 * P9-002 — Unified customer communication timeline
 *
 * Read-only aggregator that merges activity from multiple existing tables
 * (notes, jobs, jobTimeline, estimates, invoices, payments, conversations,
 * appointments) into a single, chronologically-sorted feed for a customer.
 *
 * No schema changes — all data is pulled through the existing repositories
 * via their tenant-scoped methods. This file defines the public types,
 * the discriminated `TimelineEvent` union, the Zod query schema, and the
 * pure mapper functions used by `timeline-service.ts`.
 */
import { z } from 'zod';
import type { InternalNote } from '../notes/note';
import type { Job } from '../jobs/job';
import type { JobTimelineEntry } from '../jobs/job-lifecycle';
import type { Estimate } from '../estimates/estimate';
import type { Invoice } from '../invoices/invoice';
import type { Payment } from '../invoices/payment';
import type { Message } from '../conversations/conversation-service';
import type { Appointment } from '../appointments/appointment';

/**
 * The complete set of timeline event kinds. New kinds may be added later
 * (e.g. `lead_created` once P9-001 lands) — this list is intentionally
 * exhaustive for the current Phase-9 surface.
 */
export type TimelineKind =
  | 'note'
  | 'job_created'
  | 'job_status_changed'
  | 'estimate_sent'
  | 'estimate_approved'
  | 'invoice_sent'
  | 'invoice_paid'
  | 'payment_received'
  | 'sms_sent'
  | 'sms_received'
  | 'call_inbound'
  | 'call_outbound'
  | 'email_sent'
  | 'email_received'
  | 'appointment_scheduled'
  | 'appointment_completed';

export const TIMELINE_KINDS: readonly TimelineKind[] = [
  'note',
  'job_created',
  'job_status_changed',
  'estimate_sent',
  'estimate_approved',
  'invoice_sent',
  'invoice_paid',
  'payment_received',
  'sms_sent',
  'sms_received',
  'call_inbound',
  'call_outbound',
  'email_sent',
  'email_received',
  'appointment_scheduled',
  'appointment_completed',
] as const;

export interface TimelineEvent {
  kind: TimelineKind;
  /** Wall-clock time the underlying activity occurred (UTC). */
  occurredAt: Date;
  /** Originating actor user-id, when an authenticated user drove the event. */
  actorUserId?: string;
  /** Short human-readable line for UI rendering. */
  summary: string;
  /** Free-form, source-shape-specific metadata (kept opaque to consumers). */
  metadata: Record<string, unknown>;
  /** ID of the underlying source row (note id, job id, etc.). */
  sourceEntityId: string;
  /** Source row type ('note', 'job', 'estimate', 'invoice', 'payment', 'message', 'appointment'). */
  sourceEntityType: string;
}

export const DEFAULT_TIMELINE_LIMIT = 50;
export const MAX_TIMELINE_LIMIT = 200;

/**
 * Zod schema for `GET /api/customers/:id/timeline` query params.
 *
 *   - `before`: ISO-8601 cursor; events with `occurredAt < before` only.
 *   - `limit`:  defaults to 50, hard-capped at 200.
 *   - `kinds`:  comma-separated kinds, validated against the union.
 */
export const timelineQuerySchema = z.object({
  before: z
    .string()
    .datetime({ offset: true })
    .optional()
    .transform((v) => (v ? new Date(v) : undefined)),
  limit: z
    .union([z.string(), z.number()])
    .optional()
    .transform((v) => {
      if (v === undefined) return DEFAULT_TIMELINE_LIMIT;
      const n = typeof v === 'number' ? v : parseInt(v, 10);
      if (!Number.isFinite(n) || n < 1) return DEFAULT_TIMELINE_LIMIT;
      return Math.min(n, MAX_TIMELINE_LIMIT);
    }),
  kinds: z
    .string()
    .optional()
    .transform((v) => {
      if (!v) return undefined;
      const parts = v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const valid = parts.filter((p): p is TimelineKind =>
        (TIMELINE_KINDS as readonly string[]).includes(p)
      );
      return valid.length > 0 ? valid : undefined;
    }),
});

export type TimelineQueryInput = z.infer<typeof timelineQuerySchema>;

// ---------------------------------------------------------------------------
// Pure mappers — one per source. Kept side-effect-free for trivial testing.
// ---------------------------------------------------------------------------

export function mapNoteToEvent(note: InternalNote): TimelineEvent {
  const preview = note.content.length > 120
    ? `${note.content.slice(0, 117)}...`
    : note.content;
  return {
    kind: 'note',
    occurredAt: note.createdAt,
    actorUserId: note.authorId,
    summary: preview,
    metadata: {
      isPinned: note.isPinned,
      authorRole: note.authorRole,
      entityType: note.entityType,
      entityId: note.entityId,
    },
    sourceEntityId: note.id,
    sourceEntityType: 'note',
  };
}

export function mapJobCreatedToEvent(job: Job): TimelineEvent {
  return {
    kind: 'job_created',
    occurredAt: job.createdAt,
    actorUserId: job.createdBy,
    summary: `Job ${job.jobNumber} created: ${job.summary}`,
    metadata: {
      jobNumber: job.jobNumber,
      status: job.status,
      priority: job.priority,
    },
    sourceEntityId: job.id,
    sourceEntityType: 'job',
  };
}

export function mapJobTimelineEntryToEvent(
  entry: JobTimelineEntry,
  job: Job | undefined
): TimelineEvent | null {
  // Only emit explicit status_change rows — other entry kinds (delay
  // acknowledgements, etc.) are job-internal and don't belong on the
  // customer-facing timeline.
  if (entry.eventType !== 'status_change') return null;
  return {
    kind: 'job_status_changed',
    occurredAt: entry.createdAt,
    actorUserId: entry.actorId,
    summary: job
      ? `Job ${job.jobNumber}: ${entry.description.toLowerCase()}`
      : entry.description,
    metadata: {
      jobId: entry.jobId,
      fromStatus: entry.fromStatus,
      toStatus: entry.toStatus,
    },
    sourceEntityId: entry.id,
    sourceEntityType: 'job_timeline',
  };
}

export function mapEstimateToEvents(est: Estimate): TimelineEvent[] {
  const out: TimelineEvent[] = [];
  if (est.sentAt) {
    out.push({
      kind: 'estimate_sent',
      occurredAt: est.sentAt,
      actorUserId: est.createdBy,
      summary: `Estimate ${est.estimateNumber} sent (${formatCents(est.totals.totalCents)})`,
      metadata: {
        estimateNumber: est.estimateNumber,
        status: est.status,
        totalCents: est.totals.totalCents,
        jobId: est.jobId,
      },
      sourceEntityId: est.id,
      sourceEntityType: 'estimate',
    });
  }
  if (est.acceptedAt) {
    out.push({
      kind: 'estimate_approved',
      occurredAt: est.acceptedAt,
      summary: `Estimate ${est.estimateNumber} approved by ${est.acceptedByName ?? 'customer'}`,
      metadata: {
        estimateNumber: est.estimateNumber,
        acceptedByName: est.acceptedByName,
        totalCents: est.totals.totalCents,
        jobId: est.jobId,
      },
      sourceEntityId: est.id,
      sourceEntityType: 'estimate',
    });
  }
  return out;
}

export function mapInvoiceToEvents(inv: Invoice): TimelineEvent[] {
  const out: TimelineEvent[] = [];
  if (inv.sentAt) {
    out.push({
      kind: 'invoice_sent',
      occurredAt: inv.sentAt,
      actorUserId: inv.createdBy,
      summary: `Invoice ${inv.invoiceNumber} sent (${formatCents(inv.totals.totalCents)})`,
      metadata: {
        invoiceNumber: inv.invoiceNumber,
        status: inv.status,
        totalCents: inv.totals.totalCents,
        jobId: inv.jobId,
      },
      sourceEntityId: inv.id,
      sourceEntityType: 'invoice',
    });
  }
  if (inv.status === 'paid') {
    out.push({
      kind: 'invoice_paid',
      // Use updatedAt as the paid-on signal — that's when status flipped.
      occurredAt: inv.updatedAt,
      summary: `Invoice ${inv.invoiceNumber} paid in full`,
      metadata: {
        invoiceNumber: inv.invoiceNumber,
        amountPaidCents: inv.amountPaidCents,
        jobId: inv.jobId,
      },
      sourceEntityId: inv.id,
      sourceEntityType: 'invoice',
    });
  }
  return out;
}

export function mapPaymentToEvent(p: Payment, invoiceNumber?: string): TimelineEvent {
  return {
    kind: 'payment_received',
    occurredAt: p.receivedAt,
    actorUserId: p.processedBy,
    summary: invoiceNumber
      ? `Payment received: ${formatCents(p.amountCents)} on ${invoiceNumber} (${p.method})`
      : `Payment received: ${formatCents(p.amountCents)} (${p.method})`,
    metadata: {
      amountCents: p.amountCents,
      method: p.method,
      invoiceId: p.invoiceId,
      invoiceNumber,
      providerReference: p.providerReference,
    },
    sourceEntityId: p.id,
    sourceEntityType: 'payment',
  };
}

/**
 * Channel inferred from a Message row. We don't have a first-class
 * `direction` column today, so we read `metadata.direction`
 * ('inbound' | 'outbound') with a sensible default of 'outbound' for
 * messages authored by an internal user.
 */
function inferDirection(msg: Message): 'inbound' | 'outbound' {
  const meta = (msg.metadata ?? {}) as Record<string, unknown>;
  const dir = meta.direction;
  if (dir === 'inbound' || dir === 'outbound') return dir;
  // Fallback heuristic — sender role 'customer' implies inbound.
  if (msg.senderRole === 'customer') return 'inbound';
  return 'outbound';
}

/**
 * Channel inferred from message metadata + source. Conversations carry
 * SMS / call / email payloads on the same Message row; the channel is
 * either explicit in `metadata.channel` or implied by `source`.
 */
function inferChannel(msg: Message): 'sms' | 'call' | 'email' | null {
  const meta = (msg.metadata ?? {}) as Record<string, unknown>;
  const ch = meta.channel;
  if (ch === 'sms' || ch === 'call' || ch === 'email') return ch;
  if (msg.source === 'sms' || msg.source === 'twilio_sms') return 'sms';
  if (
    msg.source === 'inbound_call' ||
    msg.source === 'outbound_call' ||
    msg.source === 'voice'
  ) {
    return 'call';
  }
  if (msg.source === 'email') return 'email';
  return null;
}

export function mapMessageToEvent(msg: Message): TimelineEvent | null {
  const channel = inferChannel(msg);
  if (!channel) return null;
  const direction = inferDirection(msg);
  let kind: TimelineKind;
  if (channel === 'sms') {
    kind = direction === 'inbound' ? 'sms_received' : 'sms_sent';
  } else if (channel === 'call') {
    kind = direction === 'inbound' ? 'call_inbound' : 'call_outbound';
  } else {
    kind = direction === 'inbound' ? 'email_received' : 'email_sent';
  }
  const preview = (msg.content ?? '').length > 120
    ? `${(msg.content ?? '').slice(0, 117)}...`
    : (msg.content ?? '');
  return {
    kind,
    occurredAt: msg.createdAt,
    actorUserId: direction === 'outbound' ? msg.senderId : undefined,
    summary: preview || labelForKind(kind),
    metadata: {
      conversationId: msg.conversationId,
      direction,
      channel,
      senderRole: msg.senderRole,
    },
    sourceEntityId: msg.id,
    sourceEntityType: 'message',
  };
}

export function mapAppointmentToEvents(a: Appointment): TimelineEvent[] {
  const out: TimelineEvent[] = [];
  out.push({
    kind: 'appointment_scheduled',
    occurredAt: a.createdAt,
    actorUserId: a.createdBy,
    summary: `Appointment scheduled for ${a.scheduledStart.toISOString()}`,
    metadata: {
      jobId: a.jobId,
      scheduledStart: a.scheduledStart.toISOString(),
      scheduledEnd: a.scheduledEnd.toISOString(),
      status: a.status,
      timezone: a.timezone,
    },
    sourceEntityId: a.id,
    sourceEntityType: 'appointment',
  });
  if (a.status === 'completed') {
    out.push({
      kind: 'appointment_completed',
      // updatedAt is the closest signal to "completed at"; we don't
      // persist a dedicated completed_at column.
      occurredAt: a.updatedAt,
      summary: `Appointment completed`,
      metadata: {
        jobId: a.jobId,
        scheduledStart: a.scheduledStart.toISOString(),
      },
      sourceEntityId: a.id,
      sourceEntityType: 'appointment',
    });
  }
  return out;
}

function labelForKind(kind: TimelineKind): string {
  switch (kind) {
    case 'sms_sent':       return 'SMS sent';
    case 'sms_received':   return 'SMS received';
    case 'call_inbound':   return 'Inbound call';
    case 'call_outbound':  return 'Outbound call';
    case 'email_sent':     return 'Email sent';
    case 'email_received': return 'Email received';
    default:               return kind;
  }
}

function formatCents(cents: number): string {
  const dollars = (cents / 100).toFixed(2);
  return `$${dollars}`;
}

/**
 * Sort-and-slice helper. Pure — exposed for unit tests.
 *
 *   - Filters by `before` cursor (occurredAt < before).
 *   - Filters by `kinds` allowlist when present.
 *   - Sorts desc by occurredAt; ties broken by sourceEntityId for stability.
 *   - Slices to `limit`.
 */
export function mergeAndSliceEvents(
  events: TimelineEvent[],
  opts: { before?: Date; kinds?: TimelineKind[]; limit?: number } = {}
): TimelineEvent[] {
  let filtered = events;
  if (opts.before) {
    const cutoff = opts.before.getTime();
    filtered = filtered.filter((e) => e.occurredAt.getTime() < cutoff);
  }
  if (opts.kinds && opts.kinds.length > 0) {
    const allow = new Set(opts.kinds);
    filtered = filtered.filter((e) => allow.has(e.kind));
  }
  filtered = [...filtered].sort((a, b) => {
    const diff = b.occurredAt.getTime() - a.occurredAt.getTime();
    if (diff !== 0) return diff;
    // Stable tiebreak so identical timestamps don't reorder under inserts.
    return a.sourceEntityId.localeCompare(b.sourceEntityId);
  });
  const limit = opts.limit ?? DEFAULT_TIMELINE_LIMIT;
  return filtered.slice(0, limit);
  return filtered.slice(0, limit);
}

/**
 * Pure audit → product-event mapper.
 *
 * The single governed seam that translates internal audit events into curated,
 * PII-safe PostHog product events. It is deny-by-default: an `eventType` with
 * no allowlist entry maps to `null` and never forwards. This is the one place
 * where event naming, the `feature_domain` dimension, the `distinctId` rule,
 * and the PII allowlist all live — so a new domain is added by adding rows
 * here, and nothing leaves the server that wasn't explicitly whitelisted.
 *
 * Modeled on `activity-feed.ts` (same pure, table-driven, unit-tested shape);
 * reuses its `actorKindFor` classifier.
 *
 * PII discipline: base props are IDs/enums only; per-event `props()` pick
 * NAMED metadata keys — the raw `metadata` object (which can carry customer
 * names, phone numbers, IP addresses, free-text reasons) is never spread.
 * `pickMeta` additionally drops any non-primitive value defensively.
 */
import type { AuditEvent } from '../audit/audit';
import { actorKindFor } from './activity-feed';
import type { ProductEventName } from './product-events';

/** A value safe to send as a PostHog property — IDs, enums, counts, flags. */
type SafeVal = string | number | boolean | null;

/** The translated, ready-to-forward product event (or `null` if unmapped). */
export interface ProductEvent {
  name: ProductEventName;
  tenantId: string;
  /** Clerk id for human actors; a stable server id for system/agent actors. */
  distinctId: string;
  /** The audit event id — forwarded as PostHog's `$insert_id` for dedup. */
  insertId: string;
  properties: Record<string, SafeVal>;
}

/**
 * Copy only the named metadata keys, renaming to snake_case output keys.
 * `mapping` is `{ outKey: metadataKey }`. Undefined metadata values are
 * skipped; non-primitive values (objects/arrays) are dropped defensively so a
 * nested/unexpected shape can never leak.
 */
function pickMeta(
  metadata: Record<string, unknown> | undefined,
  mapping: Record<string, string>,
): Record<string, SafeVal> {
  const out: Record<string, SafeVal> = {};
  if (!metadata) return out;
  for (const [outKey, metaKey] of Object.entries(mapping)) {
    const v = metadata[metaKey];
    if (v === undefined) continue;
    if (v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      out[outKey] = v;
    }
  }
  return out;
}

interface Mapping {
  name: ProductEventName;
  /**
   * Explicit `feature_domain` override. Set when the eventType prefix doesn't
   * derive the desired domain (e.g. `call.*`/`voicemail.*` → `voice`, the flat
   * AI-agent events → `ai`, `recurring_job.*`/`lead.*` folded into
   * `job`/`customer`). Falls back to `featureDomainFor(eventType)`.
   */
  domain?: string;
  /** Extra event-specific props pulled by NAME from metadata. IDs/enums only. */
  props?: (event: AuditEvent) => Record<string, SafeVal>;
}

/**
 * Deny-by-default allowlist: audit `eventType` → product event. Seeded with
 * the proposals + money-path slice whose audit writes are confirmed on the
 * value path. Each `props` extractor was checked against the real emitting
 * call site and excludes every PII / free-text / external-reference field
 * (e.g. `acceptedByName`, `ipAddress`, `userAgent`, `rejectionDetails`,
 * `reason`, `providerReference`, `stripeRefundId`).
 */
const ALLOWLIST: Record<string, Mapping> = {
  // Proposals — the human-in-the-loop core loop
  'proposal.approved': {
    name: 'proposal_approved',
    props: (e) => pickMeta(e.metadata, { proposal_type: 'proposalType', status: 'status', channel: 'channel' }),
  },
  'proposal.rejected': {
    name: 'proposal_rejected',
    props: (e) => pickMeta(e.metadata, { proposal_type: 'proposalType', status: 'status', channel: 'channel' }),
  },
  'proposal.executed': {
    name: 'proposal_executed',
    props: (e) => pickMeta(e.metadata, { proposal_type: 'proposalType', status: 'status' }),
  },
  'proposal.one_tap_approved': {
    name: 'proposal_one_tap_approved',
    props: (e) =>
      pickMeta(e.metadata, { channel: 'channel', approved_count: 'approvedCount', skipped_count: 'skippedCount' }),
  },
  // Money path — estimates → invoices → payments → booked work
  'estimate.created': { name: 'estimate_created' },
  'public_estimate.approved': {
    name: 'estimate_approved',
    props: (e) => pickMeta(e.metadata, { estimate_number: 'estimateNumber', total_cents: 'totalCents' }),
  },
  'public_estimate.declined': {
    name: 'estimate_declined',
    props: (e) => pickMeta(e.metadata, { estimate_number: 'estimateNumber', total_cents: 'totalCents' }),
  },
  'invoice.issued': {
    name: 'invoice_issued',
    props: (e) =>
      pickMeta(e.metadata, {
        proposal_type: 'proposalType',
        invoice_number: 'invoiceNumber',
        payment_term_days: 'paymentTermDays',
      }),
  },
  'payment.recorded': {
    name: 'payment_recorded',
    props: (e) =>
      pickMeta(e.metadata, { method: 'method', amount_cents: 'amountCents', new_invoice_status: 'newInvoiceStatus' }),
  },
  'payment.refunded': {
    name: 'payment_refunded',
    props: (e) => pickMeta(e.metadata, { refund_cents: 'refundCents', total_refunded_cents: 'totalRefundedCents' }),
  },
  'payment.failed': {
    name: 'payment_failed',
    props: (e) => pickMeta(e.metadata, { method: 'method', amount_cents: 'amountCents' }),
  },
  'appointment.booked': {
    name: 'appointment_booked',
    props: (e) => pickMeta(e.metadata, { job_id: 'jobId' }),
  },

  // Jobs
  'job.created': { name: 'job_created', domain: 'job' },
  'job.status_changed': {
    name: 'job_status_changed',
    domain: 'job',
    // NOT `reason` (free text on a backward transition).
    props: (e) => pickMeta(e.metadata, { from_status: 'fromStatus', to_status: 'toStatus' }),
  },
  'job.created_from_estimate': {
    name: 'job_created_from_estimate',
    domain: 'job',
    props: (e) => pickMeta(e.metadata, { estimate_id: 'estimateId' }),
  },
  'recurring_job.created': {
    name: 'recurring_job_created',
    domain: 'job',
    props: (e) => pickMeta(e.metadata, { schedule: 'schedule' }),
  },

  // Customers / CRM (leads folded into the customer domain)
  'customer.created': { name: 'customer_created', domain: 'customer' },
  'customer.merged': { name: 'customer_merged', domain: 'customer' },
  'customer.created_from_lead': {
    name: 'customer_created_from_lead',
    domain: 'customer',
    // NOT the attribution metadata (may embed a referrer URL).
    props: (e) => pickMeta(e.metadata, { lead_id: 'leadId' }),
  },
  'lead.created': {
    name: 'lead_created',
    domain: 'customer',
    // `source` only — NOT the attribution metadata.
    props: (e) => pickMeta(e.metadata, { source: 'source' }),
  },
  'lead.converted': {
    name: 'lead_converted',
    domain: 'customer',
    props: (e) => pickMeta(e.metadata, { from_stage: 'fromStage' }),
  },
  'lead.lost': {
    name: 'lead_lost',
    domain: 'customer',
    // NOT `reason` (free text).
    props: (e) => pickMeta(e.metadata, { from_stage: 'fromStage' }),
  },

  // Voice / calls
  'call.initiated': { name: 'call_initiated', domain: 'voice' },
  'voicemail.received': {
    name: 'voicemail_received',
    domain: 'voice',
    props: (e) => pickMeta(e.metadata, { has_recording_url: 'hasRecordingUrl' }),
  },
  'call_me_back.scheduled': {
    name: 'callback_scheduled',
    domain: 'voice',
    // `reason` here is a fixed enum ('transfer_failed'), not free text.
    props: (e) => pickMeta(e.metadata, { has_message: 'hasMessage', reason: 'reason' }),
  },
  'customer_callback_required': { name: 'customer_callback_required', domain: 'voice' },

  // AI agent activity
  'unsupervised_proposal_routed': {
    name: 'unsupervised_proposal_routed',
    domain: 'ai',
    props: (e) =>
      pickMeta(e.metadata, {
        requested_routing: 'requestedRouting',
        effective_routing: 'effectiveRouting',
        channel: 'channel',
        escalated: 'escalated',
      }),
  },
  'escalation.requested': {
    name: 'escalation_requested',
    domain: 'ai',
    // `outcome` only — NOT free-text `reason` or the assigned user id.
    props: (e) => pickMeta(e.metadata, { outcome: 'outcome' }),
  },
  'autonomous_booking_undone': {
    name: 'autonomous_booking_undone',
    domain: 'ai',
    props: (e) => pickMeta(e.metadata, { channel: 'channel', phase: 'phase' }),
  },
};

const SERVER_DISTINCT_ID: Record<'agent' | 'system', string> = {
  agent: 'server:agent',
  system: 'server:system',
};

/**
 * The distinct id to attribute the event to. Human actors pass through their
 * `actorId` (stitches to the browser `identify()` when it's the Clerk id).
 * System / agent (voice) actors — whose `actorId` is a sentinel like
 * `system:stripe_webhook`, the one-tap actor, or `calling-agent` — collapse to
 * a stable server id so they never mint per-sentinel "persons". Tenant-level
 * analytics use the group, so they are correct regardless of actor.
 */
export function distinctIdFor(event: AuditEvent): string {
  const kind = actorKindFor(event.actorRole);
  return kind === 'human' ? event.actorId : SERVER_DISTINCT_ID[kind];
}

/**
 * The product "feature domain" for head-to-head usage comparison (e.g.
 * calling vs invoicing vs estimates). Derived from the `eventType` prefix,
 * with the `public_` customer-surface prefix stripped so
 * `public_estimate.approved` and `estimate.created` share the `estimate`
 * domain.
 */
export function featureDomainFor(eventType: string): string {
  const head = eventType.split('.')[0];
  return head.startsWith('public_') ? head.slice('public_'.length) : head;
}

/**
 * Translate an audit event into a product event, or `null` if its `eventType`
 * is not allowlisted. Pure — no I/O, never throws.
 */
export function auditEventToProductEvent(event: AuditEvent): ProductEvent | null {
  const mapping = ALLOWLIST[event.eventType];
  if (!mapping) return null;

  const base: Record<string, SafeVal> = {
    entity_type: event.entityType,
    entity_id: event.entityId,
    actor_role: event.actorRole,
    actor_kind: actorKindFor(event.actorRole),
    feature_domain: mapping.domain ?? featureDomainFor(event.eventType),
    audit_event_type: event.eventType,
  };
  const specific = mapping.props ? mapping.props(event) : {};

  return {
    name: mapping.name,
    tenantId: event.tenantId,
    distinctId: distinctIdFor(event),
    insertId: event.id,
    properties: { ...base, ...specific },
  };
}

/** The audit eventTypes currently forwarded — for tests / introspection. */
export const ALLOWLISTED_AUDIT_EVENT_TYPES: readonly string[] = Object.keys(ALLOWLIST);

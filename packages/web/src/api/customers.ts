/**
 * P9-002 — Customer-related fetchers used by the web app.
 *
 * Today this only carries the timeline aggregator for `CustomerDetail`;
 * the existing CRUD calls still go through `useDetailQuery` /
 * `useListQuery` against `/api/customers`. New fetchers should land
 * here so the customer detail page has a single import surface.
 */
import { apiFetch } from '../utils/api-fetch';

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

export interface TimelineEvent {
  kind: TimelineKind;
  occurredAt: string;
  actorUserId?: string;
  summary: string;
  metadata: Record<string, unknown>;
  sourceEntityId: string;
  sourceEntityType: string;
}

export interface CustomerTimelineResponse {
  events: TimelineEvent[];
  nextCursor: string | null;
}

export interface GetCustomerTimelineOptions {
  before?: string;
  limit?: number;
  kinds?: TimelineKind[];
}

/**
 * Fetch a slice of the customer activity timeline.
 *
 *   - `before`: ISO timestamp; events strictly older are returned
 *   - `limit`:  default 50, server-capped at 200
 *   - `kinds`:  comma-joined on the wire — server filters server-side
 */
export async function getCustomerTimeline(
  customerId: string,
  opts: GetCustomerTimelineOptions = {}
): Promise<CustomerTimelineResponse> {
  const params = new URLSearchParams();
  if (opts.before) params.set('before', opts.before);
  if (opts.limit !== undefined) params.set('limit', String(opts.limit));
  if (opts.kinds && opts.kinds.length > 0) params.set('kinds', opts.kinds.join(','));
  const qs = params.toString();
  const url = qs
    ? `/api/customers/${encodeURIComponent(customerId)}/timeline?${qs}`
    : `/api/customers/${encodeURIComponent(customerId)}/timeline`;
  const res = await apiFetch(url);
  if (!res.ok) {
    throw new Error(`Failed to load timeline: ${res.status}`);
  }
  return (await res.json()) as CustomerTimelineResponse;
}

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
  if (res.status === 404) {
    return { events: [], nextCursor: null };
  }
  if (!res.ok) {
    throw new Error(`Failed to load timeline: ${res.status}`);
  }
  return (await res.json()) as CustomerTimelineResponse;
}

// ---------------------------------------------------------------------------
// U1 (CRM Jobber parity) — multiple contacts per customer.
// ---------------------------------------------------------------------------

export type CustomerContactRole = 'primary' | 'billing' | 'site' | 'other';

export interface CustomerContact {
  id: string;
  customerId: string;
  name: string;
  role: CustomerContactRole;
  phone?: string;
  email?: string;
  isPrimary: boolean;
  notes?: string;
  isArchived: boolean;
}

export interface ContactInput {
  name: string;
  role?: CustomerContactRole;
  phone?: string;
  email?: string;
  isPrimary?: boolean;
  notes?: string;
}

async function readJsonOrThrow<T>(res: Response, action: string): Promise<T> {
  if (!res.ok) {
    const json = (await res.json().catch(() => ({}))) as { message?: string };
    throw new Error(json?.message ?? `Failed to ${action}: ${res.status}`);
  }
  return (await res.json()) as T;
}

export async function listContacts(customerId: string): Promise<CustomerContact[]> {
  const res = await apiFetch(`/api/customers/${encodeURIComponent(customerId)}/contacts`);
  const data = await readJsonOrThrow<unknown>(res, 'load contacts');
  return Array.isArray(data) ? (data as CustomerContact[]) : [];
}

export async function createContact(
  customerId: string,
  input: ContactInput,
): Promise<CustomerContact> {
  const res = await apiFetch(`/api/customers/${encodeURIComponent(customerId)}/contacts`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
  return readJsonOrThrow<CustomerContact>(res, 'add contact');
}

export async function updateContact(
  customerId: string,
  contactId: string,
  input: Partial<ContactInput>,
): Promise<CustomerContact> {
  const res = await apiFetch(
    `/api/customers/${encodeURIComponent(customerId)}/contacts/${encodeURIComponent(contactId)}`,
    { method: 'PUT', body: JSON.stringify(input) },
  );
  return readJsonOrThrow<CustomerContact>(res, 'update contact');
}

export async function archiveContact(customerId: string, contactId: string): Promise<void> {
  const res = await apiFetch(
    `/api/customers/${encodeURIComponent(customerId)}/contacts/${encodeURIComponent(contactId)}/archive`,
    { method: 'POST' },
  );
  if (!res.ok) throw new Error(`Failed to remove contact: ${res.status}`);
}

// ---------------------------------------------------------------------------
// U2 (CRM Jobber parity) — customer tags.
// ---------------------------------------------------------------------------

export async function listTags(customerId: string): Promise<string[]> {
  const res = await apiFetch(`/api/customers/${encodeURIComponent(customerId)}/tags`);
  const data = await readJsonOrThrow<unknown>(res, 'load tags');
  return Array.isArray(data) ? (data as string[]) : [];
}

export async function addTag(customerId: string, tag: string): Promise<string[]> {
  const res = await apiFetch(`/api/customers/${encodeURIComponent(customerId)}/tags`, {
    method: 'POST',
    body: JSON.stringify({ tag }),
  });
  const data = await readJsonOrThrow<unknown>(res, 'add tag');
  return Array.isArray(data) ? (data as string[]) : [];
}

export async function removeTag(customerId: string, tag: string): Promise<string[]> {
  const res = await apiFetch(
    `/api/customers/${encodeURIComponent(customerId)}/tags/${encodeURIComponent(tag)}`,
    { method: 'DELETE' },
  );
  const data = await readJsonOrThrow<unknown>(res, 'remove tag');
  return Array.isArray(data) ? (data as string[]) : [];
}

// ---------------------------------------------------------------------------
// U2 (CRM Jobber parity) — tenant-defined custom fields (per-customer values).
// ---------------------------------------------------------------------------

export type CustomFieldType = 'text' | 'number' | 'date' | 'select';

export interface ResolvedCustomField {
  fieldDefId: string;
  key: string;
  label: string;
  fieldType: CustomFieldType;
  options: string[];
  value: string | null;
}

export async function listCustomFields(customerId: string): Promise<ResolvedCustomField[]> {
  const res = await apiFetch(`/api/customers/${encodeURIComponent(customerId)}/custom-fields`);
  const data = await readJsonOrThrow<unknown>(res, 'load custom fields');
  return Array.isArray(data) ? (data as ResolvedCustomField[]) : [];
}

export async function setCustomFieldValue(
  customerId: string,
  fieldDefId: string,
  value: string | null,
): Promise<ResolvedCustomField[]> {
  const res = await apiFetch(
    `/api/customers/${encodeURIComponent(customerId)}/custom-fields/${encodeURIComponent(fieldDefId)}`,
    { method: 'PUT', body: JSON.stringify({ value }) },
  );
  const data = await readJsonOrThrow<unknown>(res, 'save custom field');
  return Array.isArray(data) ? (data as ResolvedCustomField[]) : [];
}

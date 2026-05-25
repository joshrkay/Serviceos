/**
 * P10-001 — Customer self-service portal API client.
 *
 * The portal is unauthenticated from Clerk's perspective — the URL token
 * is the auth. Use plain `fetch` here (not apiFetch) so we don't attach
 * any Clerk session token by accident.
 */

export interface PortalCustomer {
  id: string;
  displayName: string;
  firstName: string;
  lastName: string;
  companyName?: string;
  primaryPhone?: string;
  secondaryPhone?: string;
  email?: string;
  preferredChannel: string;
}

export interface PortalEstimate {
  id: string;
  estimateNumber: string;
  status: string;
  totalCents: number;
  createdAt: string;
  validUntil: string | null;
  publicViewToken: string | null;
}

export interface PortalInvoice {
  id: string;
  invoiceNumber: string;
  status: string;
  totalCents: number;
  amountPaidCents: number;
  amountDueCents: number;
  issuedAt: string | null;
  dueDate: string | null;
  createdAt: string;
  payNowUrl: string | null;
}

export interface PortalJob {
  id: string;
  jobNumber: string;
  summary: string;
  status: string;
  priority: string;
  createdAt: string;
}

export interface PortalAgreement {
  id: string;
  name: string;
  description?: string;
  status: string;
  priceCents: number;
  recurrenceRule: string;
  nextRunAt: string;
  startsOn: string;
  endsOn: string | null;
}

export interface PortalAppointment {
  id: string;
  jobId: string;
  status: string;
  scheduledStart: string;
  scheduledEnd: string;
  arrivalWindowStart: string | null;
  arrivalWindowEnd: string | null;
  timezone: string;
}

export interface RequestServiceInput {
  summary: string;
  notes?: string;
  firstName?: string;
  lastName?: string;
  companyName?: string;
  primaryPhone?: string;
  email?: string;
}

export interface PortalSlot {
  start: string;
  end: string;
}

export interface PortalAvailability {
  timezone: string;
  durationMin: number;
  slots: PortalSlot[];
}

export interface BookInput {
  slotStart: string;
  slotEnd: string;
  summary: string;
  locationId?: string;
}

export type BookResult =
  | {
      ok: true;
      status: 'pending_confirmation';
      proposalId: string;
      appointmentId: string;
      scheduledStart: string;
      scheduledEnd: string;
      timezone: string;
      message: string;
    }
  | { ok: false; slotTaken: true; alternatives: PortalSlot[]; message: string }
  | { ok: false; slotTaken: false; message: string };

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Portal request failed (${res.status}): ${body || res.statusText}`);
  }
  return (await res.json()) as T;
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Portal request failed (${res.status}): ${text || res.statusText}`);
  }
  return (await res.json()) as T;
}

const base = (token: string) => `/api/public/portal/${encodeURIComponent(token)}`;

export const portalApi = {
  customer: (token: string) => getJson<PortalCustomer>(`${base(token)}/customer`),
  estimates: (token: string) =>
    getJson<{ estimates: PortalEstimate[] }>(`${base(token)}/estimates`),
  invoices: (token: string) =>
    getJson<{ invoices: PortalInvoice[] }>(`${base(token)}/invoices`),
  jobs: (token: string) => getJson<{ jobs: PortalJob[] }>(`${base(token)}/jobs`),
  agreements: (token: string) =>
    getJson<{ agreements: PortalAgreement[] }>(`${base(token)}/agreements`),
  appointments: (token: string, opts: { upcoming?: boolean } = {}) => {
    const qs = opts.upcoming ? '?upcoming=true' : '';
    return getJson<{ appointments: PortalAppointment[] }>(
      `${base(token)}/appointments${qs}`,
    );
  },
  requestService: (token: string, input: RequestServiceInput) =>
    postJson<{ leadId: string; message: string }>(
      `${base(token)}/request-service`,
      input,
    ),
  availability: (
    token: string,
    opts: { from: string; to: string; durationMin?: number },
  ) => {
    const qs = new URLSearchParams({ from: opts.from, to: opts.to });
    if (opts.durationMin) qs.set('durationMin', String(opts.durationMin));
    return getJson<PortalAvailability>(`${base(token)}/availability?${qs.toString()}`);
  },
  cancelAppointment: (token: string, appointmentId: string, reason?: string) =>
    postJson<{ status: string; proposalId: string; message: string }>(
      `${base(token)}/appointments/${encodeURIComponent(appointmentId)}/cancel`,
      { reason },
    ),
  rescheduleAppointment: (
    token: string,
    appointmentId: string,
    slot: { slotStart: string; slotEnd: string },
  ) =>
    postJson<{ status: string; proposalId: string; message: string }>(
      `${base(token)}/appointments/${encodeURIComponent(appointmentId)}/reschedule`,
      slot,
    ),
  book: async (token: string, input: BookInput): Promise<BookResult> => {
    const res = await fetch(`${base(token)}/book`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(input),
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok) {
      return { ok: true, ...body };
    }
    if (res.status === 409) {
      return {
        ok: false,
        slotTaken: true,
        alternatives: (body.alternatives ?? []) as PortalSlot[],
        message: body.message ?? 'That time was just booked.',
      };
    }
    return { ok: false, slotTaken: false, message: body.message ?? 'Could not book that time.' };
  },
};

export function formatPortalCents(cents: number): string {
  return `$${(cents / 100).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

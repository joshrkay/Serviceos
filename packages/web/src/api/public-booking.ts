/**
 * Public online-booking API client — UNAUTHENTICATED.
 *
 * The /book page is a public, shareable link (Jobber "Online Booking"
 * parity); there is no Clerk session. These calls use plain `fetch`, not
 * `apiFetch`. The tenant id comes from the `?t=<uuid>` query param on the
 * landing URL (resolved by the caller, not this module).
 *
 * Branding (business name, phone, hours) is loaded via the existing
 * `fetchIntakeTenantInfo` from `./public-intake` — the same public tenant
 * info endpoint backs both surfaces.
 */

export interface BookingSlot {
  start: string;
  end: string;
}

export interface BookingAvailability {
  timezone: string;
  durationMin: number;
  slots: BookingSlot[];
}

export interface SubmitBookingPayload {
  firstName: string;
  lastName?: string;
  primaryPhone?: string;
  email?: string;
  smsConsent?: boolean;
  street1: string;
  street2?: string;
  city: string;
  state: string;
  postalCode: string;
  accessNotes?: string;
  summary: string;
  serviceType?: string;
  slotStart: string;
  slotEnd: string;
  /** Honeypot — always sent empty; bots that fill every field trip it. */
  _company_url: string;
}

export interface BookingConfirmation {
  status: 'pending_confirmation';
  proposalId: string;
  appointmentId: string;
  scheduledStart: string;
  scheduledEnd: string;
  timezone: string;
  message: string;
}

export interface BookingSlotTaken {
  error: 'SLOT_TAKEN';
  message: string;
  alternatives: BookingSlot[];
}

const base = (tenantId: string) =>
  `/api/public/booking/${encodeURIComponent(tenantId)}`;

/** Fetch open slots for a date range (YYYY-MM-DD) and visit duration. */
export async function fetchBookingAvailability(
  tenantId: string,
  params: { from: string; to: string; durationMin?: number },
): Promise<BookingAvailability> {
  const q = new URLSearchParams({
    from: params.from,
    to: params.to,
    ...(params.durationMin ? { durationMin: String(params.durationMin) } : {}),
  });
  const res = await fetch(`${base(tenantId)}/availability?${q.toString()}`, {
    method: 'GET',
    headers: { accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`Could not load availability (${res.status})`);
  }
  return (await res.json()) as BookingAvailability;
}

/**
 * Submit a booking request. Resolves with the confirmation on 201, or a
 * `SLOT_TAKEN` object on 409 so the caller can re-render fresh slots.
 */
export async function submitBooking(
  tenantId: string,
  payload: SubmitBookingPayload,
): Promise<BookingConfirmation | BookingSlotTaken> {
  const res = await fetch(base(tenantId), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (res.status === 409) {
    return (await res.json()) as BookingSlotTaken;
  }
  if (!res.ok) {
    throw new Error(`Booking failed (${res.status})`);
  }
  return (await res.json()) as BookingConfirmation;
}

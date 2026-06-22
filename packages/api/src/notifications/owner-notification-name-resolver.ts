/**
 * Process-wide customer-name lookups for owner-notification copy.
 *
 * Registered once in `app.ts` with the live repos so the `payment_received` and
 * `appointment_cancellation` push seams can render the real customer name
 * instead of "A customer" — without threading a resolver through every
 * `recordPayment` / handler call site. All lookups are best-effort: any failure
 * resolves to `undefined` and the caller falls back to a generic label, so a
 * name lookup can never break a payment or a cancellation.
 */
export interface OwnerNotificationNameResolvers {
  /** Customer display name for an invoice (payment_received). */
  invoiceCustomerName?: (tenantId: string, invoiceId: string) => Promise<string | undefined>;
  /** Customer display name for an appointment (appointment_cancellation). */
  appointmentCustomerName?: (
    tenantId: string,
    appointmentId: string,
  ) => Promise<string | undefined>;
}

let resolvers: OwnerNotificationNameResolvers = {};

/** Register (or clear, with `{}`) the active resolvers. Called once in `app.ts`. */
export function setOwnerNotificationNameResolvers(next: OwnerNotificationNameResolvers): void {
  resolvers = next;
}

async function safe(
  fn: (() => Promise<string | undefined>) | undefined,
): Promise<string | undefined> {
  if (!fn) return undefined;
  try {
    return await fn();
  } catch {
    return undefined;
  }
}

export function resolveInvoiceCustomerName(
  tenantId: string,
  invoiceId: string,
): Promise<string | undefined> {
  return safe(
    resolvers.invoiceCustomerName
      ? () => resolvers.invoiceCustomerName!(tenantId, invoiceId)
      : undefined,
  );
}

export function resolveAppointmentCustomerName(
  tenantId: string,
  appointmentId: string,
): Promise<string | undefined> {
  return safe(
    resolvers.appointmentCustomerName
      ? () => resolvers.appointmentCustomerName!(tenantId, appointmentId)
      : undefined,
  );
}

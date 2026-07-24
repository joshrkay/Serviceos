/**
 * Comms C2 / I14 — read-time entitlement for portal sessions.
 *
 * A portal session may be bound to a specific customer contact
 * (`portal_sessions.contact_id`). What that session may read is a property
 * of the contact's CURRENT role, resolved on every token resolution — never
 * a snapshot taken when the token was minted, and never a UI concern.
 *
 * Surfaces:
 *   - 'billing'  — full customer view: invoices, balances, estimates,
 *                  agreement pricing, saved payment methods, plus everything
 *                  in 'service'.
 *   - 'service'  — appointment windows, jobs, self-service booking, and the
 *                  customer identity card. NO billing data.
 *
 * Role → entitlement mapping (D19 default-deny pending product decision):
 * `primary` and `billing` contacts see the billing surface; `site` and
 * `other` contacts see the service surface only. A session with no bound
 * contact is the account holder's own link and keeps the historical full
 * (billing) view.
 */
import type { CustomerContact, CustomerContactRole } from '../customers/contact';

export type PortalEntitlement = 'billing' | 'service';

const ROLE_ENTITLEMENT: Record<CustomerContactRole, PortalEntitlement> = {
  primary: 'billing',
  billing: 'billing',
  site: 'service',
  other: 'service',
};

export function entitlementForRole(role: CustomerContactRole): PortalEntitlement {
  // Unknown roles (future additions) fail safe to the restricted surface.
  return ROLE_ENTITLEMENT[role] ?? 'service';
}

export function entitlementForContact(contact: CustomerContact): PortalEntitlement {
  return entitlementForRole(contact.role);
}

/**
 * True when a session holding `granted` may read `required`. 'billing'
 * subsumes 'service'; 'service' may never read the billing surface.
 */
export function entitlementAllows(
  granted: PortalEntitlement,
  required: PortalEntitlement,
): boolean {
  if (required === 'service') return true;
  return granted === 'billing';
}

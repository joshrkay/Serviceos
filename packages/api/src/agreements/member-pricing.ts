/**
 * Membership benefit resolution (#6).
 *
 * Benefits a customer enjoys are derived from their currently-effective
 * memberships (active + within term): the member-pricing discount (phase 2)
 * and the priority-booking horizon (phase 3). A customer may hold several
 * agreements; pricing takes the BEST (highest) discount, and priority booking
 * is granted if ANY effective membership flags it.
 *
 * Resolvers are pure (take agreements in); the async helpers fetch the
 * customer's active agreements and delegate. Applying a discount to money
 * lives in the shared billing engine (applyBps) — never re-implement the
 * percentage math here.
 */
import { Agreement, AgreementRepository } from './agreement';

/** True when the agreement is active and `ymd` (YYYY-MM-DD) falls within its term. */
function isEffective(a: Agreement, ymd: string): boolean {
  if (a.status !== 'active') return false;
  if (a.startsOn > ymd) return false; // hasn't started yet
  if (a.endsOn && a.endsOn < ymd) return false; // term lapsed
  return true;
}

/**
 * The best member discount (basis points) across a set of agreements at `asOf`.
 * Returns 0 when none currently apply.
 */
export function resolveMemberDiscountBps(agreements: Agreement[], asOf: Date): number {
  const ymd = asOf.toISOString().slice(0, 10);
  let best = 0;
  for (const a of agreements) {
    const bps = a.memberDiscountBps ?? 0;
    if (bps > best && isEffective(a, ymd)) best = bps;
  }
  return best;
}

/**
 * Resolve a customer's current member discount (bps) from their active
 * agreements. Used at estimate/invoice creation to apply member pricing.
 */
export async function getCustomerMemberDiscountBps(
  tenantId: string,
  customerId: string,
  agreementRepo: AgreementRepository,
  asOf: Date = new Date(),
): Promise<number> {
  const agreements = await agreementRepo.findByTenant(tenantId, {
    customerId,
    status: 'active',
  });
  return resolveMemberDiscountBps(agreements, asOf);
}

/**
 * True when any of the agreements is a currently-effective membership granting
 * priority booking (the extended self-service booking horizon).
 */
export function resolveHasPriorityBooking(agreements: Agreement[], asOf: Date): boolean {
  const ymd = asOf.toISOString().slice(0, 10);
  return agreements.some((a) => a.priorityBooking === true && isEffective(a, ymd));
}

/**
 * Whether a customer currently has the priority-booking perk from an active
 * membership. Used by the portal availability/booking flow to widen the
 * bookable horizon.
 */
export async function customerHasPriorityBooking(
  tenantId: string,
  customerId: string,
  agreementRepo: AgreementRepository,
  asOf: Date = new Date(),
): Promise<boolean> {
  const agreements = await agreementRepo.findByTenant(tenantId, {
    customerId,
    status: 'active',
  });
  return resolveHasPriorityBooking(agreements, asOf);
}

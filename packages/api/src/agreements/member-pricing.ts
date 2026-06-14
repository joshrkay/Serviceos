/**
 * Membership member-pricing resolution (#6 phase 2).
 *
 * A membership (service agreement) with `memberDiscountBps > 0` confers that
 * percentage discount on the customer's estimates/invoices while the
 * membership is active AND within its term. A customer may hold several
 * agreements; the BEST (highest) currently-effective member discount applies.
 *
 * The resolver is pure (takes agreements in); the async helper fetches the
 * customer's active agreements and delegates, so creation paths get a single
 * call. Applying the resolved bps to money lives in the shared billing engine
 * (applyBps) — never re-implement the percentage math here.
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

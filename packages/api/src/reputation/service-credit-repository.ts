/**
 * P7-026 — Service-credit ledger repository.
 *
 * Backs migration 103. Used by:
 *   - credit-tier.ts (the 12-month-per-customer cap query that bounds
 *     every credit suggestion before it ships in a proposal)
 *   - the review-response handler in PR-c (writes the credit row when
 *     the operator approves the credit sub-payload)
 *
 * Canonical method shape: tenantId is always first. Money is integer
 * cents per CLAUDE.md.
 */

export interface ServiceCredit {
  id: string;
  tenantId: string;
  customerId: string;
  amountCents: number;
  issuedAt: Date;
  issuedByUserId: string;
  sourceReviewId?: string;
  notes?: string;
  createdAt: Date;
}

export interface IssueServiceCreditInput {
  tenantId: string;
  customerId: string;
  amountCents: number;
  issuedByUserId: string;
  sourceReviewId?: string;
  notes?: string;
}

export interface ServiceCreditRepository {
  create(credit: ServiceCredit): Promise<ServiceCredit>;
  findByCustomer(
    tenantId: string,
    customerId: string,
  ): Promise<ServiceCredit[]>;
  /**
   * Sum of amount_cents for credits issued to this customer with
   * issuedAt strictly after `since`. The 12-month cap query passes
   * `since = now - 12 months` and asserts SUM + proposedAmount <= cap.
   *
   * Returns 0 when the customer has no credits in the window — never
   * null, per the multi-record-read convention.
   */
  sumIssuedSince(
    tenantId: string,
    customerId: string,
    since: Date,
  ): Promise<number>;
}

export class InMemoryServiceCreditRepository implements ServiceCreditRepository {
  private credits: ServiceCredit[] = [];

  async create(credit: ServiceCredit): Promise<ServiceCredit> {
    this.credits.push({ ...credit });
    return { ...credit };
  }

  async findByCustomer(
    tenantId: string,
    customerId: string,
  ): Promise<ServiceCredit[]> {
    return this.credits
      .filter((c) => c.tenantId === tenantId && c.customerId === customerId)
      .map((c) => ({ ...c }));
  }

  async sumIssuedSince(
    tenantId: string,
    customerId: string,
    since: Date,
  ): Promise<number> {
    return this.credits
      .filter(
        (c) =>
          c.tenantId === tenantId &&
          c.customerId === customerId &&
          c.issuedAt.getTime() > since.getTime(),
      )
      .reduce((acc, c) => acc + c.amountCents, 0);
  }
}

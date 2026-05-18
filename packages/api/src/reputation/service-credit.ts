/**
 * P7-026 PR c — Service credit ledger (in-memory + repo interface).
 *
 * Service credits are goodwill credits issued to a customer as part
 * of an owner-approved review-response proposal. They are NOT refunds
 * (refunds touch payment systems) and NOT deposit credits (those live
 * in `invoices/deposit-credit.ts`, a separate concept tied to the
 * deposit-on-job-creation flow). A service credit is a free-form
 * "we owe you $X" ledger entry that the operator can later apply to
 * an invoice or absorb as a write-off.
 *
 * The repo interface is small:
 *   - `create()` inserts one row (cap enforcement happens upstream
 *     at draft time, not here — see credit-tier.applyCreditCap).
 *   - `sumIssuedInLast12Months()` returns the rolling total used by
 *     the cap check.
 *
 * RLS isolation: every read and write goes through tenant context;
 * see the Pg implementation in `pg-service-credit.ts`.
 */

import { v4 as uuidv4 } from 'uuid';

export interface ServiceCredit {
  id: string;
  tenantId: string;
  customerId: string;
  amountCents: number;
  /**
   * The Google review (`google_reviews.id`) that motivated this
   * credit. Null when the credit is non-review-driven (future
   * use — manual issuance, refund offset, etc.).
   */
  reviewId: string | null;
  /** The proposal (`proposals.id`) that authorized this credit. */
  proposalId: string;
  issuedAt: Date;
}

export interface CreateServiceCreditInput {
  id?: string;
  tenantId: string;
  customerId: string;
  amountCents: number;
  reviewId: string | null;
  proposalId: string;
  issuedAt?: Date;
}

export interface ServiceCreditRepository {
  create(input: CreateServiceCreditInput): Promise<ServiceCredit>;
  /**
   * Sum of credits issued to this customer in the last 12 months.
   * Used by `applyCreditCap()` to enforce the per-customer $100 cap.
   */
  sumIssuedInLast12Months(
    tenantId: string,
    customerId: string,
  ): Promise<number>;
}

/**
 * In-memory implementation for unit tests + dev. The Pg
 * implementation lives in `pg-service-credit.ts`.
 */
export class InMemoryServiceCreditRepository implements ServiceCreditRepository {
  private readonly store: ServiceCredit[] = [];

  constructor(private readonly now: () => Date = () => new Date()) {}

  async create(input: CreateServiceCreditInput): Promise<ServiceCredit> {
    if (input.amountCents <= 0) {
      throw new Error('amountCents must be positive');
    }
    const row: ServiceCredit = {
      id: input.id ?? uuidv4(),
      tenantId: input.tenantId,
      customerId: input.customerId,
      amountCents: input.amountCents,
      reviewId: input.reviewId,
      proposalId: input.proposalId,
      issuedAt: input.issuedAt ?? this.now(),
    };
    this.store.push(row);
    return { ...row };
  }

  async sumIssuedInLast12Months(
    tenantId: string,
    customerId: string,
  ): Promise<number> {
    const cutoff = new Date(this.now().getTime() - 365 * 24 * 60 * 60 * 1000);
    return this.store
      .filter(
        (c) =>
          c.tenantId === tenantId &&
          c.customerId === customerId &&
          c.issuedAt > cutoff,
      )
      .reduce((sum, c) => sum + c.amountCents, 0);
  }

  /** Test-only helper. */
  size(): number {
    return this.store.length;
  }
}

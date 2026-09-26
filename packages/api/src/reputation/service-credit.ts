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
 *   - `create()` inserts one row, unguarded (seeding, tests).
 *   - `createIfAllowed()` re-reads the rolling total and inserts only if
 *     the caller's cap predicate allows it, atomically — the execute-time
 *     half of the cap (#1080). The draft-time half is
 *     credit-tier.applyCreditCap; both share `exceedsCreditCap`.
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

/** Outcome of {@link ServiceCreditRepository.createIfAllowed}. */
export type GuardedCreateResult =
  | { issued: true; credit: ServiceCredit; priorIssuedCents: number }
  | { issued: false; priorIssuedCents: number };

export interface ServiceCreditRepository {
  create(input: CreateServiceCreditInput): Promise<ServiceCredit>;
  /**
   * #1080 — read the customer's rolling 12-month total and insert the credit
   * only if `wouldExceed(priorIssuedCents)` is false, as ONE atomic step
   * (the Pg implementation holds a per-(tenant, customer) transaction
   * advisory lock across the read and the insert, so two concurrent
   * executions cannot both pass the check). The cap POLICY stays with the
   * caller (`exceedsCreditCap`); the repo owns only atomicity.
   */
  createIfAllowed(
    input: CreateServiceCreditInput,
    wouldExceed: (priorIssuedCents: number) => boolean,
  ): Promise<GuardedCreateResult>;
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
    return this.insertSync(input);
  }

  async createIfAllowed(
    input: CreateServiceCreditInput,
    wouldExceed: (priorIssuedCents: number) => boolean,
  ): Promise<GuardedCreateResult> {
    // Read and insert run synchronously — no await between them — so no
    // other caller can interleave (the in-memory analogue of the Pg lock).
    const priorIssuedCents = this.sumSync(input.tenantId, input.customerId);
    if (wouldExceed(priorIssuedCents)) return { issued: false, priorIssuedCents };
    return { issued: true, credit: this.insertSync(input), priorIssuedCents };
  }

  private insertSync(input: CreateServiceCreditInput): ServiceCredit {
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
    return this.sumSync(tenantId, customerId);
  }

  private sumSync(tenantId: string, customerId: string): number {
    // Mirror Postgres `NOW() - INTERVAL '12 months'` semantics:
    // calendar-month subtraction (not a fixed 365-day window) so
    // leap-year + month-end behavior matches the Pg implementation.
    // Strict `>` to match Pg's strict comparison — a row issued
    // exactly at the cutoff instant is excluded.
    const cutoff = new Date(this.now());
    cutoff.setMonth(cutoff.getMonth() - 12);
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

/**
 * #6 phase 4 — saved customer payment methods for off-session dues billing.
 *
 * We persist ONLY Stripe identifiers + non-sensitive display metadata
 * (brand/last4/expiry). Raw card data never reaches our server: the customer
 * enters it in Stripe Elements against a SetupIntent client secret, and Stripe
 * returns a PaymentMethod id we store here. The Stripe customer + payment
 * method live on the tenant's connected account (where dues are charged), so
 * the stored stripe_customer_id is per (tenant, customer) on that account.
 */
export interface CustomerPaymentMethod {
  id: string;
  tenantId: string;
  customerId: string;
  stripeCustomerId: string;
  stripePaymentMethodId: string;
  /**
   * The Stripe account the customer + payment method live on — the tenant's
   * connected account, or undefined for the platform account. Off-session
   * charges MUST target this exact account.
   */
  stripeAccountId?: string;
  brand?: string;
  last4?: string;
  expMonth?: number;
  expYear?: number;
  isDefault: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface CustomerPaymentMethodRepository {
  create(pm: CustomerPaymentMethod): Promise<CustomerPaymentMethod>;
  findByCustomer(tenantId: string, customerId: string): Promise<CustomerPaymentMethod[]>;
  findDefaultForCustomer(
    tenantId: string,
    customerId: string,
  ): Promise<CustomerPaymentMethod | null>;
  findByStripePaymentMethodId(
    tenantId: string,
    stripePaymentMethodId: string,
  ): Promise<CustomerPaymentMethod | null>;
  /** An existing Stripe customer id for this customer (any saved card), or null. */
  findStripeCustomerId(tenantId: string, customerId: string): Promise<string | null>;
  /** Make `id` the sole default for its customer; returns the updated row. */
  setDefault(tenantId: string, id: string): Promise<CustomerPaymentMethod | null>;
}

export class InMemoryCustomerPaymentMethodRepository
  implements CustomerPaymentMethodRepository
{
  private rows = new Map<string, CustomerPaymentMethod>();

  async create(pm: CustomerPaymentMethod): Promise<CustomerPaymentMethod> {
    this.rows.set(pm.id, { ...pm });
    return { ...pm };
  }

  async findByCustomer(tenantId: string, customerId: string): Promise<CustomerPaymentMethod[]> {
    return Array.from(this.rows.values())
      .filter((p) => p.tenantId === tenantId && p.customerId === customerId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((p) => ({ ...p }));
  }

  async findDefaultForCustomer(
    tenantId: string,
    customerId: string,
  ): Promise<CustomerPaymentMethod | null> {
    const found = Array.from(this.rows.values()).find(
      (p) => p.tenantId === tenantId && p.customerId === customerId && p.isDefault,
    );
    return found ? { ...found } : null;
  }

  async findByStripePaymentMethodId(
    tenantId: string,
    stripePaymentMethodId: string,
  ): Promise<CustomerPaymentMethod | null> {
    const found = Array.from(this.rows.values()).find(
      (p) => p.tenantId === tenantId && p.stripePaymentMethodId === stripePaymentMethodId,
    );
    return found ? { ...found } : null;
  }

  async findStripeCustomerId(tenantId: string, customerId: string): Promise<string | null> {
    const found = Array.from(this.rows.values()).find(
      (p) => p.tenantId === tenantId && p.customerId === customerId,
    );
    return found ? found.stripeCustomerId : null;
  }

  async setDefault(tenantId: string, id: string): Promise<CustomerPaymentMethod | null> {
    const target = this.rows.get(id);
    if (!target || target.tenantId !== tenantId) return null;
    for (const p of this.rows.values()) {
      if (p.tenantId === tenantId && p.customerId === target.customerId) {
        p.isDefault = p.id === id;
        p.updatedAt = new Date();
      }
    }
    return { ...this.rows.get(id)! };
  }
}

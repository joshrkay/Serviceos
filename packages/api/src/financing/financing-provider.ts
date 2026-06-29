import { FinancingProvider, FinancingStatus } from './financing';

/**
 * FIN (Jobber parity) — provider abstraction for consumer financing.
 *
 * Mirrors the accounting-provider pattern: a thin interface the orchestration
 * depends on, with a live Wisetack implementation (HTTP, env-gated) and a
 * Manual fallback used when no financing provider is configured. `fetchFn` is
 * injectable so the live client is unit-testable without a network.
 */

export interface FinancingApplicationRequest {
  /** Our application id; echoed to the provider so its webhook can resolve us. */
  applicationId: string;
  tenantId: string;
  amountCents: number;
  invoiceNumber: string;
  customerName: string;
  customerEmail?: string;
  customerPhone?: string;
  returnUrl?: string;
}

export interface FinancingApplicationResult {
  externalId: string | null;
  applicationUrl: string | null;
  status: FinancingStatus;
}

export interface FinancingProviderClient {
  readonly name: FinancingProvider;
  createApplication(
    req: FinancingApplicationRequest,
    idempotencyKey?: string
  ): Promise<FinancingApplicationResult>;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface WisetackConfig {
  apiKey: string;
  /** API base, e.g. https://api-sandbox.wisetack.com. */
  apiBase: string;
  fetchFn?: FetchLike;
}

/**
 * Map a Wisetack transaction status to our FinancingStatus. Unknown statuses
 * fall back to 'offered' (non-terminal) so we never lose the record.
 */
export function mapWisetackStatus(raw: string): FinancingStatus {
  switch (raw.toLowerCase()) {
    case 'authorized':
    case 'approved':
      return 'approved';
    case 'prequalified':
    case 'pre_qualified':
      return 'prequalified';
    case 'settled':
    case 'funded':
      return 'funded';
    case 'declined':
    case 'denied':
      return 'declined';
    case 'expired':
      return 'expired';
    case 'canceled':
    case 'cancelled':
    case 'refunded':
      return 'canceled';
    case 'initiated':
    case 'pending':
    case 'created':
    default:
      return 'offered';
  }
}

export class WisetackFinancingProvider implements FinancingProviderClient {
  readonly name: FinancingProvider = 'wisetack';
  private readonly cfg: WisetackConfig;

  constructor(cfg: WisetackConfig) {
    this.cfg = cfg;
  }

  async createApplication(
    req: FinancingApplicationRequest,
    idempotencyKey?: string
  ): Promise<FinancingApplicationResult> {
    const fetchFn = this.cfg.fetchFn ?? (fetch as unknown as FetchLike);
    const res = await fetchFn(`${this.cfg.apiBase.replace(/\/$/, '')}/v1/transactions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.cfg.apiKey}`,
        'Content-Type': 'application/json',
        ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
      },
      body: JSON.stringify({
        // Wisetack works in dollars; we keep cents internally.
        transaction_amount: req.amountCents / 100,
        merchant_reference: req.invoiceNumber,
        // Echoed back on the webhook so we resolve the row without a tenant scan.
        external_reference: `${req.tenantId}:${req.applicationId}`,
        customer: {
          name: req.customerName,
          email: req.customerEmail,
          mobile_number: req.customerPhone,
        },
        ...(req.returnUrl ? { redirect_url: req.returnUrl } : {}),
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Wisetack createApplication failed (${res.status}): ${body.slice(0, 200)}`);
    }
    const data = (await res.json()) as {
      id?: string;
      transaction_id?: string;
      consumer_url?: string;
      application_url?: string;
      status?: string;
    };
    return {
      externalId: data.transaction_id ?? data.id ?? null,
      applicationUrl: data.consumer_url ?? data.application_url ?? null,
      status: data.status ? mapWisetackStatus(data.status) : 'offered',
    };
  }
}

/**
 * Fallback when no financing provider is configured. Records the offer with no
 * external application — the owner can still track that financing was extended
 * and arrange it manually. Never throws, so offering financing degrades
 * gracefully rather than 500-ing on an unconfigured tenant.
 */
export class ManualFinancingProvider implements FinancingProviderClient {
  readonly name: FinancingProvider = 'manual';
  async createApplication(): Promise<FinancingApplicationResult> {
    return { externalId: null, applicationUrl: null, status: 'offered' };
  }
}

export interface CreateFinancingProviderOptions {
  apiKey?: string;
  apiBase?: string;
  fetchFn?: FetchLike;
}

/**
 * Pick the financing provider: Wisetack when an API key is configured
 * (env WISETACK_API_KEY / WISETACK_API_BASE or explicit opts), else Manual.
 */
export function createFinancingProvider(
  opts: CreateFinancingProviderOptions = {}
): FinancingProviderClient {
  const apiKey = opts.apiKey ?? process.env.WISETACK_API_KEY;
  const apiBase = opts.apiBase ?? process.env.WISETACK_API_BASE ?? 'https://api-sandbox.wisetack.com';
  if (apiKey) {
    return new WisetackFinancingProvider({ apiKey, apiBase, fetchFn: opts.fetchFn });
  }
  return new ManualFinancingProvider();
}

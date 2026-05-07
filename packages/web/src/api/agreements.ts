/**
 * P9-003 — Typed API client for service agreements.
 *
 * The functions take an injectable `fetcher` (matches `useApiClient()`'s
 * fetch shape) so they're trivial to call from React hooks AND to unit
 * test without a real Clerk session.
 */
import type { ApiFetch } from '../lib/apiClient';

export type AgreementStatus = 'active' | 'paused' | 'cancelled';
export type RunStatus = 'pending' | 'generated' | 'skipped' | 'failed';

export interface Agreement {
  id: string;
  tenantId: string;
  customerId: string;
  locationId?: string;
  name: string;
  description?: string;
  recurrenceRule: string;
  priceCents: number;
  autoGenerateInvoice: boolean;
  autoGenerateJob: boolean;
  nextRunAt: string;
  lastRunAt?: string;
  status: AgreementStatus;
  startsOn: string;
  endsOn?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface AgreementRun {
  id: string;
  tenantId: string;
  agreementId: string;
  scheduledFor: string;
  generatedJobId?: string;
  generatedInvoiceId?: string;
  status: RunStatus;
  errorMessage?: string;
  createdAt: string;
}

export interface AgreementWithRuns extends Agreement {
  recentRuns: AgreementRun[];
}

export interface CreateAgreementBody {
  customerId: string;
  locationId?: string;
  name: string;
  description?: string;
  recurrenceRule: string;
  priceCents: number;
  autoGenerateInvoice?: boolean;
  autoGenerateJob?: boolean;
  startsOn: string;
  endsOn?: string;
}

export type UpdateAgreementBody = Partial<
  Pick<
    CreateAgreementBody,
    | 'name'
    | 'description'
    | 'recurrenceRule'
    | 'priceCents'
    | 'autoGenerateInvoice'
    | 'autoGenerateJob'
    | 'endsOn'
  >
>;

async function asJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

export const agreementsApi = {
  async list(
    fetcher: ApiFetch,
    options?: { customerId?: string; status?: AgreementStatus },
  ): Promise<{ data: Agreement[]; total: number }> {
    const params = new URLSearchParams();
    if (options?.customerId) params.set('customerId', options.customerId);
    if (options?.status) params.set('status', options.status);
    const qs = params.toString();
    return asJson(await fetcher(`/api/agreements${qs ? `?${qs}` : ''}`));
  },

  async get(fetcher: ApiFetch, id: string): Promise<AgreementWithRuns> {
    return asJson(await fetcher(`/api/agreements/${id}`));
  },

  async create(fetcher: ApiFetch, body: CreateAgreementBody): Promise<Agreement> {
    return asJson(
      await fetcher('/api/agreements', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    );
  },

  async patch(
    fetcher: ApiFetch,
    id: string,
    body: UpdateAgreementBody,
  ): Promise<Agreement> {
    return asJson(
      await fetcher(`/api/agreements/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    );
  },

  async pause(fetcher: ApiFetch, id: string): Promise<Agreement> {
    return asJson(await fetcher(`/api/agreements/${id}/pause`, { method: 'POST' }));
  },

  async resume(fetcher: ApiFetch, id: string): Promise<Agreement> {
    return asJson(
      await fetcher(`/api/agreements/${id}/resume`, { method: 'POST' }),
    );
  },

  async cancel(fetcher: ApiFetch, id: string): Promise<Agreement> {
    return asJson(
      await fetcher(`/api/agreements/${id}/cancel`, { method: 'POST' }),
    );
  },

  async runNow(
    fetcher: ApiFetch,
    id: string,
  ): Promise<{ generatedRunIds: string[]; skippedRunIds: string[]; failedRunIds: string[] }> {
    return asJson(
      await fetcher(`/api/agreements/${id}/run-now`, { method: 'POST' }),
    );
  },
};

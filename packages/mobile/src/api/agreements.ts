import { decodeError } from '../lib/appError';
import type { AuthedFetch } from './me';

export type AgreementStatus = 'active' | 'paused' | 'cancelled';
export type RunStatus = 'pending' | 'generated' | 'skipped' | 'failed';

export interface AgreementRun {
  id: string;
  scheduledFor: string;
  generatedJobId?: string;
  generatedInvoiceId?: string;
  status: RunStatus;
  errorMessage?: string;
}

export interface Agreement {
  id: string;
  customerId: string;
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
}

export interface AgreementDetail extends Agreement {
  recentRuns: AgreementRun[];
}

async function actOn(client: AuthedFetch, id: string, action: 'pause' | 'resume' | 'cancel'): Promise<void> {
  const res = await client(`/api/agreements/${id}/${action}`, { method: 'POST' });
  if (!res.ok) throw new Error((await decodeError(res)).message);
}

/** POST /api/agreements/:id/pause — stop generating cycles (customers:update). */
export function pauseAgreement(client: AuthedFetch, id: string): Promise<void> {
  return actOn(client, id, 'pause');
}

/** POST /api/agreements/:id/resume — resume a paused agreement (customers:update). */
export function resumeAgreement(client: AuthedFetch, id: string): Promise<void> {
  return actOn(client, id, 'resume');
}

/** POST /api/agreements/:id/cancel — end the agreement (customers:delete → owner only). */
export function cancelAgreement(client: AuthedFetch, id: string): Promise<void> {
  return actOn(client, id, 'cancel');
}

/**
 * Interactions API client.
 *
 * Wraps GET /api/interactions (list) and GET /api/interactions/:id (detail)
 * for the call-log page (QA 15.8 / 15.9).
 */

import { apiFetch } from '../utils/api-fetch';

export interface InteractionCustomer {
  id: string;
  displayName: string;
  address: string | null;
}

export interface InteractionSummary {
  id: string;
  channel: string;
  outcome: string | null;
  callSid: string | null;
  startedAt: string;
  endedAt: string | null;
  durationSeconds: number | null;
  customer: InteractionCustomer | null;
  excerpt: string | null;
  transcriptTurnCount: number;
}

export interface InteractionDetail extends InteractionSummary {
  transcript: string[];
  endedReason: string | null;
  costCents: number;
}

export interface ListInteractionsResponse {
  data: InteractionSummary[];
  total: number;
  limit: number;
  offset: number;
}

export async function listInteractions(opts: {
  limit?: number;
  offset?: number;
  customerId?: string;
} = {}): Promise<ListInteractionsResponse> {
  const params = new URLSearchParams();
  if (opts.limit !== undefined) params.set('limit', String(opts.limit));
  if (opts.offset !== undefined) params.set('offset', String(opts.offset));
  if (opts.customerId) params.set('customerId', opts.customerId);
  const qs = params.toString();
  const res = await apiFetch(qs ? `/api/interactions?${qs}` : '/api/interactions');
  if (!res.ok) throw new Error(`Failed to load interactions: ${res.status}`);
  return (await res.json()) as ListInteractionsResponse;
}

export async function getInteraction(id: string): Promise<InteractionDetail> {
  const res = await apiFetch(`/api/interactions/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`Failed to load interaction: ${res.status}`);
  return (await res.json()) as InteractionDetail;
}

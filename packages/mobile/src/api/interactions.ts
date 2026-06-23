/**
 * Interactions API client — GET /api/interactions (list) and
 * GET /api/interactions/:id (detail) for the mobile call log.
 *
 * Mirrors `packages/web/src/api/interactions.ts`; accepts an AuthedFetch client
 * from `useApiClient` so the Clerk JWT is attached automatically.
 */
import type { AuthedFetch } from './me';

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

export async function listInteractions(
  client: AuthedFetch,
  opts: { limit?: number; offset?: number; customerId?: string } = {},
): Promise<ListInteractionsResponse> {
  const params = new URLSearchParams();
  if (opts.limit !== undefined) params.set('limit', String(opts.limit));
  if (opts.offset !== undefined) params.set('offset', String(opts.offset));
  if (opts.customerId) params.set('customerId', opts.customerId);
  const qs = params.toString();
  const path = qs ? `/api/interactions?${qs}` : '/api/interactions';
  const res = await client(path);
  if (!res.ok) throw new Error(`listInteractions: ${res.status} ${res.statusText}`);
  return (await res.json()) as ListInteractionsResponse;
}

export async function getInteraction(client: AuthedFetch, id: string): Promise<InteractionDetail> {
  const res = await client(`/api/interactions/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`getInteraction: ${res.status} ${res.statusText}`);
  return (await res.json()) as InteractionDetail;
}

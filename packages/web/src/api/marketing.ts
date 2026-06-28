/**
 * MKT (Jobber parity) — customer email campaigns web client.
 *
 * Talks to /api/marketing/campaigns: list, create (draft), and send.
 */
import { apiFetch } from '../utils/api-fetch';

export type CampaignStatus = 'draft' | 'sent';

export interface Campaign {
  id: string;
  tenantId: string;
  name: string;
  subject: string;
  bodyText: string;
  bodyHtml: string | null;
  segmentTag: string | null;
  status: CampaignStatus;
  recipientCount: number;
  sentCount: number;
  failedCount: number;
  sentAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CampaignInput {
  name: string;
  subject: string;
  bodyText: string;
  bodyHtml?: string | null;
  segmentTag?: string | null;
}

async function readJsonOrThrow<T>(res: Response, action: string): Promise<T> {
  if (!res.ok) {
    const json = (await res.json().catch(() => ({}))) as { message?: string };
    throw new Error(json?.message ?? `Failed to ${action}: ${res.status}`);
  }
  return (await res.json()) as T;
}

export async function listCampaigns(): Promise<Campaign[]> {
  const res = await apiFetch('/api/marketing/campaigns');
  const data = await readJsonOrThrow<unknown>(res, 'load campaigns');
  return Array.isArray(data) ? (data as Campaign[]) : [];
}

export async function createCampaign(input: CampaignInput): Promise<Campaign> {
  const res = await apiFetch('/api/marketing/campaigns', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  return readJsonOrThrow<Campaign>(res, 'create campaign');
}

export async function sendCampaign(id: string): Promise<Campaign> {
  const res = await apiFetch(`/api/marketing/campaigns/${encodeURIComponent(id)}/send`, {
    method: 'POST',
  });
  return readJsonOrThrow<Campaign>(res, 'send campaign');
}

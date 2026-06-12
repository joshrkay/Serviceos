import { apiFetch } from '../utils/api-fetch';

export interface AccountingIntegrationSummary {
  id: string;
  provider: 'quickbooks' | 'xero';
  status: string;
  realmId: string;
  connectedAt: string;
  lastSyncedAt: string | null;
  errorMessage: string | null;
}

export interface QuickBooksStatus {
  status: string;
  lastSyncedAt: string | null;
  errorCount24h: number;
  recentSync: Array<{
    entityType: string;
    entityId: string;
    status: string;
    syncedAt: string;
    errorMessage: string | null;
  }>;
}

export async function fetchIntegrations(): Promise<AccountingIntegrationSummary[]> {
  const res = await apiFetch('/api/integrations');
  if (!res.ok) throw new Error(`fetchIntegrations failed: ${res.status}`);
  const json = (await res.json()) as { data: AccountingIntegrationSummary[] };
  return json.data;
}

export async function connectQuickBooks(redirectAfter?: string): Promise<string> {
  const res = await apiFetch('/api/integrations/quickbooks/connect', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(redirectAfter ? { redirectAfter } : {}),
  });
  if (!res.ok) throw new Error(`connectQuickBooks failed: ${res.status}`);
  const json = (await res.json()) as { url: string };
  return json.url;
}

export async function disconnectQuickBooks(): Promise<void> {
  const res = await apiFetch('/api/integrations/quickbooks/disconnect', { method: 'POST' });
  if (!res.ok) throw new Error(`disconnectQuickBooks failed: ${res.status}`);
}

export async function fetchQuickBooksStatus(): Promise<QuickBooksStatus | null> {
  const res = await apiFetch('/api/integrations/quickbooks/status');
  if (!res.ok) throw new Error(`fetchQuickBooksStatus failed: ${res.status}`);
  const json = (await res.json()) as { data: QuickBooksStatus | null };
  return json.data;
}

export async function triggerQuickBooksSync(): Promise<void> {
  const res = await apiFetch('/api/integrations/quickbooks/sync', { method: 'POST' });
  if (!res.ok) throw new Error(`triggerQuickBooksSync failed: ${res.status}`);
}

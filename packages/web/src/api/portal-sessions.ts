import { apiFetch } from '../utils/api-fetch';

export interface PortalSessionResponse {
  id: string;
  url: string;
  expiresAt: string;
}

export async function createPortalSession(
  customerId: string,
  ttlDays?: number,
): Promise<PortalSessionResponse> {
  const res = await apiFetch('/api/portal-sessions', {
    method: 'POST',
    body: JSON.stringify({ customerId, ...(ttlDays ? { ttlDays } : {}) }),
  });
  if (!res.ok) {
    const json = await res.json().catch(() => ({}));
    throw new Error(
      (json as { message?: string }).message ?? `Failed to create portal link (${res.status})`,
    );
  }
  return res.json() as Promise<PortalSessionResponse>;
}

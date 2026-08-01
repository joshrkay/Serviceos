import type { ApiFetch } from '../lib/apiFetch';

/**
 * Open (or lazily create) a customer's comms thread and return its id, so the
 * app can navigate straight into the thread to text a customer who has never
 * messaged in. Idempotent server-side (POST /api/conversations/customer/:id).
 */
export async function startCustomerConversation(
  api: ApiFetch,
  customerId: string,
): Promise<string> {
  const res = await api(`/api/conversations/customer/${customerId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as { conversation: { id: string } };
  return body.conversation.id;
}

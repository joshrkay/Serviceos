/**
 * Authenticated conversations API client.
 *
 * Uses `apiFetch` so the Clerk bearer token is attached (these are
 * tenant-scoped owner/dispatcher routes, not public).
 */
import { apiFetch } from '../utils/api-fetch';

/**
 * Ask the AI for a brand-voiced draft reply to a conversation. Returns the
 * draft text for the composer; never sends a message itself.
 */
export async function suggestReply(conversationId: string): Promise<string> {
  const res = await apiFetch(
    `/api/conversations/${encodeURIComponent(conversationId)}/suggest-reply`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
  );
  if (!res.ok) {
    throw new Error(`Could not draft a reply (${res.status})`);
  }
  const data = (await res.json()) as { draft?: string };
  if (!data.draft) {
    throw new Error('Empty draft');
  }
  return data.draft;
}

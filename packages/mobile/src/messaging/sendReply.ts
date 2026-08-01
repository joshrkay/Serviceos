import type { ApiFetch } from '../lib/apiFetch';
import type { ThreadMessage } from './useConversationThread';

/** Map the reply endpoint's typed failures to owner-friendly copy. */
function replyErrorMessage(status: number): string {
  switch (status) {
    case 403:
      return 'This customer has opted out of texts (replied STOP).';
    case 422:
      return 'No phone or email on file for this customer.';
    case 503:
      return 'Messaging is not set up for this account yet.';
    default:
      return 'Could not send your message. Please try again.';
  }
}

/**
 * Send an owner-authored reply through the business line
 * (POST /api/conversations/:id/reply). Returns the threaded outbound message so
 * the UI can append it optimistically; throws a friendly Error on failure.
 */
export async function sendReply(
  api: ApiFetch,
  conversationId: string,
  body: string,
): Promise<ThreadMessage> {
  const res = await api(`/api/conversations/${conversationId}/reply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ body }),
  });
  if (!res.ok) throw new Error(replyErrorMessage(res.status));
  const payload = (await res.json()) as { message: ThreadMessage };
  return payload.message;
}

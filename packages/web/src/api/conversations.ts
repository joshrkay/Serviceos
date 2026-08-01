/**
 * Authenticated conversations API client.
 *
 * Uses `apiFetch` so the Clerk bearer token is attached (these are
 * tenant-scoped owner/dispatcher routes, not public).
 */
import { apiFetch } from '../utils/api-fetch';
import type { Message } from '../types/conversation';

/** U5 — one row in the unified communication inbox. Mirrors the API's
 *  `InboxThreadSummary`. */
export interface InboxThread {
  conversation: {
    id: string;
    title?: string;
    entityType?: string;
    entityId?: string;
    status: 'open' | 'closed' | 'archived';
    createdAt: string;
    updatedAt: string;
  };
  lastMessageAt: string;
  lastMessagePreview: string;
  lastMessageDirection: 'inbound' | 'outbound';
  needsReply: boolean;
  messageCount: number;
  customerName?: string;
}

export interface ListInboxThreadsParams {
  status?: 'open' | 'closed' | 'archived';
  needsReplyOnly?: boolean;
  limit?: number;
}

/** List comms threads (customer + unmatched phone) for the inbox surface. */
export async function listInboxThreads(
  params: ListInboxThreadsParams = {},
): Promise<InboxThread[]> {
  const qs = new URLSearchParams();
  if (params.status) qs.set('status', params.status);
  if (params.needsReplyOnly) qs.set('needsReplyOnly', 'true');
  if (params.limit) qs.set('limit', String(params.limit));
  const suffix = qs.toString() ? `?${qs.toString()}` : '';
  const res = await apiFetch(`/api/conversations${suffix}`);
  if (!res.ok) {
    throw new Error(`Could not load the inbox (${res.status})`);
  }
  const data = (await res.json()) as { threads?: InboxThread[] };
  return data.threads ?? [];
}

/** Story 3.11 — one history-search hit: the matched message plus the minimal
 *  conversation context needed to label it and deep-link into the thread.
 *  Mirrors the API's `MessageSearchHit`. */
export interface MessageSearchHit {
  message: Message;
  conversation: {
    id: string;
    title?: string;
    entityType?: string;
    entityId?: string;
  };
}

/**
 * Search conversation history by free text (and/or a linked entity). Powers the
 * inbox search box. Returns matched messages newest-first; an empty/whitespace
 * query short-circuits to no results rather than hitting the server.
 */
export async function searchConversations(
  query: string,
  opts: { customerId?: string; jobId?: string; limit?: number } = {},
): Promise<MessageSearchHit[]> {
  const q = query.trim();
  if (!q && !opts.customerId && !opts.jobId) return [];
  const qs = new URLSearchParams();
  if (q) qs.set('q', q);
  if (opts.customerId) qs.set('customerId', opts.customerId);
  if (opts.jobId) qs.set('jobId', opts.jobId);
  if (opts.limit) qs.set('limit', String(opts.limit));
  const res = await apiFetch(`/api/conversations/search?${qs.toString()}`);
  if (!res.ok) {
    throw new Error(`Search failed (${res.status})`);
  }
  const data = (await res.json()) as { results?: MessageSearchHit[] };
  return data.results ?? [];
}

/** Fetch the full message history of one conversation. */
export async function getConversationMessages(
  conversationId: string,
): Promise<Message[]> {
  const res = await apiFetch(
    `/api/conversations/${encodeURIComponent(conversationId)}/messages`,
  );
  if (!res.ok) {
    throw new Error(`Could not load messages (${res.status})`);
  }
  return (await res.json()) as Message[];
}

export interface SendReplyResult {
  message: Message;
  dispatchId: string;
  channel: 'sms' | 'email';
  recipient: string;
}

/**
 * Send an owner-authored free-text reply to the conversation's customer over
 * SMS/email. DNC-gated server-side; throws with the server's reason on a
 * blocked/failed send so the composer can surface it.
 */
export async function sendConversationReply(
  conversationId: string,
  body: string,
  channel?: 'sms' | 'email',
): Promise<SendReplyResult> {
  const res = await apiFetch(
    `/api/conversations/${encodeURIComponent(conversationId)}/reply`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body, ...(channel ? { channel } : {}) }),
    },
  );
  if (!res.ok) {
    let message = `Could not send the reply (${res.status})`;
    try {
      const err = (await res.json()) as { message?: string };
      if (err.message) message = err.message;
    } catch {
      /* keep the default */
    }
    throw new Error(message);
  }
  return (await res.json()) as SendReplyResult;
}

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

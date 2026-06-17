import { useCallback, useEffect, useState } from 'react';
import { ConversationThread } from './ConversationThread';
import { useTenantTimezone } from '../../hooks/useTenantTimezone';
import { formatDateTimeInTenantTz } from '../../utils/formatInTenantTz';
import {
  listInboxThreads,
  getConversationMessages,
  sendConversationReply,
  suggestReply,
  type InboxThread,
} from '../../api/conversations';
import type { Message } from '../../types/conversation';

/**
 * U5 — unified communication inbox.
 *
 * Distinct from the approval-queue `InboxPage` (route `/inbox`): this is the
 * customer-communication triage surface (route `/comms-inbox`). It lists the
 * customer (and unmatched-phone) threads that have inbound activity, newest
 * unanswered first, and lets the owner read the full SMS/email/voice history
 * and reply — with the existing AI "✨ Suggest reply" draft wired through
 * `ConversationThread`.
 *
 * Mobile contract (CLAUDE.md): single-pane on phones (list ⇄ thread), two-pane
 * on `md+`. All interactive rows are ≥44px (`min-h-11`) and every grid track is
 * `minmax(0,…)` with `min-w-0`/`truncate` text so nothing overflows at 320px.
 */
function threadLabel(thread: InboxThread): string {
  return thread.customerName || thread.conversation.title || 'Unknown sender';
}

export function CommsInboxPage(): React.ReactElement {
  const timezone = useTenantTimezone();
  const [threads, setThreads] = useState<InboxThread[]>([]);
  const [loadingThreads, setLoadingThreads] = useState(true);
  const [threadsError, setThreadsError] = useState<string | null>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  const loadThreads = useCallback(async () => {
    setLoadingThreads(true);
    setThreadsError(null);
    try {
      setThreads(await listInboxThreads());
    } catch (err) {
      setThreadsError(err instanceof Error ? err.message : 'Could not load the inbox');
    } finally {
      setLoadingThreads(false);
    }
  }, []);

  useEffect(() => {
    void loadThreads();
  }, [loadThreads]);

  const loadMessages = useCallback(async (conversationId: string) => {
    setLoadingMessages(true);
    setSendError(null);
    try {
      setMessages(await getConversationMessages(conversationId));
    } catch {
      setMessages([]);
    } finally {
      setLoadingMessages(false);
    }
  }, []);

  useEffect(() => {
    if (selectedId) void loadMessages(selectedId);
    else setMessages([]);
  }, [selectedId, loadMessages]);

  const handleSend = useCallback(
    (content: string) => {
      if (!selectedId) return;
      setSendError(null);
      void (async () => {
        try {
          const result = await sendConversationReply(selectedId, content);
          setMessages((prev) => [...prev, result.message]);
          void loadThreads();
        } catch (err) {
          setSendError(err instanceof Error ? err.message : 'Could not send the reply');
        }
      })();
    },
    [selectedId, loadThreads],
  );

  const handleSuggest = useCallback(async (): Promise<string> => {
    if (!selectedId) throw new Error('No conversation selected');
    return suggestReply(selectedId);
  }, [selectedId]);

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-6" data-testid="comms-inbox">
      <h1 className="mb-4 text-xl font-semibold text-gray-900">Inbox</h1>

      <div
        data-testid="comms-inbox-grid"
        className="md:grid md:grid-cols-[minmax(0,20rem)_minmax(0,1fr)] md:gap-4"
      >
        {/* Thread list — hidden on mobile while a thread is open. */}
        <section
          aria-label="Conversations"
          className={selectedId ? 'hidden md:block' : 'block'}
        >
          {loadingThreads && (
            <p className="py-8 text-center text-sm text-gray-500">Loading…</p>
          )}
          {threadsError && (
            <div
              role="alert"
              className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700"
            >
              {threadsError}
            </div>
          )}
          {!loadingThreads && !threadsError && threads.length === 0 && (
            <p className="py-8 text-center text-sm text-gray-500" data-testid="comms-inbox-empty">
              No conversations yet. Customer texts and replies show up here.
            </p>
          )}
          <ul className="divide-y divide-gray-100">
            {threads.map((thread) => {
              const id = thread.conversation.id;
              const active = id === selectedId;
              return (
                <li key={id}>
                  <button
                    type="button"
                    onClick={() => setSelectedId(id)}
                    aria-current={active ? 'true' : undefined}
                    data-testid="comms-thread-row"
                    className={`flex min-h-11 w-full items-start gap-3 px-3 py-3 text-left hover:bg-gray-50 ${
                      active ? 'bg-gray-100' : ''
                    }`}
                  >
                    {thread.needsReply ? (
                      <span
                        aria-label="Needs reply"
                        className="mt-1 h-2 w-2 flex-shrink-0 rounded-full bg-blue-600"
                      />
                    ) : (
                      <span className="mt-1 h-2 w-2 flex-shrink-0" />
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline justify-between gap-2">
                        <span className="truncate font-medium text-gray-900">
                          {threadLabel(thread)}
                        </span>
                        <span className="flex-shrink-0 text-xs text-gray-400">
                          {formatDateTimeInTenantTz(thread.lastMessageAt, timezone)}
                        </span>
                      </span>
                      <span className="block truncate text-sm text-gray-500">
                        {thread.lastMessageDirection === 'outbound' ? 'You: ' : ''}
                        {thread.lastMessagePreview}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>

        {/* Thread view — hidden on mobile until a thread is selected. */}
        <section
          aria-label="Conversation"
          className={selectedId ? 'block' : 'hidden md:block'}
        >
          {!selectedId && (
            <p className="hidden py-8 text-center text-sm text-gray-500 md:block">
              Select a conversation to read and reply.
            </p>
          )}
          {selectedId && (
            <div className="min-w-0">
              <button
                type="button"
                onClick={() => setSelectedId(null)}
                className="mb-3 flex min-h-11 items-center text-sm text-blue-600 md:hidden"
                data-testid="comms-thread-back"
              >
                ← Back to inbox
              </button>
              {sendError && (
                <div
                  role="alert"
                  className="mb-3 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700"
                  data-testid="comms-send-error"
                >
                  {sendError}
                </div>
              )}
              {loadingMessages ? (
                <p className="py-8 text-center text-sm text-gray-500">Loading…</p>
              ) : (
                <ConversationThread
                  messages={messages}
                  onSendMessage={handleSend}
                  onSuggestReply={handleSuggest}
                />
              )}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

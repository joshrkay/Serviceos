import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { ConversationThread } from './ConversationThread';
import { SearchBar } from '../../components/conversations/SearchBar';
import { useTenantTimezone } from '../../hooks/useTenantTimezone';
import { formatDateTimeInTenantTz } from '../../utils/formatInTenantTz';
import {
  listInboxThreads,
  getConversationMessages,
  sendConversationReply,
  suggestReply,
  searchConversations,
  openCustomerConversation,
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
  const [searchParams, setSearchParams] = useSearchParams();
  const conversationFromUrl = searchParams.get('conversation');

  const [threads, setThreads] = useState<InboxThread[]>([]);
  const [loadingThreads, setLoadingThreads] = useState(true);
  const [threadsError, setThreadsError] = useState<string | null>(null);

  const [selectedId, setSelectedId] = useState<string | null>(conversationFromUrl);
  const [messages, setMessages] = useState<Message[]>([]);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  // #680 — outbound channel. 'auto' lets the server keep the thread's own
  // channel (Comms C3); a fresh thread with both a phone and an email on file
  // needs an explicit pick (the API answers channel_selection_required).
  const [channel, setChannel] = useState<'auto' | 'sms' | 'email'>('auto');

  // Story 3.11 — history search. `query` filters the thread list by customer
  // name / preview instantly (client-side) AND by message content (server
  // hits → matchedIds). `matchedIds === null` means no active content search.
  const [query, setQuery] = useState('');
  const [matchedIds, setMatchedIds] = useState<Set<string> | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);

  const handleSearch = useCallback((raw: string) => {
    const trimmed = raw.trim();
    setQuery(trimmed);
    setSearchError(null);
    if (!trimmed) {
      setMatchedIds(null);
      return;
    }
    void (async () => {
      try {
        const hits = await searchConversations(trimmed);
        setMatchedIds(new Set(hits.map((h) => h.conversation.id)));
      } catch (err) {
        // Content search failed — keep the instant client-side label match
        // working and surface the error rather than blanking the list.
        setSearchError(err instanceof Error ? err.message : 'Search failed');
        setMatchedIds(null);
      }
    })();
  }, []);

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

  // Deep link: `/comms-inbox?conversation=<id>` selects that thread.
  useEffect(() => {
    if (conversationFromUrl) setSelectedId(conversationFromUrl);
  }, [conversationFromUrl]);

  // #680 — Customer detail's "Message" links here with `?customerId=<id>`.
  // Open (or create) that customer's thread and land on its composer, so an
  // owner can start an outbound SMS/email with a customer who never texted in.
  // The param is swapped for `?conversation=` so a reload doesn't re-open.
  const customerIdFromUrl = searchParams.get('customerId');
  const [openError, setOpenError] = useState<string | null>(null);
  useEffect(() => {
    if (!customerIdFromUrl) return;
    let cancelled = false;
    setOpenError(null);
    void (async () => {
      try {
        const { id } = await openCustomerConversation(customerIdFromUrl);
        if (cancelled) return;
        setSelectedId(id);
        setSearchParams(
          (prev) => {
            const next = new URLSearchParams(prev);
            next.delete('customerId');
            next.set('conversation', id);
            return next;
          },
          { replace: true },
        );
      } catch (err) {
        if (!cancelled) {
          setOpenError(err instanceof Error ? err.message : 'Could not open this conversation');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [customerIdFromUrl, setSearchParams]);

  const selectThread = useCallback(
    (id: string | null) => {
      setSelectedId(id);
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (id) next.set('conversation', id);
          else next.delete('conversation');
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

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
          const result = await sendConversationReply(
            selectedId,
            content,
            channel === 'auto' ? undefined : channel,
          );
          setMessages((prev) => [...prev, result.message]);
          void loadThreads();
        } catch (err) {
          setSendError(err instanceof Error ? err.message : 'Could not send the reply');
        }
      })();
    },
    [selectedId, loadThreads, channel],
  );

  const handleSuggest = useCallback(async (): Promise<string> => {
    if (!selectedId) throw new Error('No conversation selected');
    return suggestReply(selectedId);
  }, [selectedId]);

  // Filter the loaded threads by the active query: instant label/preview match,
  // plus server message-content matches once they arrive.
  const visibleThreads = useMemo(() => {
    if (!query) return threads;
    const q = query.toLowerCase();
    return threads.filter((t) => {
      const label = (t.customerName || t.conversation.title || '').toLowerCase();
      return (
        label.includes(q) ||
        t.lastMessagePreview.toLowerCase().includes(q) ||
        (matchedIds?.has(t.conversation.id) ?? false)
      );
    });
  }, [threads, query, matchedIds]);

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
          {/* Story 3.11 — search the inbox by customer name or message text. */}
          <div className="mb-3">
            <SearchBar onSearch={handleSearch} placeholder="Search by customer or message…" />
          </div>
          {searchError && (
            <div
              role="alert"
              className="mb-3 rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800"
            >
              {searchError}
            </div>
          )}
          {loadingThreads && (
            <p className="py-8 text-center text-sm text-gray-500">Loading…</p>
          )}
          {openError && (
            <div
              role="alert"
              data-testid="comms-open-error"
              className="mb-3 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700"
            >
              {openError}
            </div>
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
          {!loadingThreads && !threadsError && threads.length > 0 && visibleThreads.length === 0 && (
            <p className="py-8 text-center text-sm text-gray-500" data-testid="comms-inbox-no-matches">
              No conversations match “{query}”.
            </p>
          )}
          <ul className="divide-y divide-gray-100">
            {visibleThreads.map((thread) => {
              const id = thread.conversation.id;
              const active = id === selectedId;
              return (
                <li key={id}>
                  <button
                    type="button"
                    onClick={() => selectThread(id)}
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
                onClick={() => selectThread(null)}
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
                <>
                  <div
                    role="radiogroup"
                    aria-label="Send as"
                    className="mb-2 flex items-center gap-1"
                    data-testid="comms-channel-picker"
                  >
                    <span className="mr-1 text-xs text-gray-500">Send as</span>
                    {(
                      [
                        ['auto', 'Auto'],
                        ['sms', 'Text'],
                        ['email', 'Email'],
                      ] as const
                    ).map(([value, label]) => (
                      <button
                        key={value}
                        type="button"
                        role="radio"
                        aria-checked={channel === value}
                        aria-label={label}
                        onClick={() => setChannel(value)}
                        className={`min-h-11 min-w-11 rounded-full border px-3 text-xs ${
                          channel === value
                            ? 'border-gray-900 bg-gray-900 text-white'
                            : 'border-gray-200 bg-white text-gray-700 hover:bg-gray-50'
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <ConversationThread
                    messages={messages}
                    onSendMessage={handleSend}
                    onSuggestReply={handleSuggest}
                  />
                </>
              )}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

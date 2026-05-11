import { useState, useEffect } from 'react';
import { apiFetch } from '../../utils/api-fetch';
import {
  listInteractions,
  getInteraction,
  type InteractionSummary,
  type InteractionDetail,
} from '../../api/interactions';

// ─── Outcome badge ────────────────────────────────────────────────────────────

function OutcomeBadge({ outcome }: { outcome: string | null }) {
  if (!outcome) return null;
  const map: Record<string, { label: string; className: string }> = {
    completed: { label: 'Completed', className: 'bg-green-100 text-green-700' },
    escalated_to_human: { label: 'Escalated', className: 'bg-amber-100 text-amber-700' },
    callback_required: { label: 'Callback', className: 'bg-blue-100 text-blue-700' },
    dropped: { label: 'Dropped', className: 'bg-red-100 text-red-700' },
    no_intent: { label: 'No intent', className: 'bg-slate-100 text-slate-600' },
    failed: { label: 'Failed', className: 'bg-red-100 text-red-700' },
  };
  const entry = map[outcome] ?? { label: outcome, className: 'bg-slate-100 text-slate-600' };
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${entry.className}`}>
      {entry.label}
    </span>
  );
}

// ─── Channel badge ────────────────────────────────────────────────────────────

function ChannelBadge({ channel }: { channel: string }) {
  const label = channel === 'voice_inbound' ? 'Inbound call'
    : channel === 'inapp_voice' ? 'In-app voice'
    : channel;
  return (
    <span className="inline-flex items-center gap-1 text-xs text-slate-500">
      <Phone size={11} />
      {label}
    </span>
  );
}

// ─── Duration formatter ───────────────────────────────────────────────────────

function formatDuration(seconds: number | null): string {
  if (seconds === null) return '—';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

// ─── Relative time ────────────────────────────────────────────────────────────

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'Just now';
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

// ─── Transcript drawer ────────────────────────────────────────────────────────

function TranscriptDrawer({
  interactionId,
  onClose,
}: {
  interactionId: string;
  onClose: () => void;
}) {
  const [detail, setDetail] = useState<InteractionDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    getInteraction(interactionId)
      .then(setDetail)
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load'))
      .finally(() => setLoading(false));
  }, [interactionId]);

  return (
    <div className="fixed inset-0 z-50 flex items-stretch justify-end">
      {/* backdrop */}
      <div
        className="absolute inset-0 bg-black/20"
        onClick={onClose}
        aria-hidden
      />
      <div className="relative z-10 w-full max-w-lg bg-white shadow-xl flex flex-col">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200">
          <div>
            <h2 className="text-sm font-semibold text-slate-900">Call transcript</h2>
            {detail && (
              <p className="text-xs text-slate-500 mt-0.5">
                {detail.customer?.displayName ?? 'Unknown caller'} ·{' '}
                {new Date(detail.startedAt).toLocaleString()}
              </p>
            )}
          </div>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-slate-600 text-xl leading-none"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5">
          {loading && (
            <div className="flex items-center justify-center py-12 text-slate-400 text-sm">
              <RefreshCw size={16} className="animate-spin mr-2" />
              Loading transcript…
            </div>
          )}

          {error && (
            <div className="flex items-center gap-2 text-red-600 text-sm py-6">
              <AlertCircle size={16} />
              {error}
            </div>
          )}

          {detail && !loading && (
            <>
              <div className="flex flex-wrap gap-2 mb-4">
                <OutcomeBadge outcome={detail.outcome} />
                <ChannelBadge channel={detail.channel} />
                <span className="text-xs text-slate-400">
                  <Clock size={11} className="inline mr-0.5" />
                  {formatDuration(detail.durationSeconds)}
                </span>
              </div>

              {detail.customer && (
                <div className="mb-4 rounded-lg bg-slate-50 p-3 flex items-start gap-2">
                  <User size={14} className="text-slate-400 mt-0.5 shrink-0" />
                  <div>
                    <p className="text-sm font-medium text-slate-800">{detail.customer.displayName}</p>
                    {detail.customer.address && (
                      <p className="text-xs text-slate-500 mt-0.5">{detail.customer.address}</p>
                    )}
                    <a
                      href={`/customers/${detail.customer.id}`}
                      className="text-xs text-indigo-600 hover:underline mt-1 inline-block"
                    >
                      View customer →
                    </a>
                  </div>
                </div>
              )}

              {detail.transcript.length === 0 ? (
                <div className="text-sm text-slate-400 py-6 text-center flex flex-col items-center gap-2">
                  <MessageSquare size={20} className="opacity-40" />
                  No transcript recorded for this call.
                </div>
              ) : (
                <div className="space-y-2">
                  {detail.transcript.map((line, i) => {
                    const isAgent = line.startsWith('agent:');
                    const speaker = isAgent ? 'Agent' : 'Caller';
                    const text = line.replace(/^(agent|caller):\s*/i, '');
                    return (
                      <div
                        key={i}
                        className={`flex gap-2 ${isAgent ? 'flex-row-reverse' : 'flex-row'}`}
                      >
                        <div
                          className={`max-w-[80%] rounded-xl px-3 py-2 text-sm ${
                            isAgent
                              ? 'bg-indigo-100 text-indigo-900 rounded-tr-sm'
                              : 'bg-slate-100 text-slate-800 rounded-tl-sm'
                          }`}
                        >
                          <p className={`text-[10px] font-medium mb-0.5 ${isAgent ? 'text-indigo-500' : 'text-slate-500'}`}>
                            {speaker}
                          </p>
                          {text}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

const PAGE_SIZE = 20;

export function InteractionsPage() {
  const [interactions, setInteractions] = useState<InteractionSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const fetchPage = useCallback(async (pageOffset: number) => {
    setLoading(true);
    setError(null);
    try {
      const result = await listInteractions({ limit: PAGE_SIZE, offset: pageOffset });
      setInteractions(result.data);
      setTotal(result.total);
      setOffset(pageOffset);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load interactions');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchPage(0);
  }, [fetchPage]);

  const totalPages = Math.ceil(total / PAGE_SIZE);
  const currentPage = Math.floor(offset / PAGE_SIZE) + 1;

  return (
    <div className="max-w-4xl mx-auto px-4 py-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">Interactions</h1>
          <p className="text-sm text-slate-500 mt-0.5">
            AI voice call log — {total} completed {total === 1 ? 'call' : 'calls'}
          </p>
        </div>
        <button
          onClick={() => void fetchPage(offset)}
          className="flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-700 transition-colors"
          disabled={loading}
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700 mb-4">
          <AlertCircle size={15} />
          {error}
        </div>
      )}

      {!loading && interactions.length === 0 && !error && (
        <div className="text-center py-16 text-slate-400">
          <Phone size={32} className="mx-auto mb-3 opacity-40" />
          <p className="text-sm">No completed calls yet.</p>
          <p className="text-xs mt-1">Calls will appear here after they end.</p>
        </div>
      )}

      {interactions.length > 0 && (
        <div className="rounded-xl border border-slate-200 overflow-hidden divide-y divide-slate-100 bg-white">
          {interactions.map((interaction) => (
            <button
              key={interaction.id}
              onClick={() => setSelectedId(interaction.id)}
              className="w-full text-left px-5 py-4 hover:bg-slate-50 transition-colors flex items-center gap-4"
            >
              <div className="shrink-0 size-9 rounded-full bg-indigo-50 flex items-center justify-center text-indigo-600">
                <Phone size={16} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-0.5">
                  <span className="text-sm font-medium text-slate-800 truncate">
                    {interaction.customer?.displayName ?? 'Unknown caller'}
                  </span>
                  <OutcomeBadge outcome={interaction.outcome} />
                </div>
                <div className="flex items-center gap-3 text-xs text-slate-500">
                  <ChannelBadge channel={interaction.channel} />
                  <span className="flex items-center gap-1">
                    <Clock size={10} />
                    {formatDuration(interaction.durationSeconds)}
                  </span>
                  <span>{relativeTime(interaction.startedAt)}</span>
                  {interaction.transcriptTurnCount > 0 && (
                    <span className="flex items-center gap-1">
                      <MessageSquare size={10} />
                      {interaction.transcriptTurnCount} turns
                    </span>
                  )}
                </div>
                {interaction.excerpt && (
                  <p className="text-xs text-slate-400 mt-1 truncate">
                    "{interaction.excerpt}"
                  </p>
                )}
              </div>
              <ChevronRight size={16} className="shrink-0 text-slate-300" />
            </button>
          ))}
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between mt-4">
          <p className="text-xs text-slate-500">
            Page {currentPage} of {totalPages} ({total} total)
          </p>
          <div className="flex gap-2">
            <button
              onClick={() => void fetchPage(Math.max(0, offset - PAGE_SIZE))}
              disabled={offset === 0 || loading}
              className="px-3 py-1.5 text-xs rounded-lg border border-slate-200 text-slate-600 disabled:opacity-40 hover:bg-slate-50 transition-colors"
            >
              Previous
            </button>
            <button
              onClick={() => void fetchPage(offset + PAGE_SIZE)}
              disabled={offset + PAGE_SIZE >= total || loading}
              className="px-3 py-1.5 text-xs rounded-lg border border-slate-200 text-slate-600 disabled:opacity-40 hover:bg-slate-50 transition-colors"
            >
              Next
            </button>
          </div>
        </div>
      )}

      {selectedId && (
        <TranscriptDrawer
          interactionId={selectedId}
          onClose={() => setSelectedId(null)}
        />
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// DISPATCH LOG TAB — backed by /api/interactions (message_dispatches)
// ═══════════════════════════════════════════════════════════════════════════

interface MessageDispatch {
  id: string;
  entityType: string;
  entityId: string;
  channel: 'sms' | 'email';
  recipient: string;
  provider: string;
  providerMessageId?: string;
  status: string;
  errorMessage?: string;
  sentAt: string;
  deliveredAt?: string;
}

const CHANNEL_BADGE: Record<string, string> = {
  sms:   'bg-blue-100 text-blue-700',
  email: 'bg-violet-100 text-violet-700',
};
const STATUS_BADGE: Record<string, string> = {
  sent:      'bg-green-100 text-green-700',
  delivered: 'bg-emerald-100 text-emerald-700',
  failed:    'bg-red-100 text-red-700',
  bounced:   'bg-amber-100 text-amber-700',
};
const ENTITY_LABEL: Record<string, string> = {
  estimate:                 'Estimate',
  invoice:                  'Invoice',
  appointment_confirmation: 'Appt Confirmation',
  delay_notice:             'Delay Notice',
};

function DispatchLogTab() {
  const [dispatches, setDispatches] = useState<MessageDispatch[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    apiFetch('/api/interactions?limit=50')
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!cancelled) {
          setDispatches(data.dispatches ?? []);
          setTotal(data.total ?? 0);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load');
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-slate-400 py-8">
        <RefreshCw size={14} className="animate-spin" />
        <span className="text-sm">Loading dispatch log…</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
        <strong>Error loading dispatch log:</strong> {error}
      </div>
    );
  }

  if (dispatches.length === 0) {
    return (
      <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-8 text-center text-sm text-slate-500">
        No outbound messages recorded yet. Send an estimate or invoice to see dispatch records here.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-slate-400">{total} total dispatch{total !== 1 ? 'es' : ''}</p>
      {dispatches.map((d) => (
        <div key={d.id} className="rounded-xl border border-slate-200 bg-white overflow-hidden">
          <div className="flex items-center justify-between px-4 py-2.5 bg-slate-50 border-b border-slate-100">
            <div className="flex items-center gap-2">
              <span className={`rounded-full px-2 py-0.5 text-xs ${CHANNEL_BADGE[d.channel] ?? 'bg-slate-100 text-slate-600'}`}>
                {d.channel.toUpperCase()}
              </span>
              <span className="text-xs text-slate-500">{ENTITY_LABEL[d.entityType] ?? d.entityType}</span>
            </div>
            <span className={`rounded-full px-2 py-0.5 text-xs ${STATUS_BADGE[d.status] ?? 'bg-slate-100 text-slate-500'}`}>
              {d.status}
            </span>
          </div>
          <div className="px-4 py-3 flex flex-col gap-1">
            <p className="text-sm font-medium text-slate-800 truncate">{d.recipient}</p>
            {d.providerMessageId && (
              <p className="text-xs text-slate-400 font-mono truncate">{d.providerMessageId}</p>
            )}
            <p className="text-xs text-slate-400">
              {new Date(d.sentAt).toLocaleString()} · {d.provider}
            </p>
            {d.errorMessage && (
              <p className="text-xs text-red-600 mt-1">{d.errorMessage}</p>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// PAGE WRAPPER
// ═══════════════════════════════════════════════════════════════════════════

const TABS = [
  { id: 'dispatch_log', label: 'Dispatch Log',  count: 0  },
  { id: 'ai',          label: 'AI',             count: 8  },
  { id: 'messaging',   label: 'Messaging',      count: 7  },
  { id: 'scheduling',  label: 'Scheduling',     count: 5  },
  { id: 'records',     label: 'Records',        count: 5  },
  { id: 'financial',   label: 'Financial',      count: 6  },
  { id: 'onboarding',  label: 'Onboarding',     count: 5  },
  { id: 'states',      label: 'System States',  count: 9  },
] as const;
type TabId = typeof TABS[number]['id'];

export function InteractionsPage() {
  const [tab, setTab] = useState<TabId>('dispatch_log');

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Header */}
      <div className="shrink-0 px-5 pt-5 pb-0 border-b border-slate-100 bg-white">
        <div className="max-w-2xl mx-auto">
          <div className="flex items-start justify-between mb-4">
            <div>
              <h1 className="text-slate-900">Interaction Patterns</h1>
              <p className="text-sm text-slate-400 mt-0.5">45 live patterns — click and interact with each</p>
            </div>
            <span className="flex size-8 items-center justify-center rounded-xl bg-indigo-100">
              <Sparkles size={15} className="text-indigo-600" />
            </span>
          </div>
          <div className="flex gap-0.5 overflow-x-auto pb-0" style={{ scrollbarWidth: 'none' }}>
            {TABS.map(t => (
              <button key={t.id} onClick={() => setTab(t.id)}
                className={`flex items-center gap-1.5 px-3.5 py-2.5 text-sm border-b-2 whitespace-nowrap transition-all shrink-0 ${
                  tab === t.id
                    ? 'border-indigo-500 text-indigo-600'
                    : 'border-transparent text-slate-500 hover:text-slate-700'
                }`}>
                {t.label}
                <span className={`rounded-full px-1.5 py-0.5 text-xs ${
                  tab === t.id ? 'bg-indigo-100 text-indigo-600' : 'bg-slate-100 text-slate-500'
                }`}>{t.count}</span>
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-2xl mx-auto px-5 py-6 pb-20 flex flex-col gap-5">

          {/* ── Dispatch Log tab (real API data) ── */}
          {tab === 'dispatch_log' && <DispatchLogTab />}

          {/* ── AI tab ── */}
          {tab === 'ai' && (
            <>
              <DemoCard tag="Propose action" onReset={() => {}}>
                <ProposeDemo />
              </DemoCard>
              <DemoCard tag="Approve action" tagColor="bg-green-100 text-green-700">
                <ApproveDemo />
              </DemoCard>
              <DemoCard tag="Edit action" tagColor="bg-indigo-100 text-indigo-700">
                <EditDemo />
              </DemoCard>
              <DemoCard tag="Reject action" tagColor="bg-red-100 text-red-700">
                <RejectDemo />
              </DemoCard>
              <DemoCard tag="Show brief explanation" tagColor="bg-slate-100 text-slate-600" title="Why this suggestion?">
                <ExplanationDemo />
              </DemoCard>
              <DemoCard tag="Confidence & ambiguity cue" tagColor="bg-amber-100 text-amber-700" title="Tap a card to expand">
                <ConfidenceDemo />
              </DemoCard>
              <DemoCard tag="Ask targeted clarification" tagColor="bg-violet-100 text-violet-700">
                <ClarificationDemo />
              </DemoCard>
              <DemoCard tag="Auto-applied update" tagColor="bg-green-100 text-green-700" title="Silent updates with undo">
                <AutoAppliedDemo />
              </DemoCard>
            </>
          )}

          {/* ── Messaging tab ── */}
          {tab === 'messaging' && (
            <>
              <DemoCard tag="Draft SMS · Review · Send feedback" tagColor="bg-blue-100 text-blue-700" title="Covers 3 patterns">
                <SMSDraftDemo />
              </DemoCard>
              <DemoCard tag="Draft email message" tagColor="bg-blue-100 text-blue-700" title="AI-drafted, fully editable">
                <EmailDraftDemo />
              </DemoCard>
              <DemoCard tag="Reminder / follow-up suggestion" tagColor="bg-violet-100 text-violet-700">
                <FollowUpDemo />
              </DemoCard>
              <DemoCard tag="Appointment confirm · Reschedule notice" tagColor="bg-amber-100 text-amber-700" title="Toggle between types">
                <AppointmentDemo />
              </DemoCard>
            </>
          )}

          {/* ── Scheduling tab ── */}
          {tab === 'scheduling' && (
            <>
              <DemoCard tag="Create schedule from conversation" tagColor="bg-indigo-100 text-indigo-700">
                <CreateFromConvoDemo />
              </DemoCard>
              <DemoCard tag="Move job from conversation" tagColor="bg-blue-100 text-blue-700">
                <MoveJobDemo />
              </DemoCard>
              <DemoCard tag="Assign technician from calendar" tagColor="bg-green-100 text-green-700" title="Thu Mar 12 availability">
                <AssignTechDemo />
              </DemoCard>
              <DemoCard tag="Resolve scheduling conflict" tagColor="bg-red-100 text-red-700">
                <ConflictDemo />
              </DemoCard>
              <DemoCard tag="External calendar sync status" tagColor="bg-slate-100 text-slate-600" title="Tap to cycle states">
                <SyncStatusDemo />
              </DemoCard>
            </>
          )}

          {/* ── Records tab ── */}
          {tab === 'records' && (
            <>
              <DemoCard tag="Resolve customer match" tagColor="bg-amber-100 text-amber-700" title="Match before creating contact">
                <CustomerMatchDemo />
              </DemoCard>
              <DemoCard tag="Resolve job match" tagColor="bg-orange-100 text-orange-700" title="Possible duplicate job">
                <JobMatchDemo />
              </DemoCard>
              <DemoCard tag="Create new lead/job from conversation" tagColor="bg-indigo-100 text-indigo-700">
                <CreateLeadDemo />
              </DemoCard>
              <DemoCard tag="Surface duplicate warning" tagColor="bg-red-100 text-red-700" title="Inline while creating">
                <DuplicateWarningDemo />
              </DemoCard>
              <DemoCard tag="Review suggested merge candidate" tagColor="bg-violet-100 text-violet-700" title="Field-level conflict resolution">
                <MergeCandidateDemo />
              </DemoCard>
            </>
          )}

          {/* ── Financial tab ── */}
          {tab === 'financial' && (
            <>
              <DemoCard tag="Estimate draft from conversation" tagColor="bg-indigo-100 text-indigo-700" title="Plain language → line items">
                <EstimateDraftDemo />
              </DemoCard>
              <DemoCard tag="Pricing suggestion review" tagColor="bg-green-100 text-green-700" title="Per-line accept or keep">
                <PricingReviewDemo />
              </DemoCard>
              <DemoCard tag="Estimate approval capture" tagColor="bg-blue-100 text-blue-700" title="Signature + metadata recorded">
                <ApprovalCaptureDemo />
              </DemoCard>
              <DemoCard tag="Invoice draft from job completion" tagColor="bg-slate-100 text-slate-600" title="Complete → draft → send">
                <InvoiceDraftDemo />
              </DemoCard>
              <DemoCard tag="Hosted payment handoff" tagColor="bg-green-100 text-green-700" title="Link generation + delivery">
                <PaymentHandoffDemo />
              </DemoCard>
              <DemoCard tag="Cancellation / no-show fee suggestion" tagColor="bg-amber-100 text-amber-700">
                <CancellationFeeDemo />
              </DemoCard>
            </>
          )}

          {/* ── Onboarding tab ── */}
          {tab === 'onboarding' && (
            <>
              <DemoCard tag="Voice answer capture · Text fallback" tagColor="bg-red-100 text-red-700" title="Toggle between modes">
                <VoiceCaptureDemo />
              </DemoCard>
              <DemoCard tag="Config proposal review" tagColor="bg-indigo-100 text-indigo-700" title="Toggle inferred settings on/off">
                <ConfigProposalDemo />
              </DemoCard>
              <DemoCard tag="Rule confirmation" tagColor="bg-violet-100 text-violet-700" title="Confirm, edit, or skip">
                <RuleConfirmationDemo />
              </DemoCard>
              <DemoCard tag="Unsupported preference capture" tagColor="bg-slate-100 text-slate-600" title="3 examples — tap to switch">
                <UnsupportedPrefDemo />
              </DemoCard>
            </>
          )}

          {/* ── System States tab ── */}
          {tab === 'states' && (
            <>
              <DemoCard tag="Loading" tagColor="bg-blue-100 text-blue-700" title="Skeleton · Spinner · Progress">
                <LoadingDemo />
              </DemoCard>
              <DemoCard tag="Empty" tagColor="bg-slate-100 text-slate-600" title="Jobs · Invoices · Schedule contexts">
                <EmptyDemo />
              </DemoCard>
              <DemoCard tag="Error" tagColor="bg-red-100 text-red-700" title="Network · Validation · Permission">
                <ErrorDemo />
              </DemoCard>
              <DemoCard tag="Retry" tagColor="bg-amber-100 text-amber-700" title="Exponential backoff + drain animation">
                <RetryDemo />
              </DemoCard>
              <DemoCard tag="Pending review" tagColor="bg-indigo-100 text-indigo-700" title="AI action queue · approve / reject each">
                <PendingReviewDemo />
              </DemoCard>
              <DemoCard tag="Success" tagColor="bg-green-100 text-green-700" title="Toast · Inline · Full-screen">
                <SuccessDemo />
              </DemoCard>
              <DemoCard tag="Partial failure" tagColor="bg-orange-100 text-orange-700" title="Batch send · n of n succeeded">
                <PartialFailureDemo />
              </DemoCard>
              <DemoCard tag="Disconnected / weak connectivity" tagColor="bg-red-100 text-red-700" title="Online · Weak · Offline">
                <DisconnectedDemo />
              </DemoCard>
              <DemoCard tag="Sync delayed" tagColor="bg-amber-100 text-amber-700" title="Escalating staleness · Sync now">
                <SyncDelayedDemo />
              </DemoCard>
            </>
          )}

        </div>
      </div>

      <style>{`@keyframes stepIn { from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)} }`}</style>
    </div>
  );
}

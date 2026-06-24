import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { useUser } from '@clerk/clerk-react';
import {
  AlertCircle, Clock, ChevronRight, ArrowRight,
  DollarSign, FileText, Send, Eye, Briefcase,
  CheckCircle2, Mic, TrendingUp, Bell, MessageSquare,
  UserPlus, CalendarPlus,
} from 'lucide-react';
import { useListQuery } from '../../hooks/useListQuery';
import { listInboxThreads, type InboxThread } from '../../api/conversations';
import { StatCard } from '../ui';
import {
  normalizeJobStatus,
  normalizeEstimateStatus,
  centsToDisplay,
  normalizeJobMoneyState,
  JOB_MONEY_STATE_LABEL,
} from '../../utils/statusNormalize';
import { StatusBadge } from '../shared/StatusBadge';
import { TimeGivenBackCard } from './TimeGivenBackCard';
import { MoneyLoopHomeCard } from './MoneyLoopHomeCard';
import { HfcrHeroCard } from './HfcrHeroCard';
import { VoiceRoiCard } from './VoiceRoiCard';
import { CoreKpisCard } from './CoreKpisCard';
import { PendingProposalsCard } from './PendingProposalsCard';
import { ActivityFeedCard } from './ActivityFeedCard';
import { HomeConversationPanel } from './HomeConversationPanel';
import { ErrorState } from '../ErrorState';
import { EmptyState } from '../EmptyState';
import { useTenantTimezone } from '../../hooks/useTenantTimezone';
import {
  formatDateInTenantTz,
  formatInTenantTz,
  formatTimeInTenantTz,
} from '../../utils/formatInTenantTz';
import { firstNameFromUser, homeGreetingHeading } from '../../utils/greeting';

// ─── API Types ────────────────────────────────────────────────────────────
interface ApiJob {
  id: string;
  jobNumber: string;
  summary: string;
  status: string;
  moneyState?: string;
  priority?: string;
  serviceType?: string;
  scheduledStart?: string;
  customer?: { id: string; displayName?: string; firstName?: string; lastName?: string };
  technician?: { id: string; firstName?: string; lastName?: string; color?: string };
}

interface ApiEstimate {
  id: string;
  estimateNumber: string;
  status: string;
  totalCents: number;
  customer?: { id: string; displayName?: string; firstName?: string; lastName?: string };
  sentAt?: string;
  viewedAt?: string;
}

interface ApiLead {
  id: string;
  firstName?: string;
  lastName?: string;
  companyName?: string;
  stage: string;
  estimatedValueCents?: number;
  sourceDetail?: string;
}

interface ApiInvoice {
  id: string;
  invoiceNumber: string;
  status: string;
  totalCents: number;
  amountDueCents?: number;
  customer?: { id: string; displayName?: string; firstName?: string; lastName?: string };
  dueDate?: string;
}

// ─── Static helpers ───────────────────────────────────────────────────────
const SVC: Record<string, { emoji: string; color: string }> = {
  HVAC:     { emoji: '❄️', color: 'bg-primary/10'   },
  Plumbing: { emoji: '🔧', color: 'bg-success/10'  },
  Painting: { emoji: '🎨', color: 'bg-primary/10' },
};

function initials(name: string) {
  return name.split(' ').map(n => n[0]).join('').slice(0, 2);
}

function customerName(c?: ApiJob['customer']): string {
  if (!c) return 'Customer';
  return c.displayName || [c.firstName, c.lastName].filter(Boolean).join(' ') || 'Customer';
}

function formatTime(iso: string | undefined, timezone: string): string | null {
  if (!iso) return null;
  return formatTimeInTenantTz(iso, timezone);
}

function formatDate(iso: string | undefined, timezone: string): string {
  if (!iso) return '';
  return formatDateInTenantTz(iso, timezone);
}

function todayIso(): string {
  return new Date().toISOString().split('T')[0];
}

function buildWeek(timezone: string): { day: string; date: string; isToday: boolean }[] {
  const today = new Date();
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(today);
    d.setDate(today.getDate() + i);
    return {
      day: formatInTenantTz(d, timezone, { weekday: 'short' }),
      date: formatDateInTenantTz(d, timezone),
      isToday: i === 0,
    };
  });
}

// ─── Section header ───────────────────────────────────────────────────────
function SectionHead({
  label, count, onAll, className = '',
}: { label: string; count?: number; onAll?: () => void; className?: string }) {
  return (
    <div className={`flex items-center justify-between mb-2.5 ${className}`}>
      <div className="flex items-center gap-2">
        <p className="text-sm text-foreground">{label}</p>
        {count !== undefined && (
          <span className="flex items-center justify-center min-w-[18px] h-[18px] rounded-full bg-secondary text-xs text-muted-foreground px-1.5">{count}</span>
        )}
      </div>
      {onAll && (
        <button onClick={onAll} className="flex items-center gap-0.5 text-xs text-primary hover:text-primary transition-colors">
          View all <ArrowRight size={11} />
        </button>
      )}
    </div>
  );
}

// ─── Compact attention row ─────────────────────────────────────────────────
function AttentionRow({
  icon: Icon, iconClass, message, sub, action, actionClass, onAction,
}: {
  icon: React.ElementType; iconClass: string;
  message: string; sub?: string;
  action?: string; actionClass?: string; onAction?: () => void;
}) {
  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <Icon size={14} className={`shrink-0 ${iconClass}`} />
      <div className="flex-1 min-w-0">
        <p className="text-sm text-foreground truncate">{message}</p>
        {sub && <p className="text-xs text-muted-foreground mt-0.5">{sub}</p>}
      </div>
      {action && (
        <button
          onClick={onAction}
          className={`text-xs shrink-0 hover:underline transition-colors ${actionClass ?? 'text-primary'}`}
        >{action} →</button>
      )}
    </div>
  );
}

// ─── Compact job row ──────────────────────────────────────────────────────
function JobRow({ job, onClick }: { job: ApiJob; onClick: () => void }) {
  const tz = useTenantTimezone();
  const svc = SVC[job.serviceType ?? ''] ?? SVC.HVAC;
  const name = customerName(job.customer);
  const uiStatus = normalizeJobStatus(job.status);
  const techName = job.technician
    ? [job.technician.firstName, job.technician.lastName].filter(Boolean).join(' ')
    : null;
  const techColor = job.technician?.color ?? '#94a3b8';
  const scheduledTime = formatTime(job.scheduledStart, tz);
  const moneyState = normalizeJobMoneyState(job.moneyState);
  const moneyLabel = moneyState ? JOB_MONEY_STATE_LABEL[moneyState] : null;
  const moneyBadgeClasses: Record<string, string> = {
    overdue: 'bg-destructive/10 text-destructive',
    paid: 'bg-success/10 text-success',
    invoiced: 'bg-warning/10 text-warning',
    estimate_sent: 'bg-warning/10 text-warning',
  };
  const moneyBadgeClass =
    (moneyState && moneyBadgeClasses[moneyState]) ?? 'bg-primary/10 text-primary';

  return (
    <button
      onClick={onClick}
      className="flex items-center gap-3 w-full px-4 py-3.5 text-left hover:bg-secondary transition-colors group"
    >
      <span className={`flex size-8 shrink-0 items-center justify-center rounded-xl text-base ${svc.color}`}>
        {svc.emoji}
      </span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm text-foreground truncate">{name}</p>
          <div className="flex items-center gap-1.5 shrink-0">
            {moneyLabel && (
              <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-md ${moneyBadgeClass}`}>
                {moneyLabel}
              </span>
            )}
            <StatusBadge status={uiStatus} size="sm" />
          </div>
        </div>
        <div className="flex items-center gap-2 mt-0.5">
          {scheduledTime && (
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              <Clock size={10} /> {scheduledTime}
            </span>
          )}
          {techName && (
            <span
              className="flex size-4 shrink-0 items-center justify-center rounded-full text-primary-foreground"
              style={{ backgroundColor: techColor, fontSize: 9 }}
            >
              {initials(techName)}
            </span>
          )}
          {job.priority === 'urgent' && (
            <span className="flex items-center gap-0.5 text-xs text-destructive">
              <AlertCircle size={10} /> Urgent
            </span>
          )}
        </div>
      </div>
      <ChevronRight size={13} className="shrink-0 text-muted-foreground group-hover:text-muted-foreground transition-colors" />
    </button>
  );
}

// ─── This week strip ──────────────────────────────────────────────────────
function WeekStrip({ todayCount }: { todayCount: number }) {
  const tz = useTenantTimezone();
  const WEEK = buildWeek(tz);
  return (
    <div className="flex gap-2 overflow-x-auto pb-1" style={{ scrollbarWidth: 'none' }}>
      {WEEK.map((d, i) => {
        const n = d.isToday ? todayCount : 0;
        return (
          <div
            key={d.date}
            className={`flex flex-col items-center rounded-xl px-3 py-3 min-w-[60px] shrink-0 transition-all ${
              d.isToday ? 'bg-primary text-primary-foreground' : 'bg-card border border-border'
            }`}
          >
            <p className={`text-xs mb-0.5 ${d.isToday ? 'text-muted-foreground' : 'text-muted-foreground'}`}>{d.day}</p>
            <p className={`leading-none mb-1 ${d.isToday ? 'text-primary-foreground' : 'text-foreground'}`} style={{ fontSize: '1.15rem' }}>
              {n > 0 ? n : '—'}
            </p>
            <p className={`text-center ${d.isToday ? 'text-muted-foreground' : 'text-muted-foreground'}`} style={{ fontSize: 9 }}>
              {d.isToday ? 'TODAY' : d.date.split(' ')[1]}
            </p>
            {n > 0 && !d.isToday && (
              <div className="flex gap-0.5 mt-1">
                {Array.from({ length: Math.min(n, 3) }).map((_, j) => (
                  <span key={j} className="size-1 rounded-full bg-primary" />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── Main dashboard ───────────────────────────────────────────────────────
export function HomePage() {
  const navigate   = useNavigate();
  const tz         = useTenantTimezone();
  const { user }   = useUser();
  const [dismissed, setDismiss] = useState<Set<string>>(new Set());

  const ownerFirstName = firstNameFromUser(
    user?.fullName,
    user?.primaryEmailAddress?.emailAddress,
  );
  const greetingHeading = homeGreetingHeading(ownerFirstName, new Date(), tz);

  const today = todayIso();
  const todayDate = new Date(); todayDate.setHours(0, 0, 0, 0);

  // Story 10.7 — surface unread customer replies (newest message inbound) on
  // the home page so two-way threads needing a response aren't missed.
  const [unreadThreads, setUnreadThreads] = useState<InboxThread[]>([]);
  useEffect(() => {
    let active = true;
    listInboxThreads({ needsReplyOnly: true, limit: 20 })
      .then((threads) => { if (active) setUnreadThreads(threads); })
      .catch(() => { if (active) setUnreadThreads([]); });
    return () => { active = false; };
  }, []);

  // Epic 12.2 — the home dashboard auto-refreshes the "today" panels so the
  // owner sees new jobs/estimates/invoices/leads without a manual reload.
  const LIVE_REFETCH_MS = 60_000;
  const jobsQuery = useListQuery<ApiJob>('/api/jobs', { filters: { scheduledDate: today }, refetchInterval: LIVE_REFETCH_MS });
  const estimatesQuery = useListQuery<ApiEstimate>('/api/estimates', { filters: { status: 'sent' }, refetchInterval: LIVE_REFETCH_MS });
  const invoicesQuery = useListQuery<ApiInvoice>('/api/invoices', { filters: { status: 'open' }, refetchInterval: LIVE_REFETCH_MS });
  const leadsQuery = useListQuery<ApiLead>('/api/leads', { filters: { limit: '50' }, refetchInterval: LIVE_REFETCH_MS });
  const leads = leadsQuery.data ?? [];

  const todayJobs    = jobsQuery.data.filter(j => normalizeJobStatus(j.status) !== 'Canceled');
  // Epic 12.2 — unassigned work for today (no technician on the job).
  const unassignedToday = todayJobs.filter(j => !j.technician);
  const pendingEsts  = estimatesQuery.data.filter(e => {
    const uiStatus = normalizeEstimateStatus(e.status);
    return uiStatus === 'Sent';
  });
  const unpaidInvs   = invoicesQuery.data;
  const totalOut     = unpaidInvs.reduce((s, i) => s + (i.totalCents ?? 0), 0) / 100;
  const activeCount  = todayJobs.filter(j => {
    const s = normalizeJobStatus(j.status);
    return s === 'In Progress' || s === 'New';
  }).length;

  const isOverdue = (inv: ApiInvoice) => inv.dueDate ? new Date(inv.dueDate) < todayDate : false;
  const overdueInvs = unpaidInvs.filter(isOverdue);

  // Build attention items
  const attentionItems = [
    ...unreadThreads.map(t => ({
      id: `reply-${t.conversation.id}`, type: 'reply' as const,
      message: `${t.customerName ?? 'Customer'} replied`,
      sub: t.lastMessagePreview || 'New message',
      action: 'Reply', to: '/comms-inbox',
    })),
    ...overdueInvs.map(i => ({
      id: `inv-${i.id}`, type: 'overdue' as const,
      message: `${customerName(i.customer)} — invoice overdue`,
      sub: `${i.invoiceNumber} · ${centsToDisplay(i.totalCents)} · Was due ${i.dueDate ?? ''}`,
      action: 'Remind', to: `/invoices/${i.id}`,
    })),
    ...pendingEsts.filter(e => !dismissed.has(`est-${e.id}`)).map(e => ({
      id: `est-${e.id}`, type: 'followup' as const,
      message: `${customerName(e.customer)} estimate not yet opened`,
      sub: `${e.estimateNumber} · ${centsToDisplay(e.totalCents)}${e.sentAt ? ` · Sent ${formatDate(e.sentAt, tz)}` : ''}`,
      action: 'Follow up', to: `/estimates/${e.id}`,
    })),
  ].filter(item => !dismissed.has(item.id));

  const ATTN_STYLE = {
    overdue:  { icon: AlertCircle,  ic: 'text-destructive',    border: 'border-destructive/20',   bg: 'bg-destructive/10'    },
    followup: { icon: Eye,          ic: 'text-primary', border: 'border-primary/20',bg: 'bg-primary/10' },
    reply:    { icon: MessageSquare,ic: 'text-primary',   border: 'border-primary/20',  bg: 'bg-primary/10'   },
  };

  return (
    <div className="h-full overflow-y-auto pb-20 md:pb-0">
      <div className="max-w-6xl mx-auto">
        {/* ── Header ── */}
        <div className="px-4 md:px-6 pt-5 pb-4 border-b border-border">
          <div className="flex items-start justify-between">
            <div>
              <h1 className="text-foreground">{greetingHeading}</h1>
              <p className="text-sm text-muted-foreground mt-0.5">
                {formatInTenantTz(new Date(), tz, { weekday: 'long', month: 'long', day: 'numeric' })}
              </p>
            </div>
            <button
              onClick={() => navigate('/assistant')}
              className="flex items-center gap-1.5 rounded-xl bg-primary text-primary-foreground px-3.5 py-2.5 text-sm hover:bg-primary/90 transition-colors shrink-0"
            >
              <Mic size={13} /> Ask AI
            </button>
          </div>

          {/* 3-stat pulse — calm StatCard tiles (tone tints only the icon
              chip, per the design vision). Each tile is a button that
              drills into the matching surface. */}
          <div className="grid grid-cols-3 gap-3 mt-4">
            <button
              type="button"
              onClick={() => navigate('/jobs')}
              className="rounded-2xl text-left transition-shadow hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            >
              <StatCard
                className="h-full"
                tone="info"
                label="Active today"
                value={activeCount}
                hint="jobs"
                icon={<Briefcase size={16} />}
              />
            </button>
            <button
              type="button"
              onClick={() => navigate('/reports/money')}
              data-testid="home-stat-outstanding"
              className="rounded-2xl text-left transition-shadow hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            >
              <StatCard
                className="h-full"
                tone="warning"
                label="Outstanding"
                value={`$${totalOut.toLocaleString()}`}
                hint={`${unpaidInvs.length} unpaid`}
                icon={<DollarSign size={16} />}
              />
            </button>
            <button
              type="button"
              onClick={() => navigate(attentionItems.length > 0 ? '/invoices' : '/inbox')}
              data-testid="home-stat-attention"
              className="rounded-2xl text-left transition-shadow hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            >
              <StatCard
                className="h-full"
                tone={attentionItems.length > 0 ? 'danger' : 'success'}
                label="Needs attention"
                value={`${attentionItems.length} items`}
                hint={attentionItems.length > 0 ? 'review now' : 'all clear'}
                icon={attentionItems.length > 0 ? <AlertCircle size={16} /> : <CheckCircle2 size={16} />}
              />
            </button>
          </div>
        </div>

        {/* Story 3.1 — the running conversation, surfaced prominently on Home
            (alongside the dashboard, not replacing it). */}
        <HomeConversationPanel />

        <HfcrHeroCard />

        <VoiceRoiCard />

        <MoneyLoopHomeCard />

        {/* ── Core KPIs (revenue, receivables, MoM) ── */}
        <CoreKpisCard />

        {/* ── Time given back ── */}
        <TimeGivenBackCard />

        {/* ── Two-column layout ── */}
        <div className="flex flex-col md:grid md:grid-cols-[1fr_320px] md:items-start divide-y md:divide-y-0 md:divide-x divide-slate-100">

          {/* ─── Left: Operational ─── */}
          <div className="flex flex-col divide-y divide-slate-100">

            {/* Today's jobs */}
            <section className="px-4 md:px-6 py-5">
              <SectionHead label="Today's jobs" count={todayJobs.length} onAll={() => navigate('/jobs')} />
              {jobsQuery.isLoading ? (
                <div className="flex items-center justify-center py-8">
                  <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                </div>
              ) : jobsQuery.error ? (
                <ErrorState
                  message={jobsQuery.error.includes('401') ? "Session expired — please reload" : "Couldn't load jobs — please try again"}
                  onRetry={() => jobsQuery.refetch()}
                />
              ) : todayJobs.length === 0 ? (
                <EmptyState
                  title="No jobs scheduled today"
                  description="Schedule your first job and it'll show up right here."
                  actionLabel="Schedule a job"
                  onAction={() => navigate(`/assistant?q=${encodeURIComponent('Schedule a new job')}`)}
                  icon={<Briefcase size={20} />}
                />
              ) : (
                <>
                  {/* Epic 12.2 — unassigned work surfaces with a one-tap path to
                      the dispatch board where it can be assigned. */}
                  {unassignedToday.length > 0 && (
                    <button
                      onClick={() => navigate('/dispatch')}
                      data-testid="home-unassigned"
                      className="mb-2 flex min-h-11 w-full items-center gap-2 rounded-xl border border-warning/30 bg-warning/10 px-4 text-left text-sm text-warning transition-colors hover:bg-warning/20"
                    >
                      <AlertCircle size={14} className="shrink-0 text-warning" />
                      <span className="flex-1">
                        {unassignedToday.length} unassigned {unassignedToday.length === 1 ? 'job' : 'jobs'} — assign on the dispatch board
                      </span>
                      <ArrowRight size={13} className="shrink-0" />
                    </button>
                  )}
                  <div className="rounded-xl bg-card border border-border overflow-hidden divide-y divide-slate-100">
                    {todayJobs.map(job => (
                      <JobRow key={job.id} job={job} onClick={() => navigate(`/jobs/${job.id}`)} />
                    ))}
                  </div>
                </>
              )}
            </section>

            {/* This week */}
            <section className="px-4 md:px-6 py-5">
              <SectionHead label="This week" onAll={() => navigate('/schedule')} />
              <WeekStrip todayCount={todayJobs.length} />
            </section>
          </div>

          {/* ─── Right: Financial & Attention ─── */}
          <div className="flex flex-col divide-y divide-slate-100">

            {/* Leads pipeline widget */}
            <section className="px-4 py-5">
              <div className="flex items-center justify-between mb-2.5">
                <div className="flex items-center gap-2">
                  <TrendingUp size={14} className="text-primary" />
                  <p className="text-sm text-foreground">Lead pipeline</p>
                </div>
                <button onClick={() => navigate('/leads')} className="flex items-center gap-0.5 text-xs text-primary hover:text-primary transition-colors">
                  View all <ArrowRight size={11} />
                </button>
              </div>
              {(() => {
                const pipeline = leads.filter((l) => l.stage !== 'won' && l.stage !== 'lost');
                const newLeads = leads.filter((l) => l.stage === 'new');
                const pipelineValueCents = pipeline.reduce(
                  (s, l) => s + (l.estimatedValueCents ?? 0),
                  0,
                );
                const leadDisplayName = (l: ApiLead) =>
                  [l.firstName, l.lastName].filter(Boolean).join(' ')
                  || l.companyName
                  || 'Lead';
                return (
                  <div className="rounded-xl bg-card border border-border overflow-hidden">
                    <div className="flex divide-x divide-slate-100">
                      {[
                        { label: 'New', count: leads.filter((l) => l.stage === 'new').length, color: 'text-primary', dot: 'bg-primary' },
                        { label: 'Contacted', count: leads.filter((l) => l.stage === 'contacted').length, color: 'text-warning', dot: 'bg-warning' },
                        { label: 'Quoted', count: leads.filter((l) => l.stage === 'quoted').length, color: 'text-primary', dot: 'bg-primary' },
                      ].map(({ label, count, color, dot }) => (
                        <button key={label} onClick={() => navigate('/leads')} className="flex-1 flex flex-col items-center py-3.5 hover:bg-secondary transition-colors">
                          <span className={`flex size-1.5 rounded-full mb-1.5 ${dot}`} />
                          <p className={`text-xs ${color}`}>{count}</p>
                          <p className="text-xs text-muted-foreground mt-0.5">{label}</p>
                        </button>
                      ))}
                    </div>
                    {newLeads.length > 0 && (
                      <div className="border-t border-border px-4 py-3">
                        <button onClick={() => navigate('/leads')} className="flex items-center gap-2.5 w-full text-left hover:opacity-80 transition-opacity">
                          <span className="size-1.5 rounded-full bg-primary shrink-0 animate-pulse" />
                          <p className="text-xs text-muted-foreground flex-1">
                            <span className="text-foreground">{leadDisplayName(newLeads[0]!)}</span>
                            {newLeads[0]!.sourceDetail && (
                              <>
                                {' '}— {newLeads[0]!.sourceDetail!.slice(0, 45)}
                                {newLeads[0]!.sourceDetail!.length > 45 ? '…' : ''}
                              </>
                            )}
                          </p>
                          <ChevronRight size={12} className="text-muted-foreground shrink-0" />
                        </button>
                      </div>
                    )}
                    <div className="border-t border-border px-4 py-2.5 bg-secondary">
                      <p className="text-xs text-muted-foreground">
                        ${(pipelineValueCents / 100).toLocaleString()} est. pipeline value · {pipeline.length} active
                      </p>
                    </div>
                  </div>
                );
              })()}
            </section>

            {/* Needs attention */}
            {attentionItems.length > 0 && (
              <section className="px-4 py-5">
                <SectionHead label="Needs attention" count={attentionItems.length} />
                <div className="flex flex-col gap-2">
                  {attentionItems.map(item => {
                    const style = ATTN_STYLE[item.type];
                    return (
                      <div
                        key={item.id}
                        className={`rounded-xl border ${style.border} ${style.bg} overflow-hidden`}
                      >
                        <AttentionRow
                          icon={style.icon}
                          iconClass={style.ic}
                          message={item.message}
                          sub={item.sub}
                          action={item.action}
                          actionClass={item.type === 'overdue' ? 'text-destructive' : 'text-primary'}
                          onAction={() => navigate(item.to)}
                        />
                      </div>
                    );
                  })}
                </div>
              </section>
            )}

            {/* Pending estimates */}
            {(estimatesQuery.isLoading || estimatesQuery.error || pendingEsts.length > 0) && (
              <section className="px-4 py-5">
                <SectionHead label="Pending estimates" count={pendingEsts.length} onAll={() => navigate('/estimates')} />
                {estimatesQuery.isLoading ? (
                  <div className="flex items-center justify-center py-6">
                    <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                  </div>
                ) : estimatesQuery.error ? (
                  <ErrorState
                    message={estimatesQuery.error.includes('401') ? "Session expired — please reload" : "Couldn't load estimates — please try again"}
                    onRetry={() => estimatesQuery.refetch()}
                  />
                ) : (
                  <div className="rounded-xl bg-card border border-border divide-y divide-slate-100 overflow-hidden">
                    {pendingEsts.map(est => (
                      <button
                        key={est.id}
                        onClick={() => navigate(`/estimates/${est.id}`)}
                        className="flex items-center gap-3 w-full px-4 py-3.5 text-left hover:bg-secondary transition-colors group"
                      >
                        <div className="flex size-8 items-center justify-center rounded-xl shrink-0 bg-primary/10">
                          <Send size={14} className="text-primary" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm text-foreground truncate">{customerName(est.customer)}</p>
                          <p className="text-xs text-muted-foreground mt-0.5">
                            {est.estimateNumber}{est.sentAt ? ` · Sent ${formatDate(est.sentAt, tz)}` : ''}
                          </p>
                        </div>
                        <div className="flex flex-col items-end gap-1 shrink-0">
                          <p className="text-sm text-foreground">{centsToDisplay(est.totalCents)}</p>
                          <StatusBadge status={normalizeEstimateStatus(est.status)} size="sm" />
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </section>
            )}

            {/* Unpaid invoices */}
            {(invoicesQuery.isLoading || invoicesQuery.error || unpaidInvs.length > 0) && (
              <section className="px-4 py-5">
                <div className="flex items-center justify-between mb-2.5">
                  <div className="flex items-center gap-2">
                    <p className="text-sm text-foreground">Outstanding invoices</p>
                    <span className="flex items-center justify-center min-w-[18px] h-[18px] rounded-full bg-secondary text-xs text-muted-foreground px-1.5">{unpaidInvs.length}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-warning">${totalOut.toLocaleString()}</span>
                    <button onClick={() => navigate('/reports/money')} className="flex items-center gap-0.5 text-xs text-primary hover:text-primary">
                      Money summary <ArrowRight size={11} />
                    </button>
                  </div>
                </div>
                {invoicesQuery.isLoading ? (
                  <div className="flex items-center justify-center py-6">
                    <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                  </div>
                ) : invoicesQuery.error ? (
                  <ErrorState
                    message={invoicesQuery.error.includes('401') ? "Session expired — please reload" : "Couldn't load invoices — please try again"}
                    onRetry={() => invoicesQuery.refetch()}
                  />
                ) : (
                  <div className="rounded-xl bg-card border border-border divide-y divide-slate-100 overflow-hidden">
                    {unpaidInvs.map(inv => {
                      const overdue = isOverdue(inv);
                      return (
                        <button
                          key={inv.id}
                          onClick={() => navigate(`/invoices/${inv.id}`)}
                          className="flex items-center gap-3 w-full px-4 py-3.5 text-left hover:bg-secondary transition-colors"
                        >
                          <div className={`flex size-8 items-center justify-center rounded-xl shrink-0 ${
                            overdue ? 'bg-destructive/10' : 'bg-warning/10'
                          }`}>
                            <DollarSign size={14} className={overdue ? 'text-destructive' : 'text-warning'} />
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-sm text-foreground truncate">{customerName(inv.customer)}</p>
                            <p className={`text-xs mt-0.5 ${overdue ? 'text-destructive' : 'text-muted-foreground'}`}>
                              {inv.invoiceNumber}
                              {overdue ? ` · OVERDUE since ${inv.dueDate ?? ''}` : inv.dueDate ? ` · Due ${inv.dueDate}` : ''}
                            </p>
                          </div>
                          <div className="flex flex-col items-end gap-1 shrink-0">
                            <p className="text-sm text-foreground">{centsToDisplay(inv.totalCents)}</p>
                            <StatusBadge status={overdue ? 'Overdue' : 'Unpaid'} size="sm" />
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}
              </section>
            )}

            {/* Quick actions — each opens the conversational flow (Epic 12.8):
                the assistant auto-submits the prefilled `q` and drafts a
                proposal for approval, so creates stay proposal-first. */}
            <section className="px-4 py-5">
              <SectionHead label="Quick actions" />
              <div className="grid grid-cols-2 gap-2">
                {[
                  { label: 'Add customer',  icon: UserPlus,     color: 'text-primary',   bg: 'bg-primary/10',   q: 'Add a new customer'    },
                  { label: 'Schedule',      icon: CalendarPlus, color: 'text-primary', bg: 'bg-primary/10', q: 'Schedule a new job'    },
                  { label: 'New estimate',  icon: FileText,     color: 'text-primary', bg: 'bg-primary/10', q: 'Create a new estimate' },
                  { label: 'New invoice',   icon: DollarSign,   color: 'text-warning',  bg: 'bg-warning/10',  q: 'Create a new invoice'  },
                ].map(({ label, icon: Icon, color, bg, q }) => (
                  <button
                    key={label}
                    onClick={() => navigate(`/assistant?q=${encodeURIComponent(q)}`)}
                    className="flex min-h-11 items-center gap-2 rounded-xl bg-card border border-border px-3.5 py-3 text-left hover:border-border hover:shadow-sm transition-all"
                  >
                    <span className={`flex size-7 items-center justify-center rounded-lg ${bg} shrink-0`}>
                      <Icon size={14} className={color} />
                    </span>
                    <span className="text-sm text-foreground">{label}</span>
                  </button>
                ))}
              </div>
            </section>

            {/* Recent activity feed (Epic 12.7) */}
            <ActivityFeedCard />

            {/* All clear */}
            {attentionItems.length === 0 && unpaidInvs.length === 0 && pendingEsts.length === 0 && !jobsQuery.isLoading && !estimatesQuery.isLoading && !invoicesQuery.isLoading && !jobsQuery.error && !estimatesQuery.error && !invoicesQuery.error && (
              <section className="px-4 py-8 flex flex-col items-center gap-2">
                <CheckCircle2 size={28} className="text-success" />
                <p className="text-sm text-muted-foreground">All clear — nothing urgent</p>
                <p className="text-xs text-muted-foreground">You're on top of everything today</p>
              </section>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

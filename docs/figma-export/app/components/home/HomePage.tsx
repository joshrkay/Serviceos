import { useState } from 'react';
import { useNavigate } from 'react-router';
import {
  AlertCircle, Clock, ChevronRight, ArrowRight, CalendarDays,
  DollarSign, FileText, Zap, Send, Eye, Calendar, Plus,
  CheckCircle2, Mic, TrendingUp,
} from 'lucide-react';
import {
  jobs, estimates, invoices, aiProposals, leads,
  calcEstimateTotal, calcInvoiceTotal,
} from '../../data/mock-data';
import { StatusBadge } from '../shared/StatusBadge';

// ─── Static helpers ───────────────────────────────────────────────────────
const SVC: Record<string, { emoji: string; color: string }> = {
  HVAC:     { emoji: '❄️', color: 'bg-blue-100'   },
  Plumbing: { emoji: '🔧', color: 'bg-green-100'  },
  Painting: { emoji: '🎨', color: 'bg-violet-100' },
};

const TECH_COLORS: Record<string, string> = {
  'Carlos Reyes': '#3B82F6',
  'Marcus Webb':  '#10B981',
  'Sarah Lin':    '#8B5CF6',
};

function initials(name: string) {
  return name.split(' ').map(n => n[0]).join('').slice(0, 2);
}

// Mar 10 = Tue. Today = index 0 in this week strip.
const WEEK = [
  { day: 'Tue', date: 'Mar 10', isToday: true  },
  { day: 'Wed', date: 'Mar 11', isToday: false },
  { day: 'Thu', date: 'Mar 12', isToday: false },
  { day: 'Fri', date: 'Mar 13', isToday: false },
  { day: 'Sat', date: 'Mar 14', isToday: false },
  { day: 'Sun', date: 'Mar 15', isToday: false },
  { day: 'Mon', date: 'Mar 16', isToday: false },
];

// ─── Section header ───────────────────────────────────────────────────────
function SectionHead({
  label, count, onAll, className = '',
}: { label: string; count?: number; onAll?: () => void; className?: string }) {
  return (
    <div className={`flex items-center justify-between mb-2.5 ${className}`}>
      <div className="flex items-center gap-2">
        <p className="text-sm text-slate-700">{label}</p>
        {count !== undefined && (
          <span className="flex items-center justify-center min-w-[18px] h-[18px] rounded-full bg-slate-200 text-xs text-slate-600 px-1.5">{count}</span>
        )}
      </div>
      {onAll && (
        <button onClick={onAll} className="flex items-center gap-0.5 text-xs text-blue-600 hover:text-blue-700 transition-colors">
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
        <p className="text-sm text-slate-800 truncate">{message}</p>
        {sub && <p className="text-xs text-slate-400 mt-0.5">{sub}</p>}
      </div>
      {action && (
        <button
          onClick={onAction}
          className={`text-xs shrink-0 hover:underline transition-colors ${actionClass ?? 'text-blue-600'}`}
        >{action} →</button>
      )}
    </div>
  );
}

// ─── Compact job row ──────────────────────────────────────────────────────
function JobRow({ job, onClick }: { job: typeof jobs[0]; onClick: () => void }) {
  const svc = SVC[job.serviceType] ?? SVC.HVAC;
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-3 w-full px-4 py-3.5 text-left hover:bg-slate-50 transition-colors group"
    >
      <span className={`flex size-8 shrink-0 items-center justify-center rounded-xl text-base ${svc.color}`}>
        {svc.emoji}
      </span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm text-slate-900 truncate">{job.customer}</p>
          <StatusBadge status={job.status} size="sm" />
        </div>
        <div className="flex items-center gap-2 mt-0.5">
          {job.scheduledTime && (
            <span className="flex items-center gap-1 text-xs text-slate-400">
              <Clock size={10} /> {job.scheduledTime}
            </span>
          )}
          {job.assignedTech && (
            <span
              className="flex size-4 shrink-0 items-center justify-center rounded-full text-white"
              style={{ backgroundColor: TECH_COLORS[job.assignedTech] ?? '#94a3b8', fontSize: 9 }}
            >
              {initials(job.assignedTech)}
            </span>
          )}
          {job.priority === 'Urgent' && (
            <span className="flex items-center gap-0.5 text-xs text-red-500">
              <AlertCircle size={10} /> Urgent
            </span>
          )}
        </div>
      </div>
      <ChevronRight size={13} className="shrink-0 text-slate-300 group-hover:text-slate-400 transition-colors" />
    </button>
  );
}

// ─── This week strip ──────────────────────────────────────────────────────
function WeekStrip() {
  const todayCount    = jobs.filter(j => j.scheduledDate === 'Today').length;
  const tomorrowCount = jobs.filter(j => j.scheduledDate === 'Tomorrow').length;
  const counts = [todayCount, tomorrowCount, 0, 0, 0, 0, 0];

  return (
    <div className="flex gap-2 overflow-x-auto pb-1" style={{ scrollbarWidth: 'none' }}>
      {WEEK.map((d, i) => {
        const n = counts[i];
        return (
          <div
            key={d.date}
            className={`flex flex-col items-center rounded-xl px-3 py-3 min-w-[60px] shrink-0 transition-all ${
              d.isToday ? 'bg-slate-900 text-white' : 'bg-white border border-slate-200'
            }`}
          >
            <p className={`text-xs mb-0.5 ${d.isToday ? 'text-slate-400' : 'text-slate-400'}`}>{d.day}</p>
            <p className={`leading-none mb-1 ${d.isToday ? 'text-white' : 'text-slate-800'}`} style={{ fontSize: '1.15rem' }}>
              {n > 0 ? n : '—'}
            </p>
            <p className={`text-center ${d.isToday ? 'text-slate-400' : 'text-slate-400'}`} style={{ fontSize: 9 }}>
              {d.isToday ? 'TODAY' : d.date.split(' ')[1]}
            </p>
            {n > 0 && !d.isToday && (
              <div className="flex gap-0.5 mt-1">
                {Array.from({ length: Math.min(n, 3) }).map((_, j) => (
                  <span key={j} className="size-1 rounded-full bg-blue-400" />
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
  const [dismissed, setDismiss] = useState<Set<string>>(new Set());

  const todayJobs    = jobs.filter(j => j.scheduledDate === 'Today' && j.status !== 'Canceled' && j.status !== 'No Show');
  const tomorrowJobs = jobs.filter(j => j.scheduledDate === 'Tomorrow');
  const unscheduled  = jobs.filter(j => j.status === 'Unscheduled');
  const pendingEsts  = estimates.filter(e => e.status === 'Sent' || e.status === 'Viewed');
  const overdueInvs  = invoices.filter(i => i.status === 'Overdue');
  const unpaidInvs   = invoices.filter(i => i.status === 'Unpaid' || i.status === 'Overdue');
  const totalOut     = unpaidInvs.reduce((s, i) => s + calcInvoiceTotal(i), 0);
  const activeCount  = todayJobs.filter(j => j.status === 'Active' || j.status === 'In Progress').length;

  // Build attention items (all sources, deduplicated)
  const attentionItems = [
    ...overdueInvs.map(i => ({
      id: `inv-${i.id}`, type: 'overdue' as const,
      message: `${i.customer} — invoice overdue`,
      sub: `${i.invoiceNumber} · $${calcInvoiceTotal(i).toLocaleString()} · Was due ${i.dueDate}`,
      action: 'Remind', to: '/invoices',
    })),
    ...estimates.filter(e => e.status === 'Sent' && !dismissed.has(`est-${e.id}`)).map(e => ({
      id: `est-${e.id}`, type: 'followup' as const,
      message: `${e.customer} estimate not yet opened`,
      sub: `${e.estimateNumber} · $${calcEstimateTotal(e).toLocaleString()} · Sent ${e.sentDate}`,
      action: 'Follow up', to: '/estimates',
    })),
    ...unscheduled.filter(j => j.estimateId).map(j => ({
      id: `job-${j.id}`, type: 'schedule' as const,
      message: `${j.customer} — ready to schedule`,
      sub: `${j.description} · Estimate approved`,
      action: 'Schedule', to: `/jobs/${j.id}`,
    })),
    ...invoices.filter(i => i.status === 'Draft').map(i => ({
      id: `draft-${i.id}`, type: 'draft' as const,
      message: `Draft invoice unsent`,
      sub: `${i.invoiceNumber} · ${i.customer} · $${calcInvoiceTotal(i).toLocaleString()}`,
      action: 'Review', to: '/invoices',
    })),
  ].filter(item => !dismissed.has(item.id));

  const ATTN_STYLE = {
    overdue:  { icon: AlertCircle,  ic: 'text-red-500',    border: 'border-red-100',   bg: 'bg-red-50'    },
    followup: { icon: Eye,          ic: 'text-violet-500', border: 'border-violet-100',bg: 'bg-violet-50/50' },
    schedule: { icon: Calendar,     ic: 'text-amber-500',  border: 'border-amber-100', bg: 'bg-amber-50'  },
    draft:    { icon: FileText,     ic: 'text-slate-400',  border: 'border-slate-200', bg: 'bg-white'     },
  };

  return (
    <div className="h-full overflow-y-auto pb-20 md:pb-0">
      <div className="max-w-6xl mx-auto">
        {/* ── Header ── */}
        <div className="px-4 md:px-6 pt-5 pb-4 border-b border-slate-100">
          <div className="flex items-start justify-between">
            <div>
              <h1 className="text-slate-900">Good morning, Mike ☀️</h1>
              <p className="text-sm text-slate-400 mt-0.5">Tuesday, March 10 · Austin, TX</p>
            </div>
            <button
              onClick={() => navigate('/assistant')}
              className="flex items-center gap-1.5 rounded-xl bg-slate-900 text-white px-3.5 py-2.5 text-sm hover:bg-slate-700 transition-colors shrink-0"
            >
              <Mic size={13} /> Ask AI
            </button>
          </div>

          {/* 3-stat pulse */}
          <div className="grid grid-cols-3 gap-3 mt-4">
            {[
              { label: 'Active today',    value: `${activeCount} jobs`,             color: 'text-blue-700',  bg: 'bg-blue-50 border-blue-100'   },
              { label: 'Outstanding',     value: `$${totalOut.toLocaleString()}`,   color: 'text-amber-700', bg: 'bg-amber-50 border-amber-100' },
              { label: 'Needs attention', value: `${attentionItems.length} items`,  color: attentionItems.length > 0 ? 'text-red-600' : 'text-green-700', bg: attentionItems.length > 0 ? 'bg-red-50 border-red-100' : 'bg-green-50 border-green-100' },
            ].map(({ label, value, color, bg }) => (
              <div key={label} className={`rounded-xl border px-3 py-2.5 ${bg}`}>
                <p className={`text-xs mb-0.5 ${color}`}>{label}</p>
                <p className={`text-sm ${color}`}>{value}</p>
              </div>
            ))}
          </div>
        </div>

        {/* ── Two-column layout ── */}
        <div className="flex flex-col md:grid md:grid-cols-[1fr_320px] md:items-start divide-y md:divide-y-0 md:divide-x divide-slate-100">

          {/* ─── Left: Operational ─── */}
          <div className="flex flex-col divide-y divide-slate-100">

            {/* Today's jobs */}
            <section className="px-4 md:px-6 py-5">
              <SectionHead label="Today's jobs" count={todayJobs.length} onAll={() => navigate('/jobs')} />
              {todayJobs.length === 0
                ? <p className="text-sm text-slate-400 py-4 text-center">No jobs scheduled today</p>
                : (
                  <div className="rounded-xl bg-white border border-slate-200 overflow-hidden divide-y divide-slate-100">
                    {todayJobs.map(job => (
                      <JobRow key={job.id} job={job} onClick={() => navigate(`/jobs/${job.id}`)} />
                    ))}
                  </div>
                )
              }
            </section>

            {/* This week */}
            <section className="px-4 md:px-6 py-5">
              <SectionHead label="This week" onAll={() => navigate('/schedule')} />
              <WeekStrip />
              {tomorrowJobs.length > 0 && (
                <div className="mt-3 rounded-xl bg-white border border-slate-200 divide-y divide-slate-100 overflow-hidden">
                  {tomorrowJobs.map(job => (
                    <div key={job.id} className="flex items-center gap-3 px-4 py-3">
                      <span className={`flex size-7 shrink-0 items-center justify-center rounded-lg text-sm ${SVC[job.serviceType]?.color ?? 'bg-slate-100'}`}>
                        {SVC[job.serviceType]?.emoji}
                      </span>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm text-slate-800 truncate">{job.customer}</p>
                        <p className="text-xs text-slate-400 mt-0.5">
                          Tomorrow {job.scheduledTime}
                          {job.assignedTech && ` · ${job.assignedTech.split(' ')[0]}`}
                        </p>
                      </div>
                      <button onClick={() => navigate(`/jobs/${job.id}`)} className="text-xs text-slate-400 hover:text-slate-600">
                        <ChevronRight size={13} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </section>

            {/* Unscheduled */}
            {unscheduled.length > 0 && (
              <section className="px-4 md:px-6 py-5">
                <SectionHead label="Unscheduled jobs" count={unscheduled.length} onAll={() => navigate('/jobs')} />
                <div className="flex flex-col gap-2">
                  {unscheduled.map(job => (
                    <button
                      key={job.id}
                      onClick={() => navigate(`/jobs/${job.id}`)}
                      className="flex items-center gap-3 rounded-xl bg-white border border-dashed border-slate-200 px-4 py-3 text-left hover:border-slate-300 hover:bg-slate-50/50 transition-all group"
                    >
                      <span className={`flex size-8 shrink-0 items-center justify-center rounded-xl text-base ${SVC[job.serviceType]?.color ?? 'bg-slate-100'}`}>
                        {SVC[job.serviceType]?.emoji}
                      </span>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm text-slate-800">{job.customer}</p>
                        <p className="text-xs text-slate-400 mt-0.5 truncate">{job.description}</p>
                      </div>
                      <span className="text-xs text-blue-600 shrink-0 group-hover:underline">
                        Schedule →
                      </span>
                    </button>
                  ))}
                </div>
              </section>
            )}
          </div>

          {/* ─── Right: Financial & Attention ─── */}
          <div className="flex flex-col divide-y divide-slate-100">

            {/* Leads pipeline widget */}
            <section className="px-4 py-5">
              <div className="flex items-center justify-between mb-2.5">
                <div className="flex items-center gap-2">
                  <TrendingUp size={14} className="text-blue-500" />
                  <p className="text-sm text-slate-700">Lead pipeline</p>
                </div>
                <button onClick={() => navigate('/leads')} className="flex items-center gap-0.5 text-xs text-blue-600 hover:text-blue-700 transition-colors">
                  View all <ArrowRight size={11} />
                </button>
              </div>
              {(() => {
                const pipeline = leads.filter(l => l.status !== 'Won' && l.status !== 'Lost');
                const newLeads = leads.filter(l => l.status === 'New');
                const pipelineValue = pipeline.reduce((s, l) => s + (l.estimatedValue ?? 0), 0);
                return (
                  <div className="rounded-xl bg-white border border-slate-200 overflow-hidden">
                    <div className="flex divide-x divide-slate-100">
                      {[
                        { label: 'New', count: leads.filter(l => l.status === 'New').length,           color: 'text-blue-600',  dot: 'bg-blue-500'   },
                        { label: 'Contacted', count: leads.filter(l => l.status === 'Contacted').length,color: 'text-amber-600', dot: 'bg-amber-500'  },
                        { label: 'Est. Sent', count: leads.filter(l => l.status === 'Estimate Sent').length, color: 'text-violet-600', dot: 'bg-violet-500' },
                      ].map(({ label, count, color, dot }) => (
                        <button key={label} onClick={() => navigate('/leads')} className="flex-1 flex flex-col items-center py-3.5 hover:bg-slate-50 transition-colors">
                          <span className={`flex size-1.5 rounded-full mb-1.5 ${dot}`} />
                          <p className={`text-xs ${color}`}>{count}</p>
                          <p className="text-xs text-slate-400 mt-0.5">{label}</p>
                        </button>
                      ))}
                    </div>
                    {newLeads.length > 0 && (
                      <div className="border-t border-slate-100 px-4 py-3">
                        <button onClick={() => navigate('/leads')} className="flex items-center gap-2.5 w-full text-left hover:opacity-80 transition-opacity">
                          <span className="size-1.5 rounded-full bg-blue-500 shrink-0 animate-pulse" />
                          <p className="text-xs text-slate-600 flex-1">
                            <span className="text-slate-900">{newLeads[0].name}</span>
                            {' '}— {newLeads[0].description.slice(0, 45)}…
                          </p>
                          <ChevronRight size={12} className="text-slate-300 shrink-0" />
                        </button>
                      </div>
                    )}
                    <div className="border-t border-slate-100 px-4 py-2.5 bg-slate-50">
                      <p className="text-xs text-slate-400">
                        ${pipelineValue.toLocaleString()} est. pipeline value · {pipeline.length} active
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
                          actionClass={item.type === 'overdue' ? 'text-red-600' : 'text-blue-600'}
                          onAction={() => navigate(item.to)}
                        />
                      </div>
                    );
                  })}
                </div>
              </section>
            )}

            {/* Pending estimates */}
            {pendingEsts.length > 0 && (
              <section className="px-4 py-5">
                <SectionHead label="Pending estimates" count={pendingEsts.length} onAll={() => navigate('/estimates')} />
                <div className="rounded-xl bg-white border border-slate-200 divide-y divide-slate-100 overflow-hidden">
                  {pendingEsts.map(est => (
                    <button
                      key={est.id}
                      onClick={() => navigate('/estimates')}
                      className="flex items-center gap-3 w-full px-4 py-3.5 text-left hover:bg-slate-50 transition-colors group"
                    >
                      <div className={`flex size-8 items-center justify-center rounded-xl shrink-0 ${
                        est.status === 'Viewed' ? 'bg-violet-100' : 'bg-blue-100'
                      }`}>
                        {est.status === 'Viewed'
                          ? <Eye size={14} className="text-violet-500" />
                          : <Send size={14} className="text-blue-500" />
                        }
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm text-slate-800 truncate">{est.customer}</p>
                        <p className="text-xs text-slate-400 mt-0.5">
                          {est.estimateNumber} · {est.status === 'Viewed' ? `Viewed ${est.viewedDate}` : `Sent ${est.sentDate}`}
                        </p>
                      </div>
                      <div className="flex flex-col items-end gap-1 shrink-0">
                        <p className="text-sm text-slate-700">${calcEstimateTotal(est).toLocaleString()}</p>
                        <StatusBadge status={est.status} size="sm" />
                      </div>
                    </button>
                  ))}
                </div>
              </section>
            )}

            {/* Unpaid invoices */}
            {unpaidInvs.length > 0 && (
              <section className="px-4 py-5">
                <div className="flex items-center justify-between mb-2.5">
                  <div className="flex items-center gap-2">
                    <p className="text-sm text-slate-700">Outstanding invoices</p>
                    <span className="flex items-center justify-center min-w-[18px] h-[18px] rounded-full bg-slate-200 text-xs text-slate-600 px-1.5">{unpaidInvs.length}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-amber-700">${totalOut.toLocaleString()}</span>
                    <button onClick={() => navigate('/invoices')} className="flex items-center gap-0.5 text-xs text-blue-600 hover:text-blue-700">
                      View all <ArrowRight size={11} />
                    </button>
                  </div>
                </div>
                <div className="rounded-xl bg-white border border-slate-200 divide-y divide-slate-100 overflow-hidden">
                  {unpaidInvs.map(inv => (
                    <button
                      key={inv.id}
                      onClick={() => navigate('/invoices')}
                      className="flex items-center gap-3 w-full px-4 py-3.5 text-left hover:bg-slate-50 transition-colors"
                    >
                      <div className={`flex size-8 items-center justify-center rounded-xl shrink-0 ${
                        inv.status === 'Overdue' ? 'bg-red-100' : 'bg-amber-100'
                      }`}>
                        <DollarSign size={14} className={inv.status === 'Overdue' ? 'text-red-500' : 'text-amber-600'} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm text-slate-800 truncate">{inv.customer}</p>
                        <p className={`text-xs mt-0.5 ${inv.status === 'Overdue' ? 'text-red-500' : 'text-slate-400'}`}>
                          {inv.invoiceNumber}
                          {inv.status === 'Overdue' ? ` · OVERDUE since ${inv.dueDate}` : inv.dueDate ? ` · Due ${inv.dueDate}` : ''}
                        </p>
                      </div>
                      <div className="flex flex-col items-end gap-1 shrink-0">
                        <p className="text-sm text-slate-700">${calcInvoiceTotal(inv).toLocaleString()}</p>
                        <StatusBadge status={inv.status} size="sm" />
                      </div>
                    </button>
                  ))}
                </div>
              </section>
            )}

            {/* Quick actions */}
            <section className="px-4 py-5">
              <SectionHead label="Quick actions" />
              <div className="grid grid-cols-2 gap-2">
                {[
                  { label: 'New job',      icon: Plus,      color: 'text-blue-600',   bg: 'bg-blue-50',   to: '/jobs'      },
                  { label: 'New estimate', icon: FileText,  color: 'text-indigo-600', bg: 'bg-indigo-50', to: '/estimates' },
                  { label: 'New invoice',  icon: DollarSign,color: 'text-amber-600',  bg: 'bg-amber-50',  to: '/invoices'  },
                  { label: 'Schedule',     icon: CalendarDays, color: 'text-green-600', bg: 'bg-green-50', to: '/schedule'  },
                ].map(({ label, icon: Icon, color, bg, to }) => (
                  <button
                    key={label}
                    onClick={() => navigate(to)}
                    className="flex items-center gap-2 rounded-xl bg-white border border-slate-200 px-3.5 py-3 text-left hover:border-slate-300 hover:shadow-sm transition-all"
                  >
                    <span className={`flex size-7 items-center justify-center rounded-lg ${bg} shrink-0`}>
                      <Icon size={14} className={color} />
                    </span>
                    <span className="text-sm text-slate-700">{label}</span>
                  </button>
                ))}
              </div>
            </section>

            {/* All clear */}
            {attentionItems.length === 0 && unpaidInvs.length === 0 && pendingEsts.length === 0 && (
              <section className="px-4 py-8 flex flex-col items-center gap-2">
                <CheckCircle2 size={28} className="text-green-500" />
                <p className="text-sm text-slate-600">All clear — nothing urgent</p>
                <p className="text-xs text-slate-400">You're on top of everything today</p>
              </section>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
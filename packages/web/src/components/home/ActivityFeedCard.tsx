import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { Bot, User, Cpu, AlertTriangle, ChevronRight, Activity } from 'lucide-react';
import { useApiClient } from '../../lib/apiClient';

/**
 * Epic 12.7 — Activity feed card.
 *
 * A chronological feed of what happened — agent, human, and system actions —
 * for situational awareness. Emergency calls/escalations are flagged, and rows
 * deep-link to the entity they touched. Reads GET /api/analytics/activity.
 * Renders nothing until there's activity (the HomePage all-clear owns empty).
 */
type ActorKind = 'agent' | 'human' | 'system';

interface ActivityFeedItem {
  id: string;
  eventType: string;
  label: string;
  actorKind: ActorKind;
  actorRole: string;
  isEmergency: boolean;
  entityType: string;
  entityId: string;
  createdAt: string;
}

const MAX_VISIBLE = 8;

// entityType → web route. Only types with a real detail surface are linkable;
// anything else renders as a non-clickable row (no dead links).
const ENTITY_ROUTE: Record<string, (id: string) => string> = {
  job: (id) => `/jobs/${id}`,
  customer: (id) => `/customers/${id}`,
  estimate: (id) => `/estimates/${id}`,
  invoice: (id) => `/invoices/${id}`,
  lead: (id) => `/leads/${id}`,
  appointment: (id) => `/appointments/${id}/edit`,
  proposal: () => `/inbox`,
  conversation: () => `/comms-inbox`,
};

const ACTOR_META: Record<ActorKind, { icon: typeof Bot; label: string; classes: string }> = {
  agent: { icon: Bot, label: 'Agent', classes: 'bg-indigo-50 text-indigo-600' },
  human: { icon: User, label: 'You', classes: 'bg-slate-100 text-slate-500' },
  system: { icon: Cpu, label: 'System', classes: 'bg-slate-100 text-slate-400' },
};

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

export function ActivityFeedCard() {
  const apiFetch = useApiClient();
  const navigate = useNavigate();
  const [items, setItems] = useState<ActivityFeedItem[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    apiFetch(`/api/analytics/activity?limit=${MAX_VISIBLE}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = await res.json();
        if (!cancelled) setItems((body.data ?? []) as ActivityFeedItem[]);
      })
      .catch(() => {
        /* feed is best-effort — stay silent on failure */
      })
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [apiFetch]);

  if (!loaded || items.length === 0) return null;

  return (
    <section data-testid="activity-feed" className="px-4 py-5">
      <div className="mb-2.5 flex items-center gap-2">
        <Activity size={14} className="text-slate-500" />
        <p className="text-sm text-slate-700">Recent activity</p>
      </div>
      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white divide-y divide-slate-100">
        {items.map((item) => {
          const meta = ACTOR_META[item.actorKind];
          const ActorIcon = meta.icon;
          const route = ENTITY_ROUTE[item.entityType]?.(item.entityId);
          const inner = (
            <>
              <span
                className={`flex size-7 shrink-0 items-center justify-center rounded-lg ${
                  item.isEmergency ? 'bg-red-100 text-red-600' : meta.classes
                }`}
              >
                {item.isEmergency ? <AlertTriangle size={13} /> : <ActorIcon size={13} />}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  {item.isEmergency && (
                    <span className="rounded bg-red-100 px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-red-700">
                      Emergency
                    </span>
                  )}
                  <p className="truncate text-sm text-slate-800">{item.label}</p>
                </div>
                <p className="mt-0.5 text-xs text-slate-400">
                  {meta.label} · {relativeTime(item.createdAt)}
                </p>
              </div>
              {route && <ChevronRight size={13} className="shrink-0 text-slate-300" />}
            </>
          );
          return route ? (
            <button
              key={item.id}
              data-testid="activity-row"
              onClick={() => navigate(route)}
              className="flex min-h-11 w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-slate-50"
            >
              {inner}
            </button>
          ) : (
            <div key={item.id} data-testid="activity-row" className="flex min-h-11 items-center gap-3 px-4 py-2.5">
              {inner}
            </div>
          );
        })}
      </div>
    </section>
  );
}

/**
 * P9-002 — Read-only customer activity timeline.
 *
 * Renders a vertical, descending-by-time list of events sourced from the
 * `/api/customers/:id/timeline` endpoint. Each event is rendered with a
 * kind-specific icon (lucide-react), a relative timestamp, a summary
 * line, and a "view source" link to the underlying entity.
 *
 * Filter chips at the top toggle which `kinds` are visible. The "Load
 * older" button paginates with the `before` cursor returned by the API.
 *
 * This component is intentionally light on dependencies — it uses only
 * Tailwind primitives + lucide icons, both already present in the app.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTenantTimezone } from '../../hooks/useTenantTimezone';
import { formatDateTimeInTenantTz } from '../../utils/formatInTenantTz';
import {
  StickyNote,
  Briefcase,
  RefreshCw,
  FileText,
  CheckCircle2,
  Receipt,
  CreditCard,
  DollarSign,
  MessageSquare,
  Phone,
  PhoneIncoming,
  PhoneOutgoing,
  Mail,
  Calendar,
  CalendarCheck,
  CircleDot,
} from 'lucide-react';
import {
  getCustomerTimeline,
  type TimelineEvent,
  type TimelineKind,
} from '../../api/customers';

export interface CommunicationTimelineProps {
  customerId: string;
  /** Override fetcher for tests. Defaults to the real `getCustomerTimeline`. */
  fetcher?: typeof getCustomerTimeline;
  /** Page size — defaults to 50, server caps at 200. */
  pageSize?: number;
}

/** Display labels for each kind — used by the filter chips. */
const KIND_LABELS: Record<TimelineKind, string> = {
  note: 'Notes',
  job_created: 'Jobs created',
  job_status_changed: 'Job status',
  estimate_sent: 'Estimates sent',
  estimate_approved: 'Estimates approved',
  invoice_sent: 'Invoices sent',
  invoice_paid: 'Invoices paid',
  payment_received: 'Payments',
  sms_sent: 'SMS sent',
  sms_received: 'SMS received',
  call_inbound: 'Inbound calls',
  call_outbound: 'Outbound calls',
  email_sent: 'Emails sent',
  email_received: 'Emails received',
  appointment_scheduled: 'Appointments',
  appointment_completed: 'Appointments done',
};

function iconForKind(kind: TimelineKind): React.ReactNode {
  const className = 'h-4 w-4';
  switch (kind) {
    case 'note':
      return <StickyNote className={className} aria-hidden="true" />;
    case 'job_created':
      return <Briefcase className={className} aria-hidden="true" />;
    case 'job_status_changed':
      return <RefreshCw className={className} aria-hidden="true" />;
    case 'estimate_sent':
      return <FileText className={className} aria-hidden="true" />;
    case 'estimate_approved':
      return <CheckCircle2 className={className} aria-hidden="true" />;
    case 'invoice_sent':
      return <Receipt className={className} aria-hidden="true" />;
    case 'invoice_paid':
      return <CreditCard className={className} aria-hidden="true" />;
    case 'payment_received':
      return <DollarSign className={className} aria-hidden="true" />;
    case 'sms_sent':
    case 'sms_received':
      return <MessageSquare className={className} aria-hidden="true" />;
    case 'call_inbound':
      return <PhoneIncoming className={className} aria-hidden="true" />;
    case 'call_outbound':
      return <PhoneOutgoing className={className} aria-hidden="true" />;
    case 'email_sent':
    case 'email_received':
      return <Mail className={className} aria-hidden="true" />;
    case 'appointment_scheduled':
      return <Calendar className={className} aria-hidden="true" />;
    case 'appointment_completed':
      return <CalendarCheck className={className} aria-hidden="true" />;
    default:
      return <CircleDot className={className} aria-hidden="true" />;
  }
}

function relativeTime(now: number, then: number): string {
  const seconds = Math.floor((now - then) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  const years = Math.floor(days / 365);
  return `${years}y ago`;
}

function sourceHref(ev: TimelineEvent): string | null {
  switch (ev.sourceEntityType) {
    case 'job':
      return `/jobs/${ev.sourceEntityId}`;
    case 'job_timeline': {
      const jobId = ev.metadata['jobId'];
      return typeof jobId === 'string' ? `/jobs/${jobId}` : null;
    }
    case 'estimate':
      return `/estimates/${ev.sourceEntityId}`;
    case 'invoice':
      return `/invoices/${ev.sourceEntityId}`;
    case 'payment': {
      const invId = ev.metadata['invoiceId'];
      return typeof invId === 'string' ? `/invoices/${invId}` : null;
    }
    case 'message': {
      const cId = ev.metadata['conversationId'];
      return typeof cId === 'string'
        ? `/comms-inbox?conversation=${encodeURIComponent(cId)}`
        : null;
    }
    case 'appointment':
      return `/appointments/${ev.sourceEntityId}/edit`;
    case 'note':
    default:
      return null;
  }
}

export function CommunicationTimeline({
  customerId,
  fetcher = getCustomerTimeline,
  pageSize = 50,
}: CommunicationTimelineProps) {
  const tz = useTenantTimezone();
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeKinds, setActiveKinds] = useState<Set<TimelineKind>>(new Set());

  const loadInitial = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetcher(customerId, { limit: pageSize });
      setEvents(res.events);
      setNextCursor(res.nextCursor);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load activity');
    } finally {
      setIsLoading(false);
    }
  }, [customerId, fetcher, pageSize]);

  useEffect(() => {
    loadInitial();
  }, [loadInitial]);

  const loadOlder = useCallback(async () => {
    if (!nextCursor || isLoadingMore) return;
    setIsLoadingMore(true);
    try {
      const res = await fetcher(customerId, {
        limit: pageSize,
        before: nextCursor,
      });
      setEvents((prev) => [...prev, ...res.events]);
      setNextCursor(res.nextCursor);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load more activity');
    } finally {
      setIsLoadingMore(false);
    }
  }, [customerId, fetcher, nextCursor, pageSize, isLoadingMore]);

  const visibleKinds = useMemo(() => {
    const present = new Set<TimelineKind>();
    for (const ev of events) present.add(ev.kind);
    return Array.from(present);
  }, [events]);

  const filteredEvents = useMemo(() => {
    if (activeKinds.size === 0) return events;
    return events.filter((e) => activeKinds.has(e.kind));
  }, [events, activeKinds]);

  const toggleKind = useCallback((kind: TimelineKind) => {
    setActiveKinds((prev) => {
      const next = new Set(prev);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  }, []);

  if (isLoading) {
    return (
      <div className="text-sm text-muted-foreground" data-testid="timeline-loading">
        Loading activity...
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-sm text-destructive" role="alert" data-testid="timeline-error">
        {error}
      </div>
    );
  }

  if (events.length === 0) {
    return (
      <div className="text-sm text-muted-foreground" data-testid="timeline-empty">
        No activity yet.
      </div>
    );
  }

  const now = Date.now();

  return (
    <div className="communication-timeline" data-testid="communication-timeline">
      {visibleKinds.length > 1 && (
        <div className="flex flex-wrap gap-2 mb-4" data-testid="timeline-filters">
          {visibleKinds.map((kind) => {
            const active = activeKinds.has(kind);
            return (
              <button
                key={kind}
                type="button"
                onClick={() => toggleKind(kind)}
                aria-pressed={active}
                className={
                  'px-2 py-1 text-xs rounded-full border ' +
                  (active
                    ? 'bg-primary text-primary-foreground border-primary'
                    : 'bg-card text-foreground border-border')
                }
                data-testid={`timeline-filter-${kind}`}
              >
                {KIND_LABELS[kind]}
              </button>
            );
          })}
        </div>
      )}

      <ol className="relative border-l border-border ml-2">
        {filteredEvents.map((ev) => {
          const occurredAt = new Date(ev.occurredAt);
          const href = sourceHref(ev);
          return (
            <li
              key={`${ev.sourceEntityType}-${ev.sourceEntityId}-${ev.kind}-${ev.occurredAt}`}
              className="mb-4 ml-4"
              data-testid="timeline-event"
              data-kind={ev.kind}
            >
              <span
                className="absolute -left-3 flex items-center justify-center w-6 h-6 rounded-full bg-secondary text-foreground"
                data-testid={`timeline-icon-${ev.kind}`}
              >
                {iconForKind(ev.kind)}
              </span>
              <div className="flex flex-col">
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <time
                    dateTime={ev.occurredAt}
                    title={formatDateTimeInTenantTz(occurredAt, tz)}
                  >
                    {relativeTime(now, occurredAt.getTime())}
                  </time>
                  <span className="uppercase tracking-wide">{KIND_LABELS[ev.kind]}</span>
                </div>
                <div className="text-sm text-foreground">{ev.summary}</div>
                {href && (
                  <a
                    href={href}
                    className="text-xs text-primary hover:underline mt-1"
                    data-testid="timeline-source-link"
                  >
                    View source
                  </a>
                )}
              </div>
            </li>
          );
        })}
      </ol>

      {nextCursor && (
        <div className="mt-2">
          <button
            type="button"
            onClick={loadOlder}
            disabled={isLoadingMore}
            className="text-xs text-primary hover:underline disabled:opacity-50"
            data-testid="timeline-load-older"
          >
            {isLoadingMore ? 'Loading...' : 'Load older'}
          </button>
        </div>
      )}
    </div>
  );
}

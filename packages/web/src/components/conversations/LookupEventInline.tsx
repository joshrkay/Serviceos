import React, { useState } from 'react';
import { Message } from '../../types/conversation';

/**
 * P11-001 — inline render for `lookup_event` rows.
 *
 * The audit log row is exposed to the conversation thread as a
 * `system_event` Message whose `metadata.kind === 'lookup_event'`.
 * That keeps the typed Message shape unchanged while letting the
 * voice lookup-skill family surface its result inline.
 *
 * Expected metadata shape (matches the LookupEvent repo):
 *   { kind: 'lookup_event', intent: 'lookup_appointments',
 *     resultStatus: 'found' | 'none' | 'error', resultCount: number,
 *     summary: string, latencyMs: number }
 */
export interface LookupEventInlineProps {
  message: Message;
}

interface LookupEventMetadata {
  kind?: string;
  intent?: string;
  resultStatus?: 'found' | 'none' | 'error';
  resultCount?: number;
  summary?: string;
  latencyMs?: number;
}

const INTENT_LABELS: Record<string, string> = {
  lookup_appointments: 'Customer asked about appointments',
  lookup_invoices: 'Customer asked about invoices',
  lookup_balance: 'Customer asked about balance',
  lookup_jobs: 'Customer asked about jobs',
  lookup_agreements: 'Customer asked about service plans',
  lookup_account_summary: 'Customer asked about their account',
};

function labelForIntent(intent: string | undefined): string {
  if (!intent) return 'Lookup';
  return INTENT_LABELS[intent] ?? intent;
}

function isLookupEventMetadata(value: unknown): value is LookupEventMetadata {
  return typeof value === 'object' && value !== null && (value as LookupEventMetadata).kind === 'lookup_event';
}

/**
 * Pure predicate the thread uses to decide whether a `system_event`
 * row should render with `LookupEventInline` instead of the default
 * `SystemEvent` component. Exported so the thread can branch without
 * duplicating the metadata-shape check.
 */
export function isLookupEventMessage(message: Message): boolean {
  return message.messageType === 'system_event' && isLookupEventMetadata(message.metadata);
}

export function LookupEventInline({ message }: LookupEventInlineProps) {
  const [expanded, setExpanded] = useState(false);
  const meta: LookupEventMetadata = isLookupEventMetadata(message.metadata)
    ? message.metadata
    : {};
  const label = labelForIntent(meta.intent);
  const count = typeof meta.resultCount === 'number' ? meta.resultCount : 0;
  const status = meta.resultStatus ?? 'none';
  const summary = meta.summary ?? message.content ?? '';

  // Compact one-liner shown when collapsed.
  const headline =
    status === 'error'
      ? `${label} → error`
      : `${label} → ${count} result${count === 1 ? '' : 's'}`;

  return (
    <div className="lookup-event-inline" data-testid="lookup-event-inline">
      <span className="lookup-event-icon" data-testid="lookup-event-icon" aria-hidden>
        {/* Tiny inline SVG icon — keeps the component dependency-free. */}
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="11" cy="11" r="7" />
          <line x1="20" y1="20" x2="16" y2="16" />
        </svg>
      </span>
      <button
        type="button"
        className="lookup-event-headline"
        data-testid="lookup-event-headline"
        onClick={() => setExpanded((prev) => !prev)}
        aria-expanded={expanded}
      >
        {headline}
      </button>
      {expanded && summary && (
        <div className="lookup-event-summary" data-testid="lookup-event-summary">
          {summary}
        </div>
      )}
      <span className="lookup-event-time" data-testid="lookup-event-time">
        {new Date(message.createdAt).toLocaleTimeString()}
      </span>
    </div>
  );
}

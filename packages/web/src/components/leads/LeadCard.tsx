import React from 'react';

/**
 * Icon glyph per lead source. P12-005 introduces `customer_portal` as a
 * first-class source — represented with a globe glyph since portal leads
 * arrive over the web from authenticated customer sessions. `sms` tags leads
 * minted from an inbound text by an unknown sender (sms-capture), kept
 * distinct from `phone_call`. Falls back to a generic dot for unknown sources
 * so the UI never breaks if the backend ships a new value before the web
 * build catches up.
 */
const SOURCE_ICONS: Record<string, string> = {
  web_form: 'F',
  phone_call: '☎', // telephone glyph
  referral: '☆', // star
  walk_in: '➜', // arrow
  marketplace: '⌂', // house
  other: '…', // ellipsis
  customer_portal: '\u{1F310}', // globe — portal-over-web
  sms: '\u{1F4AC}', // speech balloon — inbound text
};

function sourceIcon(source: string): string {
  return SOURCE_ICONS[source] ?? '•'; // bullet fallback
}

/**
 * Display label per source. Most sources render their raw enum value; `sms`
 * is shown as the upper-cased acronym ("SMS") so the kanban tag reads cleanly.
 */
const SOURCE_LABELS: Record<string, string> = {
  sms: 'SMS',
};

function sourceLabel(source: string): string {
  return SOURCE_LABELS[source] ?? source;
}

export interface LeadCardData {
  id: string;
  firstName?: string;
  lastName?: string;
  companyName?: string;
  source: string;
  sourceDetail?: string;
  estimatedValueCents?: number;
  stage: string;
  primaryPhone?: string;
  email?: string;
  assignedUserId?: string;
}

export interface LeadCardProps {
  lead: LeadCardData;
  onClick?: (id: string) => void;
  onDragStart?: (id: string) => void;
}

function fullName(lead: LeadCardData): string {
  const name = `${lead.firstName ?? ''} ${lead.lastName ?? ''}`.trim();
  return name || lead.companyName || 'Unnamed lead';
}

function formatCents(cents?: number): string | null {
  if (cents === undefined || cents === null) return null;
  // Display whole-dollar — never reformat as float math; this is just rendering.
  const dollars = Math.floor(cents / 100);
  const remainder = cents % 100;
  return `$${dollars.toLocaleString('en-US')}.${String(remainder).padStart(2, '0')}`;
}

export function LeadCard({ lead, onClick, onDragStart }: LeadCardProps) {
  const value = formatCents(lead.estimatedValueCents);
  return (
    <div
      role="button"
      tabIndex={0}
      draggable
      data-testid={`lead-card-${lead.id}`}
      onClick={() => onClick?.(lead.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') onClick?.(lead.id);
      }}
      onDragStart={(e) => {
        e.dataTransfer.setData('text/plain', lead.id);
        e.dataTransfer.effectAllowed = 'move';
        onDragStart?.(lead.id);
      }}
      className="block w-full text-left rounded-xl bg-white border border-slate-200 hover:border-slate-300 hover:shadow-sm transition-all p-3 cursor-grab active:cursor-grabbing"
    >
      <div className="flex items-start justify-between gap-2 mb-1">
        <p className="text-sm text-slate-900 truncate">{fullName(lead)}</p>
        {value && (
          <span className="shrink-0 text-xs text-slate-500 bg-slate-100 rounded-full px-2 py-0.5">
            {value}
          </span>
        )}
      </div>
      <div className="flex items-center gap-1.5 flex-wrap text-xs text-slate-500">
        <span
          className="bg-slate-100 rounded-full px-2 py-0.5"
          data-testid={`lead-source-${lead.source}`}
        >
          <span aria-hidden="true" className="mr-1">{sourceIcon(lead.source)}</span>
          {sourceLabel(lead.source)}
        </span>
        {lead.sourceDetail && <span className="truncate">{lead.sourceDetail}</span>}
      </div>
      {(lead.primaryPhone || lead.email) && (
        <p className="mt-1 text-xs text-slate-400 truncate">
          {lead.email || lead.primaryPhone}
        </p>
      )}
    </div>
  );
}

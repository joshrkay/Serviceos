import { useState } from 'react';
import {
  Zap, ArrowRight, MapPin, FileText, Camera,
  Mic, Package, ChevronDown, ChevronUp, Plus,
} from 'lucide-react';
import type { JobActivity, MaterialItem } from '../../data/mock-data';

const EVENT_CONFIG: Record<
  JobActivity['type'],
  { icon: React.ElementType; color: string; bg: string; label: string }
> = {
  system:        { icon: Zap,        color: 'text-indigo-600', bg: 'bg-indigo-100', label: 'System' },
  status_change: { icon: ArrowRight, color: 'text-blue-600',   bg: 'bg-blue-100',   label: 'Status' },
  check_in:      { icon: MapPin,     color: 'text-green-600',  bg: 'bg-green-100',  label: 'Check-in' },
  note:          { icon: FileText,   color: 'text-slate-600',  bg: 'bg-slate-100',  label: 'Note' },
  photo:         { icon: Camera,     color: 'text-sky-600',    bg: 'bg-sky-100',    label: 'Photo' },
  voice:         { icon: Mic,        color: 'text-violet-600', bg: 'bg-violet-100', label: 'Voice' },
  parts:         { icon: Package,    color: 'text-amber-600',  bg: 'bg-amber-100',  label: 'Parts' },
};

function PartsExpand({ parts }: { parts: MaterialItem[] }) {
  const [open, setOpen] = useState(false);
  const total = parts.reduce((s, p) => s + p.qty * p.unitCost, 0);
  return (
    <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 overflow-hidden">
      <button
        onClick={() => setOpen(v => !v)}
        className="flex w-full items-center justify-between px-3 py-2 text-xs text-amber-800"
      >
        <span>{parts.length} item{parts.length > 1 ? 's' : ''} · ${total.toFixed(2)}</span>
        {open ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
      </button>
      {open && (
        <div className="border-t border-amber-200 divide-y divide-amber-100">
          {parts.map(p => (
            <div key={p.id} className="flex items-center justify-between px-3 py-2">
              <div>
                <p className="text-xs text-slate-700">{p.name}</p>
                {p.partNumber && <p className="text-xs text-slate-400">{p.partNumber}</p>}
              </div>
              <div className="text-right">
                <p className="text-xs text-slate-700">×{p.qty}</p>
                <p className="text-xs text-slate-400">${(p.qty * p.unitCost).toFixed(2)}</p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

interface Props {
  activities: JobActivity[];
  onAddEntry?: () => void;
  compact?: boolean;
}

export function ActivityTimeline({ activities, onAddEntry, compact = false }: Props) {
  if (!activities || activities.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 py-10">
        <div className="size-10 rounded-full bg-slate-100 flex items-center justify-center">
          <Zap size={16} className="text-slate-400" />
        </div>
        <p className="text-sm text-slate-400">No activity yet</p>
        {onAddEntry && (
          <button
            onClick={onAddEntry}
            className="flex items-center gap-1.5 rounded-lg bg-slate-900 text-white px-3 py-2 text-sm hover:bg-slate-700 transition-colors"
          >
            <Plus size={13} /> Add first entry
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="relative">
      {/* Add entry button at top */}
      {onAddEntry && (
        <div className="flex justify-end mb-3">
          <button
            onClick={onAddEntry}
            className="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-600 hover:border-blue-300 hover:bg-blue-50 hover:text-blue-700 transition-colors"
          >
            <Plus size={12} /> Add entry
          </button>
        </div>
      )}

      {/* Timeline */}
      <div className="flex flex-col">
        {[...activities].reverse().map((event, idx, arr) => {
          const cfg = EVENT_CONFIG[event.type] ?? EVENT_CONFIG.note;
          const Icon = cfg.icon;
          const isLast = idx === arr.length - 1;

          return (
            <div key={event.id} className="flex gap-3">
              {/* Dot + line */}
              <div className="flex flex-col items-center shrink-0" style={{ width: 28 }}>
                <span className={`flex size-7 items-center justify-center rounded-full ${cfg.bg} shrink-0`}>
                  <Icon size={13} className={cfg.color} />
                </span>
                {!isLast && <span className="w-px flex-1 bg-slate-100 my-1" />}
              </div>

              {/* Content */}
              <div className={`flex-1 min-w-0 ${isLast ? '' : 'pb-4'}`}>
                <div className="flex items-start justify-between gap-2 mb-0.5">
                  <div className="flex items-center gap-1.5 min-w-0">
                    {event.authorInitials && (
                      <span
                        className="flex size-4 shrink-0 items-center justify-center rounded-full text-white"
                        style={{ fontSize: 7, background: event.authorColor ?? '#94a3b8' }}
                      >
                        {event.authorInitials}
                      </span>
                    )}
                    {event.author && (
                      <span className="text-xs text-slate-500 truncate">{event.author}</span>
                    )}
                  </div>
                  <span className="text-xs text-slate-400 shrink-0">{event.time}</span>
                </div>

                {/* Content block */}
                {event.type === 'note' ? (
                  <div className="rounded-lg bg-slate-50 border border-slate-100 px-3 py-2 mt-1">
                    <p className="text-sm text-slate-700">{event.content}</p>
                  </div>
                ) : event.type === 'voice' ? (
                  <div className="rounded-lg bg-violet-50 border border-violet-100 px-3 py-2 mt-1">
                    <div className="flex items-center gap-2 mb-1">
                      <Mic size={12} className="text-violet-500" />
                      {event.voiceDuration && (
                        <span className="text-xs text-violet-600 bg-violet-100 rounded-full px-1.5 py-0.5">
                          {event.voiceDuration}s
                        </span>
                      )}
                    </div>
                    <p className="text-sm text-slate-700 italic">{event.content}</p>
                  </div>
                ) : event.type === 'system' ? (
                  <p className="text-xs text-slate-400 italic mt-0.5">{event.content}</p>
                ) : (
                  <p className={`text-sm mt-0.5 ${event.type === 'status_change' ? 'text-slate-700' : 'text-slate-700'}`}>
                    {event.content}
                  </p>
                )}

                {/* Parts expansion */}
                {event.type === 'parts' && event.parts && event.parts.length > 0 && (
                  <PartsExpand parts={event.parts} />
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

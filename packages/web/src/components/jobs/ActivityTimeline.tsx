import { useState } from 'react';
import {
  Zap, ArrowRight, MapPin, FileText, Camera,
  Mic, Package, ChevronDown, ChevronUp, Plus,
} from 'lucide-react';
import type { JobActivity, MaterialItem } from '../../types/job-ui';

const EVENT_CONFIG: Record<
  JobActivity['type'],
  { icon: React.ElementType; color: string; bg: string; label: string }
> = {
  system:        { icon: Zap,        color: 'text-primary', bg: 'bg-primary/15', label: 'System' },
  status_change: { icon: ArrowRight, color: 'text-primary',   bg: 'bg-primary/15',   label: 'Status' },
  check_in:      { icon: MapPin,     color: 'text-success',  bg: 'bg-success/15',  label: 'Check-in' },
  note:          { icon: FileText,   color: 'text-foreground',  bg: 'bg-secondary',  label: 'Note' },
  photo:         { icon: Camera,     color: 'text-primary',    bg: 'bg-primary/15',    label: 'Photo' },
  voice:         { icon: Mic,        color: 'text-primary', bg: 'bg-primary/15', label: 'Voice' },
  parts:         { icon: Package,    color: 'text-warning',  bg: 'bg-warning/15',  label: 'Parts' },
};

function PartsExpand({ parts }: { parts: MaterialItem[] }) {
  const [open, setOpen] = useState(false);
  const total = parts.reduce((s, p) => s + p.qty * p.unitCost, 0);
  return (
    <div className="mt-2 rounded-lg border border-warning/30 bg-warning/10 overflow-hidden">
      <button
        onClick={() => setOpen(v => !v)}
        className="flex w-full items-center justify-between px-3 py-2 text-xs text-warning"
      >
        <span>{parts.length} item{parts.length > 1 ? 's' : ''} · ${total.toFixed(2)}</span>
        {open ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
      </button>
      {open && (
        <div className="border-t border-warning/30 divide-y divide-warning">
          {parts.map(p => (
            <div key={p.id} className="flex items-center justify-between px-3 py-2">
              <div>
                <p className="text-xs text-foreground">{p.name}</p>
                {p.partNumber && <p className="text-xs text-muted-foreground">{p.partNumber}</p>}
              </div>
              <div className="text-right">
                <p className="text-xs text-foreground">×{p.qty}</p>
                <p className="text-xs text-muted-foreground">${(p.qty * p.unitCost).toFixed(2)}</p>
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
        <div className="size-10 rounded-full bg-secondary flex items-center justify-center">
          <Zap size={16} className="text-muted-foreground" />
        </div>
        <p className="text-sm text-muted-foreground">No activity yet</p>
        {onAddEntry && (
          <button
            onClick={onAddEntry}
            className="flex items-center gap-1.5 rounded-lg bg-primary text-primary-foreground px-3 py-2 text-sm hover:bg-primary/90 transition-colors"
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
            className="flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-xs text-foreground hover:border-primary/30 hover:bg-primary/10 hover:text-primary transition-colors"
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
                {!isLast && <span className="w-px flex-1 bg-secondary my-1" />}
              </div>

              {/* Content */}
              <div className={`flex-1 min-w-0 ${isLast ? '' : 'pb-4'}`}>
                <div className="flex items-start justify-between gap-2 mb-0.5">
                  <div className="flex items-center gap-1.5 min-w-0">
                    {event.authorInitials && (
                      <span
                        className="flex size-4 shrink-0 items-center justify-center rounded-full text-primary-foreground"
                        style={{ fontSize: 7, background: event.authorColor ?? '#94a3b8' }}
                      >
                        {event.authorInitials}
                      </span>
                    )}
                    {event.author && (
                      <span className="text-xs text-muted-foreground truncate">{event.author}</span>
                    )}
                  </div>
                  <span className="text-xs text-muted-foreground shrink-0">{event.time}</span>
                </div>

                {/* Content block */}
                {event.type === 'note' ? (
                  <div className="rounded-lg bg-secondary border border-border px-3 py-2 mt-1">
                    <p className="text-sm text-foreground">{event.content}</p>
                  </div>
                ) : event.type === 'voice' ? (
                  <div className="rounded-lg bg-primary/10 border border-primary/20 px-3 py-2 mt-1">
                    <div className="flex items-center gap-2 mb-1">
                      <Mic size={12} className="text-primary" />
                      {event.voiceDuration && (
                        <span className="text-xs text-primary bg-primary/15 rounded-full px-1.5 py-0.5">
                          {event.voiceDuration}s
                        </span>
                      )}
                    </div>
                    <p className="text-sm text-foreground italic">{event.content}</p>
                  </div>
                ) : event.type === 'system' ? (
                  <p className="text-xs text-muted-foreground italic mt-0.5">{event.content}</p>
                ) : (
                  <p className="text-sm mt-0.5 text-foreground">
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

import { useState } from 'react';
import {
  Check, AlertTriangle, ArrowRight,
  Clock, Calendar, User, Mic, Briefcase,
  CheckCircle2, RefreshCw, CloudOff,
  ChevronRight,
} from 'lucide-react';
import { AILabel } from '../shared';

// ── 1 · Create schedule from conversation ─────────────────────────────────
export function CreateFromConvoDemo() {
  const [input, setInput]   = useState('');
  const [state, setState]   = useState<'idle' | 'parsed' | 'confirmed'>('idle');
  const suggestions = ['Schedule Davis HVAC for Thursday at 2pm', 'Book Martinez plumbing Friday morning', 'Set up Williams painting for next Tuesday'];

  function parse() {
    if (!input.trim()) return;
    setState('parsed');
  }

  if (state === 'confirmed') return (
    <div className="flex flex-col gap-3" style={{ animation: 'stepIn 0.2s ease' }}>
      <div className="rounded-xl bg-green-50 border border-green-200 px-4 py-3.5 flex items-center gap-3">
        <CheckCircle2 size={18} className="text-green-500 shrink-0" />
        <div><p className="text-sm text-green-900">Job #1044 scheduled</p><p className="text-xs text-green-600">Thu Mar 12 · 2:00 PM · Carlos Reyes</p></div>
      </div>
      <button onClick={() => { setState('idle'); setInput(''); }} className="text-xs text-center text-slate-400 hover:text-slate-600">Try again</button>
    </div>
  );

  if (state === 'parsed') return (
    <div className="flex flex-col gap-3" style={{ animation: 'stepIn 0.2s ease' }}>
      <div className="rounded-xl bg-indigo-50 border border-indigo-200 px-4 py-3">
        <AILabel text="✦ I understood" />
        <p className="text-xs text-slate-500 mt-0.5 italic">"{input}"</p>
      </div>
      <div className="rounded-xl bg-white border border-slate-200 overflow-hidden">
        {[
          { icon: Briefcase,  label: 'Job',  value: '#1044 Davis HVAC · Mini-split inspection' },
          { icon: Calendar,   label: 'Date', value: 'Thursday, March 12, 2026' },
          { icon: Clock,      label: 'Time', value: '2:00 PM – 4:00 PM (2hr est.)' },
          { icon: User,       label: 'Tech', value: 'Carlos Reyes · available' },
        ].map(({ icon: Icon, label, value }) => (
          <div key={label} className="flex items-center gap-3 px-4 py-2.5 border-b border-slate-50 last:border-0">
            <Icon size={13} className="text-slate-400 shrink-0" />
            <span className="text-xs text-slate-400 w-8 shrink-0">{label}</span>
            <span className="text-sm text-slate-800">{value}</span>
          </div>
        ))}
      </div>
      <div className="flex gap-2">
        <button onClick={() => setState('confirmed')} className="flex-1 flex items-center justify-center gap-2 rounded-xl bg-slate-900 text-white py-2.5 text-sm hover:bg-slate-700 transition-colors">
          <Check size={14} /> Confirm schedule
        </button>
        <button onClick={() => setState('idle')} className="rounded-xl border border-slate-200 px-4 py-2.5 text-sm text-slate-700 hover:bg-slate-50 transition-colors">Edit</button>
      </div>
    </div>
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <div className="flex-1 flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3.5 py-3 focus-within:border-indigo-400 transition-colors">
          <Mic size={14} className="text-slate-400 shrink-0" />
          <input value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => e.key === 'Enter' && parse()}
            placeholder="Schedule a job in plain English…"
            className="flex-1 text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none" />
        </div>
        <button onClick={parse} disabled={!input.trim()}
          className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-indigo-600 text-white hover:bg-indigo-500 disabled:opacity-30 transition-all">
          <ArrowRight size={16} />
        </button>
      </div>
      <div className="flex flex-col gap-1">
        {suggestions.map(s => (
          <button key={s} onClick={() => { setInput(s); setState('parsed'); }}
            className="flex items-center gap-2 text-left rounded-xl bg-slate-50 border border-slate-100 px-3.5 py-2.5 hover:bg-slate-100 transition-colors">
            <ChevronRight size={11} className="text-slate-400 shrink-0" />
            <span className="text-sm text-slate-600">{s}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

// ── 2 · Move job from conversation ────────────────────────────────────────
export function MoveJobDemo() {
  const [state, setState] = useState<'idle' | 'preview' | 'moved'>('idle');
  const [input, setInput] = useState('');

  if (state === 'moved') return (
    <div className="flex flex-col gap-2" style={{ animation: 'stepIn 0.2s ease' }}>
      <div className="rounded-xl bg-green-50 border border-green-200 px-4 py-3 flex items-center gap-3">
        <Check size={15} className="text-green-500 shrink-0" />
        <p className="text-sm text-green-900">Job moved — Johnson now on Wed Mar 11 at 9:00 AM</p>
      </div>
      <button onClick={() => { setState('idle'); setInput(''); }} className="text-xs text-center text-slate-400 hover:text-slate-600">Reset</button>
    </div>
  );

  if (state === 'preview') return (
    <div className="flex flex-col gap-3" style={{ animation: 'stepIn 0.2s ease' }}>
      <AILabel text="✦ Here's what I'll change" />
      <div className="grid grid-cols-2 gap-2">
        <div className="rounded-xl bg-slate-100 border border-slate-200 px-3.5 py-3">
          <p className="text-xs text-slate-500 mb-1">Before</p>
          <p className="text-sm text-slate-800">Tue Mar 10</p>
          <p className="text-xs text-slate-500">2:00 PM · Marcus</p>
        </div>
        <div className="rounded-xl bg-green-50 border border-green-200 px-3.5 py-3">
          <p className="text-xs text-green-600 mb-1">After</p>
          <p className="text-sm text-slate-900">Wed Mar 11</p>
          <p className="text-xs text-slate-600">9:00 AM · Marcus</p>
        </div>
      </div>
      <p className="text-xs text-slate-500">Marcus Webb is available Wed 9 AM. Customer has not been notified yet.</p>
      <div className="flex gap-2">
        <button onClick={() => setState('moved')} className="flex-1 flex items-center justify-center gap-2 rounded-xl bg-slate-900 text-white py-2.5 text-sm hover:bg-slate-700 transition-colors">
          <Check size={14} /> Confirm move
        </button>
        <button onClick={() => setState('idle')} className="rounded-xl border border-slate-200 px-4 py-2.5 text-sm text-slate-600 hover:bg-slate-50 transition-colors">Cancel</button>
      </div>
    </div>
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <input value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => e.key === 'Enter' && setState('preview')}
          placeholder="e.g. Move Johnson job to Wednesday morning"
          className="flex-1 rounded-xl border border-slate-200 px-4 py-3 text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none focus:border-indigo-400 transition-colors" />
        <button onClick={() => setState('preview')} className="flex size-11 items-center justify-center rounded-xl bg-indigo-600 text-white hover:bg-indigo-500 transition-all shrink-0">
          <ArrowRight size={16} />
        </button>
      </div>
      <button onClick={() => { setInput('Move Johnson job to Wednesday morning'); setState('preview'); }}
        className="flex items-center gap-2 rounded-xl bg-slate-50 border border-slate-100 px-3.5 py-2.5 text-sm text-slate-600 hover:bg-slate-100 transition-colors">
        <ChevronRight size={11} className="text-slate-400" /> Try: "Move Johnson job to Wednesday morning"
      </button>
    </div>
  );
}

// ── 3 · Assign tech from calendar ─────────────────────────────────────────
export function AssignTechDemo() {
  const [selected, setSelected] = useState<string | null>(null);
  const [assigned, setAssigned] = useState(false);

  const techs = [
    { id: 'carlos', name: 'Carlos Reyes', cert: 'HVAC', jobs: 2, status: 'available', color: '#3B82F6' },
    { id: 'marcus', name: 'Marcus Webb',  cert: 'Plumbing', jobs: 1, status: 'available', color: '#10B981' },
    { id: 'sarah',  name: 'Sarah Lin',    cert: 'Painting', jobs: 3, status: 'busy',      color: '#8B5CF6' },
  ];

  if (assigned) return (
    <div className="rounded-xl bg-green-50 border border-green-200 px-4 py-3.5 flex items-center gap-3" style={{ animation: 'stepIn 0.2s ease' }}>
      <CheckCircle2 size={18} className="text-green-500 shrink-0" />
      <div>
        <p className="text-sm text-green-900">{techs.find(t => t.id === selected)?.name} assigned</p>
        <p className="text-xs text-green-600">Job #1044 · Thu Mar 12 · 2:00 PM</p>
      </div>
      <button onClick={() => { setAssigned(false); setSelected(null); }} className="ml-auto text-xs text-green-700 hover:underline">Reset</button>
    </div>
  );

  return (
    <div className="flex flex-col gap-2.5">
      <p className="text-xs text-slate-500">Thu Mar 12 — available technicians</p>
      {techs.map(tech => (
        <button key={tech.id} onClick={() => tech.status === 'available' && setSelected(tech.id)}
          disabled={tech.status === 'busy'}
          className={`flex items-center gap-3 rounded-xl border px-4 py-3.5 text-left transition-all ${
            tech.status === 'busy'    ? 'border-slate-100 bg-slate-50 opacity-50 cursor-not-allowed' :
            selected === tech.id     ? 'border-blue-400 bg-blue-50 shadow-sm' : 'border-slate-200 bg-white hover:border-slate-300'
          }`}>
          <span className="flex size-9 items-center justify-center rounded-full text-white shrink-0"
            style={{ backgroundColor: tech.color, fontSize: 12 }}>
            {tech.name.split(' ').map(n => n[0]).join('')}
          </span>
          <div className="flex-1 min-w-0">
            <p className="text-sm text-slate-800">{tech.name}</p>
            <p className="text-xs text-slate-500">{tech.cert} · {tech.jobs} job{tech.jobs !== 1 ? 's' : ''} this day</p>
          </div>
          <span className={`text-xs px-2 py-0.5 rounded-full ${
            tech.status === 'available' ? 'bg-green-100 text-green-700' : 'bg-slate-100 text-slate-500'
          }`}>{tech.status}</span>
          {selected === tech.id && <Check size={14} className="text-blue-500 shrink-0" />}
        </button>
      ))}
      {selected && (
        <button onClick={() => setAssigned(true)}
          className="flex items-center justify-center gap-2 rounded-xl bg-slate-900 text-white py-3 text-sm hover:bg-slate-700 transition-colors"
          style={{ animation: 'stepIn 0.2s ease' }}>
          <Check size={14} /> Assign {techs.find(t => t.id === selected)?.name.split(' ')[0]}
        </button>
      )}
    </div>
  );
}

// ── 4 · Conflict resolution ────────────────────────────────────────────────
export function ConflictDemo() {
  const [state,  setState]  = useState<'conflict' | 'resolved'>('conflict');
  const [choice, setChoice] = useState<string | null>(null);

  if (state === 'resolved') return (
    <div className="rounded-xl bg-green-50 border border-green-200 px-4 py-3.5" style={{ animation: 'stepIn 0.2s ease' }}>
      <CheckCircle2 size={16} className="text-green-500 mb-1.5" />
      <p className="text-sm text-green-900">Conflict resolved · {choice}</p>
      <button onClick={() => { setState('conflict'); setChoice(null); }} className="text-xs text-green-600 mt-1.5 hover:underline">Reset</button>
    </div>
  );

  const options = [
    { label: 'Move to 4:00 PM Thursday', sub: 'Carlos is free all afternoon', icon: Clock,  color: 'border-blue-200 hover:border-blue-400' },
    { label: 'Assign Marcus Webb instead', sub: 'Marcus available all day Thu', icon: User,  color: 'border-green-200 hover:border-green-400' },
    { label: 'Keep at 2 PM — override',   sub: 'Carlos will have a double booking', icon: AlertTriangle, color: 'border-amber-200 hover:border-amber-400' },
  ];

  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-xl bg-red-50 border border-red-200 px-4 py-3">
        <div className="flex items-start gap-2.5">
          <AlertTriangle size={15} className="text-red-500 shrink-0 mt-0.5" />
          <div>
            <p className="text-sm text-red-900">Scheduling conflict detected</p>
            <p className="text-xs text-red-600 mt-0.5">Carlos Reyes already has Job #1043 at 2:00 PM Thursday</p>
          </div>
        </div>
      </div>
      <p className="text-xs text-slate-500 px-1">Choose a resolution:</p>
      {options.map(opt => {
        const Icon = opt.icon;
        return (
          <button key={opt.label} onClick={() => { setChoice(opt.label); setState('resolved'); }}
            className={`flex items-start gap-3 rounded-xl border px-4 py-3 text-left transition-all ${opt.color} bg-white`}>
            <Icon size={14} className="text-slate-400 shrink-0 mt-0.5" />
            <div>
              <p className="text-sm text-slate-800">{opt.label}</p>
              <p className="text-xs text-slate-500 mt-0.5">{opt.sub}</p>
            </div>
          </button>
        );
      })}
    </div>
  );
}

// ── 5 · External calendar sync status ─────────────────────────────────────
export function SyncStatusDemo() {
  const [states, setStates] = useState({ google: 'synced', icloud: 'synced', outlook: 'error' });
  type SyncState = 'synced' | 'syncing' | 'error';

  function toggle(cal: keyof typeof states) {
    const cycle: Record<SyncState, SyncState> = { synced: 'syncing', syncing: 'error', error: 'synced' };
    setStates(s => ({ ...s, [cal]: cycle[s[cal] as SyncState] }));
  }

  const cals = [
    { key: 'google',  label: 'Google Calendar',     icon: '📅' },
    { key: 'icloud',  label: 'Apple Calendar',      icon: '🍎' },
    { key: 'outlook', label: 'Microsoft Outlook',   icon: '📧' },
  ];

  const STATE_CONFIG = {
    synced:  { icon: CheckCircle2, color: 'text-green-500', bg: 'bg-green-100', label: 'Synced just now' },
    syncing: { icon: RefreshCw,   color: 'text-blue-500',  bg: 'bg-blue-100',  label: 'Syncing…' },
    error:   { icon: CloudOff,    color: 'text-red-500',   bg: 'bg-red-100',   label: 'Error — reconnect' },
  };

  return (
    <div className="flex flex-col gap-2.5">
      <p className="text-xs text-slate-400 px-1">Tap any row to cycle through states</p>
      {cals.map(cal => {
        const s = states[cal.key as keyof typeof states] as SyncState;
        const cfg = STATE_CONFIG[s];
        const Icon = cfg.icon;
        return (
          <button key={cal.key} onClick={() => toggle(cal.key as keyof typeof states)}
            className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3.5 text-left hover:bg-slate-50 transition-colors group">
            <span className="text-xl">{cal.icon}</span>
            <div className="flex-1">
              <p className="text-sm text-slate-800">{cal.label}</p>
              <p className={`text-xs mt-0.5 ${cfg.color}`}>{cfg.label}</p>
            </div>
            <span className={`flex size-7 items-center justify-center rounded-full ${cfg.bg}`}>
              <Icon size={13} className={`${cfg.color} ${s === 'syncing' ? 'animate-spin' : ''}`} />
            </span>
            {s === 'error' && (
              <span className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-2.5 py-1.5 hover:bg-red-100 transition-colors">
                Reconnect
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

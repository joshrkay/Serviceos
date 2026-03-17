import { useState, useEffect, useRef } from 'react';
import {
  ArrowLeft, Navigation, Phone, MapPin, Clock,
  CheckCircle2, Package, FileText, Camera, Mic,
  AlertTriangle, X, Zap, Plus, Minus, StopCircle,
  Sparkles, ChevronDown, ChevronUp, RotateCcw,
  MessageSquare, Check, Pencil,
} from 'lucide-react';
import { useNavigate } from 'react-router';
import { jobs, technicians, customers } from '../../data/mock-data';
import { ActivityTimeline } from './ActivityTimeline';
import { CancelNoShowSheet } from './CancelNoShowSheet';
import { CallScreen, TextSheet } from './JobSheets';
import { CameraCapture } from '../shared/CameraCapture';
import type { JobActivity, MaterialItem, ServiceType } from '../../data/mock-data';
import type { CapturedMedia } from '../shared/CameraCapture';

// ─── Types ─────────────────────────────────────────────────────────────────────
type TechStatus  = 'en_route' | 'on_site' | 'in_progress' | 'waiting' | 'complete';
type VoiceState  = 'idle' | 'recording' | 'processing' | 'result';
type TechSheet   = 'cancel' | 'call' | 'text' | 'camera' | null;

interface FieldNote  { id: string; text: string; time: string; source: 'voice' | 'typed'; }
interface VoiceResult {
  transcript: string;
  notes:   FieldNote[];
  parts:   MaterialItem[];
  statusUpdate?: TechStatus;
}

// ─── Status flow ───────────────────────────────────────────────────────────────
const STATUS_FLOW: {
  key: TechStatus; label: string; cta: string;
  dotColor: string; ctaBg: string;
}[] = [
  { key: 'en_route',    label: 'En Route',          cta: "I've Arrived",    dotColor: 'bg-blue-500',   ctaBg: 'bg-blue-600   hover:bg-blue-700'   },
  { key: 'on_site',     label: 'On Site',            cta: 'Start Job',       dotColor: 'bg-green-500',  ctaBg: 'bg-green-600  hover:bg-green-700'  },
  { key: 'in_progress', label: 'In Progress',        cta: 'Mark Complete',   dotColor: 'bg-indigo-500', ctaBg: 'bg-indigo-600 hover:bg-indigo-700' },
  { key: 'waiting',     label: 'Waiting for Parts',  cta: 'Resume Job',      dotColor: 'bg-amber-500',  ctaBg: 'bg-amber-600  hover:bg-amber-700'  },
  { key: 'complete',    label: 'Complete',            cta: '',                dotColor: 'bg-green-500',  ctaBg: '' },
];

// ─── Parts catalog for voice parsing ──────────────────────────────────────────
const PARTS_CATALOG: {
  keywords: string[];
  entry: Omit<MaterialItem, 'id' | 'qty'>;
}[] = [
  { keywords: ['capacitor', 'cap', '35/5', '45/5', 'run cap'],
    entry: { name: '45/5 MFD Dual Run Capacitor', partNumber: 'CAP-45-5-440V', unitCost: 28.50, category: 'Part' } },
  { keywords: ['contactor', 'relay'],
    entry: { name: 'Contactor 40A 24V Coil', partNumber: 'CONT-2P-40A', unitCost: 22.00, category: 'Part' } },
  { keywords: ['refrigerant', 'r-410a', 'freon', 'recharge'],
    entry: { name: '1-Ton R-410A Refrigerant (lb)', partNumber: 'R410A-LB', unitCost: 18.00, category: 'Material' } },
  { keywords: ['filter', 'air filter'],
    entry: { name: '16x25x1 MERV-8 Filter', partNumber: 'FILT-16251', unitCost: 9.50, category: 'Part' } },
  { keywords: ['thermostat', 'nest'],
    entry: { name: 'Nest Learning Thermostat', partNumber: 'NEST-GEN4', unitCost: 199.00, category: 'Equipment' } },
  { keywords: ['drain tab', 'drain pill'],
    entry: { name: 'Drain Pan Treatment Tablets', partNumber: 'DRAIN-TAB-12', unitCost: 14.00, category: 'Material' } },
  { keywords: ['p-trap', 'ptrap'],
    entry: { name: 'P-Trap 1.5" ABS', partNumber: 'PTRAP-15', unitCost: 6.25, category: 'Part' } },
  { keywords: ['wax ring', 'wax seal'],
    entry: { name: 'Wax Ring w/ Bolts', partNumber: 'WAX-RING', unitCost: 7.50, category: 'Part' } },
  { keywords: ['flapper', 'toilet flapper'],
    entry: { name: 'Toilet Flapper Valve', partNumber: 'FLAP-STD', unitCost: 5.50, category: 'Part' } },
  { keywords: ['primer', 'prime'],
    entry: { name: 'Premium Primer (gal)', partNumber: 'PRIM-GAL', unitCost: 34.00, category: 'Material' } },
  { keywords: ['caulk', 'sealant'],
    entry: { name: 'Silicone Sealant', partNumber: 'SEAL-01', unitCost: 8.00, category: 'Material' } },
];

// Status detection patterns
const STATUS_PATTERNS: [RegExp, TechStatus][] = [
  [/\b(done|finish|finished|completed|all done|wrapping up|signed off|that'?s? it)\b/i, 'complete'],
  [/\b(starting|started|beginning|kicking off|on site|arrived|here now|let me in)\b/i, 'in_progress'],
  [/\b(on my way|heading|leaving|en route|driving)\b/i, 'en_route'],
  [/\b(waiting|need to order|ordered|back.?order|getting parts|parts coming)\b/i, 'waiting'],
];

function extractQty(text: string, keyword: string): number {
  const t = text.toLowerCase();
  const patterns = [
    new RegExp(`(\\d+)\\s*(?:lbs?|units?|pcs?|pieces?|of)?\\s*(?:more\\s*)?${keyword}`, 'i'),
    new RegExp(`(\\d+)\\s+${keyword}`, 'i'),
    new RegExp(`${keyword}s?\\s*[x×]?\\s*(\\d+)`, 'i'),
  ];
  for (const p of patterns) {
    const m = t.match(p);
    if (m) return Math.min(parseInt(m[1]), 20);
  }
  return 1;
}

function parseVoice(text: string): VoiceResult {
  const t   = text.toLowerCase();
  const now = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

  // Status
  let statusUpdate: TechStatus | undefined;
  for (const [pattern, status] of STATUS_PATTERNS) {
    if (pattern.test(t)) { statusUpdate = status; break; }
  }

  // Parts
  const parts: MaterialItem[] = [];
  const seen = new Set<string>();
  for (const { keywords, entry } of PARTS_CATALOG) {
    for (const kw of keywords) {
      if (t.includes(kw) && !seen.has(entry.partNumber ?? '')) {
        seen.add(entry.partNumber ?? '');
        parts.push({ id: `vp-${Date.now()}-${kw}`, qty: extractQty(text, kw), ...entry });
        break;
      }
    }
  }

  // Always log as note
  const notes: FieldNote[] = [{
    id: `vn-${Date.now()}`,
    text: text.charAt(0).toUpperCase() + text.slice(1),
    time: now,
    source: 'voice',
  }];

  return { transcript: text, notes, parts, statusUpdate };
}

// Voice transcripts per status (deterministic for demo)
const VOICE_SCRIPTS: Record<TechStatus, string> = {
  en_route:    "On my way now, about 10 minutes out.",
  on_site:     "Arrived. Customer let me in — the AC unit is in the side yard. Found a bad 45/5 MFD run capacitor on the compressor. Need to replace it and check the refrigerant level.",
  in_progress: "Replaced the run capacitor. System was low — added 2 lbs of R-410A. Starting the recharge now. Looks like the contactor is pitted too, recommending a replace while I'm here.",
  waiting:     "Waiting on a contactor. Ordered it — should be here in an hour. Letting the customer know.",
  complete:    "All done. Replaced the capacitor, recharged the system, and swapped the contactor. Customer tested it, everything is cooling. Signed off.",
};

// ─── Waveform ──────────────────────────────────────────────────────────────────
function Waveform({ active }: { active: boolean }) {
  return (
    <div className="flex items-center justify-center gap-[3px] h-7">
      {Array.from({ length: 24 }).map((_, i) => (
        <div key={i}
          className={`w-[2.5px] rounded-full ${active ? 'bg-red-400' : 'bg-slate-300'}`}
          style={{
            animation: active ? 'waveBar 0.65s ease-in-out infinite' : 'none',
            animationDelay: `${i * 0.03}s`, height: '100%',
          }}
        />
      ))}
      <style>{`@keyframes waveBar{0%,100%{transform:scaleY(0.1)}50%{transform:scaleY(1)}}`}</style>
    </div>
  );
}

// ─── Voice Hero ────────────────────────────────────────────────────────────────
function VoiceHero({
  techStatus, svcType, onResult,
}: {
  techStatus: TechStatus;
  svcType: ServiceType;
  onResult: (r: VoiceResult, applied: boolean) => void;
}) {
  const [phase,   setPhase]   = useState<VoiceState>('idle');
  const [seconds, setSeconds] = useState(0);
  const [result,  setResult]  = useState<VoiceResult | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (phase !== 'recording') return;
    timerRef.current = setInterval(() => setSeconds(s => s + 1), 1000);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [phase]);

  useEffect(() => {
    if (phase === 'recording' && seconds >= 10) stopRecording();
  }, [seconds, phase]);

  function startRecording() { setPhase('recording'); setSeconds(0); }

  function stopRecording() {
    if (timerRef.current) clearInterval(timerRef.current);
    setPhase('processing');
    setTimeout(() => {
      const transcript = VOICE_SCRIPTS[techStatus];
      setResult(parseVoice(transcript));
      setPhase('result');
    }, 1600);
  }

  function confirm() {
    if (result) { onResult(result, true); setPhase('idle'); setResult(null); }
  }
  function discard() { setPhase('idle'); setResult(null); }

  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

  if (phase === 'idle') return (
    <div className="flex flex-col items-center gap-4 py-6">
      <button onClick={startRecording}
        className="group relative flex flex-col items-center gap-2.5">
        {/* Ripple rings */}
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="size-24 rounded-full bg-slate-900/5 scale-0 group-hover:scale-100 transition-transform duration-300" />
        </div>
        <div className="relative flex size-20 items-center justify-center rounded-full bg-slate-900 shadow-xl shadow-slate-900/25
          hover:bg-slate-700 active:scale-95 transition-all">
          <Mic size={28} className="text-white" />
        </div>
        <div className="text-center">
          <p className="text-sm text-slate-800">Tap to add by voice</p>
          <p className="text-xs text-slate-400 mt-0.5">note · part · status update</p>
        </div>
      </button>
    </div>
  );

  if (phase === 'recording') return (
    <div className="flex flex-col items-center gap-3 py-5">
      <div className="flex items-center gap-2">
        <span className="size-2.5 rounded-full bg-red-500 animate-pulse" />
        <span className="text-sm text-red-600">{fmt(seconds)} · Listening…</span>
      </div>
      <Waveform active />
      <button onClick={stopRecording}
        className="flex items-center gap-2 bg-red-500 text-white rounded-full px-6 py-2.5 text-sm hover:bg-red-600 active:scale-95 transition-all shadow-lg shadow-red-500/30">
        <StopCircle size={15} /> Done talking
      </button>
      <p className="text-xs text-slate-400">Auto-stops at 10s</p>
    </div>
  );

  if (phase === 'processing') return (
    <div className="flex flex-col items-center gap-3 py-8">
      <div className="flex size-10 items-center justify-center rounded-full bg-indigo-100">
        <Sparkles size={18} className="text-indigo-600 animate-pulse" />
      </div>
      <p className="text-sm text-slate-600">Processing…</p>
    </div>
  );

  if (phase === 'result' && result) return (
    <div className="flex flex-col gap-3 py-3" style={{ animation: 'fadeUp 0.2s ease' }}>
      {/* Transcript */}
      <div className="flex items-start gap-2.5">
        <div className="flex size-7 items-center justify-center rounded-full bg-slate-800 shrink-0">
          <Mic size={11} className="text-white" />
        </div>
        <div className="flex-1 bg-slate-100 rounded-2xl rounded-tl-sm px-3.5 py-2.5">
          <p className="text-xs text-slate-400 mb-0.5">You said</p>
          <p className="text-sm text-slate-700 italic leading-relaxed">"{result.transcript}"</p>
        </div>
      </div>

      {/* Parsed results */}
      <div className="rounded-xl border border-indigo-100 bg-indigo-50 px-4 py-3 flex flex-col gap-2">
        <p className="text-xs text-indigo-500">AI parsed</p>

        {result.statusUpdate && (
          <div className="flex items-center gap-2">
            <CheckCircle2 size={13} className="text-indigo-600 shrink-0" />
            <p className="text-sm text-indigo-900">
              Status → <span className="font-medium">{STATUS_FLOW.find(s => s.key === result.statusUpdate)?.label}</span>
            </p>
          </div>
        )}
        {result.notes.map(n => (
          <div key={n.id} className="flex items-start gap-2">
            <FileText size={13} className="text-indigo-600 shrink-0 mt-0.5" />
            <p className="text-sm text-indigo-900 leading-snug">{n.text.length > 80 ? n.text.slice(0, 80) + '…' : n.text}</p>
          </div>
        ))}
        {result.parts.map(p => (
          <div key={p.id} className="flex items-center gap-2">
            <Package size={13} className="text-indigo-600 shrink-0" />
            <p className="text-sm text-indigo-900">
              {p.name} <span className="text-indigo-500">× {p.qty}</span>
              <span className="text-indigo-500 ml-1">· ${(p.qty * p.unitCost).toFixed(2)}</span>
            </p>
          </div>
        ))}
      </div>

      <div className="flex gap-2">
        <button onClick={discard}
          className="flex items-center gap-1.5 rounded-xl border border-slate-200 px-3 py-2.5 text-sm text-slate-600 hover:bg-slate-50 transition-colors">
          <RotateCcw size={12} /> Discard
        </button>
        <button onClick={confirm}
          className="flex-1 flex items-center justify-center gap-1.5 rounded-xl bg-slate-900 text-white py-2.5 text-sm hover:bg-slate-700 transition-colors">
          <Check size={14} /> Add all
        </button>
      </div>
    </div>
  );

  return null;
}

// ─── Notes section ─────────────────────────────────────────────────────────────
function NotesSection({ notes, onAdd }: {
  notes: FieldNote[];
  onAdd: (text: string) => void;
}) {
  const [open,   setOpen]   = useState(true);
  const [typing, setTyping] = useState(false);
  const [draft,  setDraft]  = useState('');

  function submit() {
    if (draft.trim()) { onAdd(draft.trim()); setDraft(''); setTyping(false); }
  }

  return (
    <div className="rounded-2xl bg-white border border-slate-200 overflow-hidden">
      <button onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-3 px-4 py-3.5 text-left hover:bg-slate-50 transition-colors">
        <div className="flex size-7 items-center justify-center rounded-lg bg-slate-100 shrink-0">
          <FileText size={13} className="text-slate-600" />
        </div>
        <p className="flex-1 text-sm text-slate-800">Notes</p>
        {notes.length > 0 && (
          <span className="text-xs bg-slate-100 text-slate-600 rounded-full px-2 py-0.5">{notes.length}</span>
        )}
        {open ? <ChevronUp size={14} className="text-slate-400 shrink-0" /> : <ChevronDown size={14} className="text-slate-400 shrink-0" />}
      </button>

      {open && (
        <div className="border-t border-slate-100">
          {notes.length === 0 && !typing && (
            <p className="text-xs text-slate-400 px-4 py-3 italic">No notes yet — use voice or type below</p>
          )}
          {notes.map((n, i) => (
            <div key={n.id} className={`flex items-start gap-3 px-4 py-3 ${i > 0 ? 'border-t border-slate-50' : ''}`}>
              <div className={`flex size-6 items-center justify-center rounded-full shrink-0 mt-0.5 ${
                n.source === 'voice' ? 'bg-indigo-100' : 'bg-slate-100'
              }`}>
                {n.source === 'voice'
                  ? <Mic size={10} className="text-indigo-600" />
                  : <Pencil size={10} className="text-slate-500" />
                }
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm text-slate-700 leading-relaxed">{n.text}</p>
                <p className="text-xs text-slate-400 mt-0.5">{n.time}</p>
              </div>
            </div>
          ))}
          {typing ? (
            <div className="border-t border-slate-100 p-3 flex flex-col gap-2">
              <textarea
                autoFocus value={draft} onChange={e => setDraft(e.target.value)}
                placeholder="Type your note…" rows={3}
                className="w-full text-sm text-slate-700 placeholder-slate-400 border border-slate-200 rounded-xl px-3 py-2.5 focus:outline-none focus:border-blue-400 resize-none"
                onKeyDown={e => { if (e.key === 'Enter' && e.metaKey) submit(); }}
              />
              <div className="flex gap-2">
                <button onClick={() => { setTyping(false); setDraft(''); }}
                  className="flex-1 rounded-xl border border-slate-200 py-2 text-sm text-slate-600 hover:bg-slate-50">
                  Cancel
                </button>
                <button onClick={submit} disabled={!draft.trim()}
                  className="flex-1 rounded-xl bg-slate-900 text-white py-2 text-sm disabled:opacity-40 hover:bg-slate-700">
                  Add note
                </button>
              </div>
            </div>
          ) : (
            <div className="border-t border-slate-100 px-4 py-2.5">
              <button onClick={() => setTyping(true)}
                className="flex items-center gap-1.5 text-xs text-slate-500 hover:text-slate-700 transition-colors">
                <Pencil size={11} /> Type a note
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Photos section ────────────────────────────────────────────────────────────
const PHOTO_COLORS = [
  'bg-slate-700', 'bg-slate-600', 'bg-slate-500', 'bg-slate-800',
  'bg-zinc-700',  'bg-neutral-700', 'bg-stone-700', 'bg-gray-700',
];
const PHOTO_LABELS = ['Before – overview', 'Equipment close-up', 'Problem area', 'After – overview',
                      'Parts removed',     'Access point',       'Customer sig.', 'Detail shot'];

function PhotosSection({ media, onAdd }: {
  media: { id: string; label: string; color: string; isReal?: boolean; url?: string }[];
  onAdd: () => void;
}) {
  const [open, setOpen] = useState(true);

  return (
    <div className="rounded-2xl bg-white border border-slate-200 overflow-hidden">
      <button onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-3 px-4 py-3.5 text-left hover:bg-slate-50 transition-colors">
        <div className="flex size-7 items-center justify-center rounded-lg bg-sky-100 shrink-0">
          <Camera size={13} className="text-sky-600" />
        </div>
        <p className="flex-1 text-sm text-slate-800">Photos</p>
        {media.length > 0 && (
          <span className="text-xs bg-sky-100 text-sky-700 rounded-full px-2 py-0.5">{media.length}</span>
        )}
        {open ? <ChevronUp size={14} className="text-slate-400 shrink-0" /> : <ChevronDown size={14} className="text-slate-400 shrink-0" />}
      </button>

      {open && (
        <div className="border-t border-slate-100 p-3">
          <div className="grid grid-cols-3 gap-2">
            {media.map(ph => (
              <div key={ph.id}
                className={`relative aspect-square rounded-xl overflow-hidden flex flex-col items-center justify-center ${ph.color}`}
                style={{ animation: 'fadeUp 0.2s ease' }}>
                {ph.isReal && ph.url
                  ? <img src={ph.url} className="w-full h-full object-cover" alt="" />
                  : <>
                      <Camera size={16} className="text-white/50" />
                      <p className="text-white/50 mt-1" style={{ fontSize: 9 }}>{ph.label}</p>
                    </>
                }
              </div>
            ))}
            {media.length < 8 && (
              <button onClick={onAdd}
                className="aspect-square rounded-xl border-2 border-dashed border-slate-200 flex flex-col items-center justify-center gap-1 hover:border-sky-400 hover:bg-sky-50 active:bg-sky-100 transition-colors">
                <Camera size={18} className="text-slate-400" />
                <p className="text-xs text-slate-400">Add</p>
              </button>
            )}
          </div>
          {media.length === 0 && (
            <p className="text-xs text-slate-400 text-center mt-2">No photos yet</p>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Materials section ──────────────────────────────────────────────────────────
function MaterialsSection({ materials, onUpdate }: {
  materials: MaterialItem[];
  onUpdate: (updated: MaterialItem[]) => void;
}) {
  const [open, setOpen] = useState(true);
  const total = materials.reduce((s, m) => s + m.qty * m.unitCost, 0);

  function setQty(id: string, delta: number) {
    onUpdate(materials.map(m => m.id === id
      ? { ...m, qty: Math.max(0, m.qty + delta) }
      : m
    ).filter(m => m.qty > 0));
  }
  function remove(id: string) { onUpdate(materials.filter(m => m.id !== id)); }

  const CATEGORY_COLORS: Record<string, string> = {
    Part:      'bg-blue-100 text-blue-700',
    Material:  'bg-green-100 text-green-700',
    Labor:     'bg-purple-100 text-purple-700',
    Equipment: 'bg-amber-100 text-amber-700',
  };

  return (
    <div className="rounded-2xl bg-white border border-slate-200 overflow-hidden">
      <button onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-3 px-4 py-3.5 text-left hover:bg-slate-50 transition-colors">
        <div className="flex size-7 items-center justify-center rounded-lg bg-amber-100 shrink-0">
          <Package size={13} className="text-amber-600" />
        </div>
        <p className="flex-1 text-sm text-slate-800">Materials & Parts</p>
        {materials.length > 0 && (
          <span className="text-xs bg-amber-100 text-amber-700 rounded-full px-2 py-0.5">{materials.length}</span>
        )}
        {open ? <ChevronUp size={14} className="text-slate-400 shrink-0" /> : <ChevronDown size={14} className="text-slate-400 shrink-0" />}
      </button>

      {open && (
        <div className="border-t border-slate-100">
          {materials.length === 0 ? (
            <p className="text-xs text-slate-400 px-4 py-3 italic">No parts logged yet — use voice to add</p>
          ) : (
            <>
              <div className="divide-y divide-slate-50">
                {materials.map(m => (
                  <div key={m.id} className="flex items-center gap-3 px-4 py-3">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-slate-800 leading-snug">{m.name}</p>
                      <div className="flex items-center gap-2 mt-1">
                        <span className={`text-xs rounded-full px-2 py-0.5 ${CATEGORY_COLORS[m.category] ?? 'bg-slate-100 text-slate-500'}`}>
                          {m.category}
                        </span>
                        <span className="text-xs text-slate-400">${m.unitCost.toFixed(2)}/ea</span>
                      </div>
                    </div>
                    {/* Qty stepper */}
                    <div className="flex items-center gap-1.5 shrink-0">
                      <button onClick={() => setQty(m.id, -1)}
                        className="flex size-7 items-center justify-center rounded-lg border border-slate-200 hover:bg-slate-100 active:scale-90 transition-all">
                        <Minus size={11} className="text-slate-600" />
                      </button>
                      <span className="w-6 text-center text-sm text-slate-800">{m.qty}</span>
                      <button onClick={() => setQty(m.id, +1)}
                        className="flex size-7 items-center justify-center rounded-lg border border-slate-200 hover:bg-slate-100 active:scale-90 transition-all">
                        <Plus size={11} className="text-slate-600" />
                      </button>
                    </div>
                    <p className="w-14 text-right text-sm text-slate-800 shrink-0">
                      ${(m.qty * m.unitCost).toFixed(2)}
                    </p>
                    <button onClick={() => remove(m.id)} className="text-slate-300 hover:text-red-400 transition-colors shrink-0">
                      <X size={13} />
                    </button>
                  </div>
                ))}
              </div>
              <div className="flex items-center justify-between px-4 py-3 border-t border-slate-100 bg-slate-50">
                <p className="text-xs text-slate-500">Total materials</p>
                <p className="text-sm text-slate-900">${total.toFixed(2)}</p>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Main page ──────────────────────────────────────────────────────────────────
const SVC_ICON: Record<ServiceType, string> = { HVAC: '❄️', Plumbing: '🔧', Painting: '🎨' };
const SVC_BG:   Record<ServiceType, string> = {
  HVAC:     'bg-blue-900/40',
  Plumbing: 'bg-green-900/40',
  Painting: 'bg-violet-900/40',
};

export function TechJobView({ id }: { id: string }) {
  const navigate = useNavigate();
  const job       = jobs.find(j => j.id === id);
  const customer  = customers.find(c => c.id === job?.customerId);
  const tech      = technicians.find(t => t.name === job?.assignedTech);

  const [techStatus, setTechStatus] = useState<TechStatus>('on_site');
  const [sheet,      setSheet]      = useState<TechSheet>(null);
  const [activities, setActivities] = useState<JobActivity[]>(job?.activity ?? []);
  const [materials,  setMaterials]  = useState<MaterialItem[]>(job?.materials ?? []);
  const [photos,     setPhotos]     = useState<{ id: string; label: string; color: string; isReal?: boolean; url?: string }[]>(
    (job?.photos ?? 0) > 0
      ? Array.from({ length: Math.min(job!.photos!, 3) }, (_, i) => ({
          id: `init-${i}`, label: PHOTO_LABELS[i], color: PHOTO_COLORS[i],
        }))
      : []
  );
  const [notes,   setNotes]   = useState<FieldNote[]>([]);
  const [cameraOpen, setCam] = useState(false);

  if (!job) return (
    <div className="flex h-full items-center justify-center">
      <p className="text-slate-400 text-sm">Job not found</p>
    </div>
  );

  const mapsUrl       = `https://maps.google.com/?q=${encodeURIComponent(job.address)}`;
  const customerPhone = customer?.phone ?? '(512) 555-0000';
  const statusIdx     = STATUS_FLOW.findIndex(s => s.key === techStatus);
  const currentStatus = STATUS_FLOW[statusIdx];
  const isComplete    = techStatus === 'complete';
  const now = () => new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

  function advanceStatus() {
    if (statusIdx >= STATUS_FLOW.length - 1) return;
    const next = STATUS_FLOW[statusIdx + 1];
    setTechStatus(next.key);
    const msgs: Record<TechStatus, string> = {
      en_route: '', on_site: 'Arrived at job site', in_progress: 'Started work on the job',
      waiting: 'Waiting for parts', complete: 'Marked job complete',
    };
    setActivities(prev => [...prev, {
      id: `tech-${Date.now()}`, type: 'check_in',
      content: msgs[next.key], time: now(),
      author: tech?.name ?? 'Technician',
      authorInitials: tech?.initials ?? 'TC',
      authorColor: tech?.color ?? '#475569',
    }]);
  }

  function handleVoiceResult(result: VoiceResult) {
    const t = now();
    if (result.statusUpdate) setTechStatus(result.statusUpdate);
    if (result.notes.length > 0) setNotes(prev => [...prev, ...result.notes]);
    if (result.parts.length > 0) setMaterials(prev => [...prev, ...result.parts.map(p => ({ ...p, id: `vp-${Date.now()}-${Math.random()}` }))]);
    setActivities(prev => [...prev, {
      id: `va-${Date.now()}`, type: 'voice',
      content: `"${result.transcript.slice(0, 80)}${result.transcript.length > 80 ? '…' : ''}"`,
      time: t, author: tech?.name ?? 'Technician',
      authorInitials: tech?.initials ?? 'TC',
      authorColor: tech?.color ?? '#475569',
      voiceDuration: 8 + Math.floor(Math.random() * 6),
    }]);
  }

  function addNote(text: string) {
    const n: FieldNote = { id: `n-${Date.now()}`, text, time: now(), source: 'typed' };
    setNotes(prev => [...prev, n]);
    setActivities(prev => [...prev, {
      id: `na-${Date.now()}`, type: 'note', content: text, time: now(),
      author: tech?.name ?? 'Technician',
      authorInitials: tech?.initials ?? 'TC',
      authorColor: tech?.color ?? '#475569',
    }]);
  }

  function handleCameraClose(media: CapturedMedia[]) {
    if (media.length) {
      const newPhotos = media.map((m, i) => ({
        id: m.id, label: PHOTO_LABELS[(photos.length + i) % PHOTO_LABELS.length],
        color: PHOTO_COLORS[(photos.length + i) % PHOTO_COLORS.length],
        isReal: m.type === 'photo', url: m.url,
      }));
      setPhotos(prev => [...prev, ...newPhotos]);
      setActivities(prev => [...prev, {
        id: `ph-${Date.now()}`, type: 'photo',
        content: `${media.length} photo${media.length > 1 ? 's' : ''} added`,
        time: now(), author: tech?.name ?? 'Technician',
        authorInitials: tech?.initials ?? 'TC',
        authorColor: tech?.color ?? '#475569',
      }]);
    }
    setCam(false);
  }

  return (
    <>
      <div className="flex flex-col h-full bg-slate-50 overflow-hidden">

        {/* ── Top bar ── */}
        <div className="shrink-0 bg-slate-900 px-4 py-3 flex items-center justify-between">
          <button onClick={() => navigate(`/jobs/${id}`)}
            className="flex items-center gap-1.5 text-slate-400 hover:text-white text-sm transition-colors">
            <ArrowLeft size={14} /> Owner view
          </button>
          <div className="flex items-center gap-2">
            {job.priority === 'Urgent' && (
              <span className="flex items-center gap-1 text-xs bg-red-500 text-white rounded-full px-2 py-0.5">
                <Zap size={10} /> Urgent
              </span>
            )}
            <span className="text-xs text-slate-400">#{job.jobNumber}</span>
            <span
              className="flex size-7 items-center justify-center rounded-full text-white text-xs"
              style={{ background: tech?.color ?? '#475569' }}>
              {tech?.initials ?? 'TC'}
            </span>
          </div>
        </div>

        {/* ── Scrollable body ── */}
        <div className="flex-1 overflow-y-auto pb-28">
          <div className="max-w-lg mx-auto">

            {/* ── Job hero ── */}
            <div className={`${SVC_BG[job.serviceType]} bg-slate-900 px-5 pt-5 pb-6`}>
              <div className="flex items-start gap-3 mb-3">
                <span className="text-3xl">{SVC_ICON[job.serviceType]}</span>
                <div className="flex-1 min-w-0">
                  <h2 className="text-white leading-tight">{job.customer}</h2>
                  <div className="flex items-center gap-1.5 mt-1">
                    <MapPin size={12} className="text-slate-400 shrink-0" />
                    <p className="text-slate-300 text-sm truncate">{job.address}</p>
                  </div>
                  {job.scheduledDate && (
                    <div className="flex items-center gap-1.5 mt-1">
                      <Clock size={12} className="text-slate-400 shrink-0" />
                      <p className="text-slate-300 text-sm">{job.scheduledDate}{job.scheduledTime ? ` · ${job.scheduledTime}` : ''}</p>
                    </div>
                  )}
                </div>
              </div>

              <div className="bg-white/10 rounded-xl px-3.5 py-2.5 mb-4">
                <p className="text-xs text-slate-400 mb-0.5">Job description</p>
                <p className="text-sm text-white leading-relaxed">{job.description}</p>
              </div>

              {/* Access notes */}
              {job.notes && (
                <div className="flex items-start gap-2 bg-amber-500/20 border border-amber-400/30 rounded-xl px-3.5 py-2.5 mb-4">
                  <AlertTriangle size={13} className="text-amber-400 shrink-0 mt-0.5" />
                  <p className="text-sm text-amber-200 leading-relaxed">{job.notes}</p>
                </div>
              )}

              {/* Contact row */}
              <div className="grid grid-cols-2 gap-2">
                <a href={mapsUrl} target="_blank" rel="noreferrer"
                  className="flex items-center gap-2 rounded-xl bg-white/10 hover:bg-white/20 px-3 py-2.5 transition-colors">
                  <Navigation size={15} className="text-violet-300 shrink-0" />
                  <div className="min-w-0">
                    <p className="text-xs text-slate-400">Directions</p>
                    <p className="text-xs text-white truncate">{job.address.split(',')[0]}</p>
                  </div>
                </a>
                <button onClick={() => setSheet('call')}
                  className="flex items-center gap-2 rounded-xl bg-white/10 hover:bg-white/20 px-3 py-2.5 transition-colors text-left">
                  <Phone size={15} className="text-green-300 shrink-0" />
                  <div className="min-w-0">
                    <p className="text-xs text-slate-400">Call</p>
                    <p className="text-xs text-white truncate">{customerPhone}</p>
                  </div>
                </button>
              </div>
            </div>

            {/* ── Status bar ── */}
            <div className="bg-white border-b border-slate-100 px-5 py-4">
              <div className="flex items-center justify-between mb-3">
                <p className="text-xs text-slate-500">Status</p>
                <span className={`text-xs px-2.5 py-0.5 rounded-full text-white ${currentStatus.ctaBg.split(' ')[0]}`}>
                  {currentStatus.label}
                </span>
              </div>
              {/* Progress dots */}
              <div className="flex items-center gap-1 mb-3">
                {STATUS_FLOW.slice(0, 4).map((s, i) => {
                  const sIdx = STATUS_FLOW.indexOf(s);
                  const done = statusIdx >= sIdx;
                  return (
                    <div key={s.key} className="flex items-center flex-1">
                      <div className={`size-2.5 rounded-full shrink-0 transition-all duration-300 ${done ? s.dotColor : 'bg-slate-200'}`} />
                      {i < 3 && <div className={`flex-1 h-px transition-colors duration-300 ${done && statusIdx > sIdx ? 'bg-green-400' : 'bg-slate-200'}`} />}
                    </div>
                  );
                })}
              </div>
              {!isComplete ? (
                <button onClick={advanceStatus}
                  className={`flex items-center justify-center gap-2 w-full py-3.5 rounded-xl text-white text-sm transition-colors ${currentStatus.ctaBg}`}>
                  <CheckCircle2 size={16} /> {currentStatus.cta}
                </button>
              ) : (
                <div className="flex items-center justify-center gap-2 w-full py-3.5 rounded-xl bg-green-50 text-green-700 text-sm border border-green-200">
                  <CheckCircle2 size={16} /> Job complete!
                </div>
              )}
            </div>

            {/* ── VOICE HERO ── */}
            <div className="mx-4 mt-4 rounded-2xl bg-white border-2 border-slate-200 px-5 py-2 overflow-hidden">
              <div className="flex items-center justify-between mb-1">
                <div className="flex items-center gap-2">
                  <div className="flex size-6 items-center justify-center rounded-full bg-indigo-100">
                    <Sparkles size={11} className="text-indigo-600" />
                  </div>
                  <p className="text-xs text-slate-500">Voice add — fastest in the field</p>
                </div>
              </div>
              <VoiceHero
                techStatus={techStatus}
                svcType={job.serviceType}
                onResult={(result, applied) => { if (applied) handleVoiceResult(result); }}
              />
            </div>

            {/* ── Quick action chips ── */}
            <div className="px-4 mt-3">
              <p className="text-xs text-slate-400 mb-2 px-1">Or tap to add manually</p>
              <div className="grid grid-cols-4 gap-2">
                {[
                  { icon: Pencil,        label: 'Note',    bg: 'bg-slate-100',  color: 'text-slate-700', onClick: () => {} },
                  { icon: Camera,        label: 'Photo',   bg: 'bg-sky-100',    color: 'text-sky-700',   onClick: () => setCam(true) },
                  { icon: Package,       label: 'Parts',   bg: 'bg-amber-100',  color: 'text-amber-700', onClick: () => {} },
                  { icon: AlertTriangle, label: 'Issue',   bg: 'bg-red-100',    color: 'text-red-700',   onClick: () => setSheet('cancel') },
                ].map(({ icon: Icon, label, bg, color, onClick }) => (
                  <button key={label} onClick={onClick}
                    className={`flex flex-col items-center gap-1.5 rounded-xl py-3 ${bg} hover:opacity-80 active:scale-95 transition-all`}>
                    <Icon size={18} className={color} />
                    <span className={`text-xs ${color}`}>{label}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* ── Inline sections ── */}
            <div className="px-4 mt-4 flex flex-col gap-3 pb-4">
              <NotesSection notes={notes} onAdd={addNote} />
              <PhotosSection media={photos} onAdd={() => setCam(true)} />
              <MaterialsSection materials={materials} onUpdate={setMaterials} />

              {/* Activity timeline */}
              {activities.length > 0 && (
                <div className="rounded-2xl bg-white border border-slate-200 px-4 py-4">
                  <p className="text-sm text-slate-700 mb-3">Activity log</p>
                  <ActivityTimeline activities={activities.slice(-6)} compact />
                </div>
              )}
            </div>

          </div>
        </div>

        {/* ── Bottom CTA ── */}
        {!isComplete && (
          <div className="shrink-0 fixed bottom-0 left-0 right-0 md:absolute bg-white/90 backdrop-blur border-t border-slate-200 px-5 py-4 flex gap-3">
            <button onClick={() => setSheet('call')}
              className="flex size-12 items-center justify-center rounded-xl bg-slate-100 hover:bg-slate-200 transition-colors shrink-0">
              <Phone size={18} className="text-slate-700" />
            </button>
            <button onClick={() => setCam(true)}
              className="flex size-12 items-center justify-center rounded-xl bg-slate-100 hover:bg-slate-200 transition-colors shrink-0">
              <Camera size={18} className="text-slate-700" />
            </button>
            <button onClick={advanceStatus}
              className={`flex-1 flex items-center justify-center gap-2 rounded-xl text-white text-sm py-3 transition-colors ${currentStatus.ctaBg}`}>
              <CheckCircle2 size={16} /> {currentStatus.cta}
            </button>
          </div>
        )}

      </div>

      {/* ── Sheets ── */}
      {sheet === 'cancel' && customer && (
        <CancelNoShowSheet
          job={job} customerName={customer.name} customerPhone={customerPhone}
          onClose={() => setSheet(null)}
        />
      )}
      {sheet === 'call' && customer && (
        <CallScreen
          name={customer.name} phone={customerPhone}
          initials={customer.name.split(' ').map(n => n[0]).join('')}
          color={tech?.color ?? '#475569'}
          onEnd={() => setSheet(null)}
        />
      )}
      {sheet === 'text' && customer && (
        <TextSheet name={customer.name} phone={customerPhone} onClose={() => setSheet(null)} />
      )}
      {cameraOpen && <CameraCapture onClose={handleCameraClose} />}

      <style>{`
        @keyframes fadeUp { from{opacity:0;transform:translateY(6px)} to{opacity:1;transform:translateY(0)} }
      `}</style>
    </>
  );
}

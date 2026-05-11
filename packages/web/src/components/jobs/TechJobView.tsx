import { useState, useEffect, useRef, useCallback } from 'react';
import {
  ArrowLeft, Navigation, Phone, MapPin, Clock,
  CheckCircle2, Package, FileText, Camera, Mic,
  AlertTriangle, X, Zap, Plus, Minus, StopCircle,
  Sparkles, ChevronDown, ChevronUp, RotateCcw,
  MessageSquare, Check, Pencil,
} from 'lucide-react';
import { useNavigate } from 'react-router';
import { ActivityTimeline } from './ActivityTimeline';
import { CancelNoShowSheet } from './CancelNoShowSheet';
import { CallScreen, TextSheet } from './JobSheets';
import { CameraCapture } from '../shared/CameraCapture';
import type { CapturedMedia } from '../shared/CameraCapture';
import { useApiClient } from '../../lib/apiClient';
import type { JobActivity, MaterialItem, ServiceType } from '../../data/mock-data';

// ─── API types ─────────────────────────────────────────────────────────────────
interface ApiJobDetail {
  id: string;
  jobNumber: string;
  summary: string;
  problemDescription?: string;
  status: string;
  priority?: string;
  customerId?: string;
  assignedTechnicianId?: string;
  scheduledStart?: string;
  serviceType?: string;
  customer?: {
    id: string;
    displayName?: string;
    firstName?: string;
    lastName?: string;
    primaryPhone?: string;
    email?: string;
    notes?: string;
    locations?: Array<{ street1?: string; city?: string; state?: string; postalCode?: string }>;
  };
  technician?: {
    id: string;
    firstName?: string;
    lastName?: string;
    color?: string;
  };
}

interface ApiNote {
  id: string;
  content: string;
  createdAt: string;
}

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
  apiStatus: string;
}[] = [
  { key: 'en_route',    label: 'En Route',          cta: "I've Arrived",    dotColor: 'bg-blue-500',   ctaBg: 'bg-blue-600   hover:bg-blue-700',   apiStatus: 'in_progress' },
  { key: 'on_site',     label: 'On Site',            cta: 'Start Job',       dotColor: 'bg-green-500',  ctaBg: 'bg-green-600  hover:bg-green-700',  apiStatus: 'in_progress' },
  { key: 'in_progress', label: 'In Progress',        cta: 'Mark Complete',   dotColor: 'bg-indigo-500', ctaBg: 'bg-indigo-600 hover:bg-indigo-700', apiStatus: 'in_progress' },
  { key: 'waiting',     label: 'Waiting for Parts',  cta: 'Resume Job',      dotColor: 'bg-amber-500',  ctaBg: 'bg-amber-600  hover:bg-amber-700',  apiStatus: 'in_progress' },
  { key: 'complete',    label: 'Complete',            cta: '',                dotColor: 'bg-green-500',  ctaBg: '', apiStatus: 'completed' },
];

// Map API status → TechStatus
function apiStatusToTech(status: string): TechStatus {
  if (status === 'completed') return 'complete';
  if (status === 'in_progress') return 'in_progress';
  if (status === 'scheduled') return 'en_route';
  return 'en_route';
}

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

  let statusUpdate: TechStatus | undefined;
  for (const [pattern, status] of STATUS_PATTERNS) {
    if (pattern.test(t)) { statusUpdate = status; break; }
  }

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

  const notes: FieldNote[] = [{
    id: `vn-${Date.now()}`,
    text: text.charAt(0).toUpperCase() + text.slice(1),
    time: now,
    source: 'voice',
  }];

  return { transcript: text, notes, parts, statusUpdate };
}

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
  jobId,
  techStatus,
  onResult,
  apiFetch,
}: {
  jobId: string;
  techStatus: TechStatus;
  onResult: (r: VoiceResult, applied: boolean) => void;
  apiFetch: (url: string, init?: RequestInit) => Promise<Response>;
}) {
  const [phase,   setPhase]   = useState<VoiceState>('idle');
  const [seconds, setSeconds] = useState(0);
  const [result,  setResult]  = useState<VoiceResult | null>(null);
  const [micError, setMicError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);

  useEffect(() => {
    if (phase !== 'recording') return;
    timerRef.current = setInterval(() => setSeconds(s => s + 1), 1000);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [phase]);

  useEffect(() => {
    if (phase === 'recording' && seconds >= 30) stopRecording();
  }, [seconds, phase]);

  async function startRecording() {
    setMicError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioChunksRef.current = [];
      const mr = new MediaRecorder(stream, { mimeType: MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : 'audio/ogg' });
      mr.ondataavailable = (e) => { if (e.data.size > 0) audioChunksRef.current.push(e.data); };
      mr.start(250);
      mediaRecorderRef.current = mr;
      setPhase('recording');
      setSeconds(0);
    } catch {
      setMicError('Microphone access denied. Please allow microphone permissions.');
    }
  }

  function stopRecording() {
    if (timerRef.current) clearInterval(timerRef.current);
    const mr = mediaRecorderRef.current;
    if (!mr) return;

    mr.onstop = async () => {
      mr.stream.getTracks().forEach(t => t.stop());
      setPhase('processing');
      const mimeType = mr.mimeType || 'audio/webm';
      const blob = new Blob(audioChunksRef.current, { type: mimeType });

      try {
        const formData = new FormData();
        formData.append('audio', blob, `recording.${mimeType.includes('ogg') ? 'ogg' : 'webm'}`);
        const res = await apiFetch('/api/voice/transcribe', { method: 'POST', body: formData });
        if (res.ok) {
          const data = await res.json() as { transcript?: string };
          const transcript = data.transcript?.trim() ?? '';
          if (transcript) {
            setResult(parseVoice(transcript));
            setPhase('result');
            return;
          }
        }
      } catch {
        // Fall back to mic prompt message if transcription fails
      }
      // If transcription not available, show a generic placeholder result
      const fallback = 'Voice update recorded.';
      setResult(parseVoice(fallback));
      setPhase('result');
    };

    if (mr.state !== 'inactive') mr.stop();
  }

  function confirm() {
    if (result) { onResult(result, true); setPhase('idle'); setResult(null); }
  }
  function discard() { setPhase('idle'); setResult(null); }

  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

  if (phase === 'idle') return (
    <div className="flex flex-col items-center gap-4 py-6">
      {micError && (
        <div className="rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-xs text-red-600">
          {micError}
        </div>
      )}
      <button onClick={() => void startRecording()}
        className="group relative flex flex-col items-center gap-2.5">
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
      <p className="text-xs text-slate-400">Auto-stops at 30s</p>
    </div>
  );

  if (phase === 'processing') return (
    <div className="flex flex-col items-center gap-3 py-8">
      <div className="flex size-10 items-center justify-center rounded-full bg-indigo-100">
        <Sparkles size={18} className="text-indigo-600 animate-pulse" />
      </div>
      <p className="text-sm text-slate-600">Transcribing…</p>
    </div>
  );

  if (phase === 'result' && result) return (
    <div className="flex flex-col gap-3 py-3" style={{ animation: 'fadeUp 0.2s ease' }}>
      <div className="flex items-start gap-2.5">
        <div className="flex size-7 items-center justify-center rounded-full bg-slate-800 shrink-0">
          <Mic size={11} className="text-white" />
        </div>
        <div className="flex-1 bg-slate-100 rounded-2xl rounded-tl-sm px-3.5 py-2.5">
          <p className="text-xs text-slate-400 mb-0.5">Transcript</p>
          <p className="text-sm text-slate-700 italic leading-relaxed">"{result.transcript}"</p>
        </div>
      </div>

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
        <p className="flex-1 text-sm text-slate-800">Materials &amp; Parts</p>
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

// ─── SVC config maps ────────────────────────────────────────────────────────────
const SVC_ICON: Record<string, string> = { HVAC: '❄️', Plumbing: '🔧', Painting: '🎨' };
const SVC_BG: Record<string, string> = {
  HVAC:     'bg-blue-900/40',
  Plumbing: 'bg-green-900/40',
  Painting: 'bg-violet-900/40',
};
const DELAY_OPTIONS = [10, 15, 20, 60] as const;
type DelayOption = (typeof DELAY_OPTIONS)[number];

// ─── Main page ──────────────────────────────────────────────────────────────────
export function TechJobView({ id }: { id: string }) {
  const navigate = useNavigate();
  const apiFetch = useApiClient();

  const [jobData, setJobData] = useState<ApiJobDetail | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [techStatus, setTechStatus] = useState<TechStatus>('on_site');
  const [sheet,      setSheet]      = useState<TechSheet>(null);
  const [activities, setActivities] = useState<JobActivity[]>([]);
  const [materials,  setMaterials]  = useState<MaterialItem[]>([]);
  const [photos,     setPhotos]     = useState<{ id: string; label: string; color: string; isReal?: boolean; url?: string }[]>([]);
  const [notes,   setNotes]   = useState<FieldNote[]>([]);
  const [cameraOpen, setCam] = useState(false);
  const [isRunningBehind, setIsRunningBehind] = useState<boolean | null>(null);
  const [delayMinutes, setDelayMinutes] = useState<DelayOption | null>(null);

  const loadJob = useCallback(async () => {
    setIsLoading(true);
    setLoadError(null);
    try {
      const res = await apiFetch(`/api/jobs/${id}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as ApiJobDetail;
      setJobData(data);
      setTechStatus(apiStatusToTech(data.status));
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Failed to load job');
    } finally {
      setIsLoading(false);
    }
  }, [apiFetch, id]);

  // Load persisted notes from API
  const loadNotes = useCallback(async () => {
    try {
      const res = await apiFetch(`/api/notes?entityType=job&entityId=${id}`);
      if (!res.ok) return;
      const data = await res.json() as { data?: ApiNote[] };
      const apiNotes = (data.data ?? []).map<FieldNote>(n => ({
        id: n.id,
        text: n.content,
        time: new Date(n.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
        source: 'typed',
      }));
      setNotes(apiNotes);
    } catch {
      // notes load failure is non-critical
    }
  }, [apiFetch, id]);

  useEffect(() => {
    void loadJob();
    void loadNotes();
  }, [loadJob, loadNotes]);

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-slate-400 text-sm">Loading job…</div>
      </div>
    );
  }

  if (loadError || !jobData) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3">
        <p className="text-slate-400 text-sm">{loadError ?? 'Job not found'}</p>
        <button onClick={() => navigate(-1)} className="text-xs text-blue-600 hover:underline">← Back</button>
      </div>
    );
  }

  const customerName = jobData.customer
    ? (jobData.customer.displayName || [jobData.customer.firstName, jobData.customer.lastName].filter(Boolean).join(' ') || 'Customer')
    : 'Customer';
  const primaryLoc = jobData.customer?.locations?.[0];
  const address = primaryLoc
    ? [primaryLoc.street1, primaryLoc.city, primaryLoc.state, primaryLoc.postalCode].filter(Boolean).join(', ')
    : '';
  const customerPhone = jobData.customer?.primaryPhone ?? '(512) 555-0000';
  const customerNotes = jobData.customer?.notes ?? '';
  const techName = jobData.technician
    ? [jobData.technician.firstName, jobData.technician.lastName].filter(Boolean).join(' ')
    : 'Technician';
  const techColor = jobData.technician?.color ?? '#475569';
  const techInitials = techName.split(' ').map((n: string) => n[0]).join('').slice(0, 2).toUpperCase() || 'TC';
  const svcType = (jobData.serviceType ?? 'HVAC') as ServiceType;

  const mapsUrl = `https://maps.google.com/?q=${encodeURIComponent(address)}`;
  const statusIdx = STATUS_FLOW.findIndex(s => s.key === techStatus);
  const currentStatus = STATUS_FLOW[statusIdx];
  const isComplete = techStatus === 'complete';
  const now = () => new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

  async function advanceStatus() {
    if (statusIdx >= STATUS_FLOW.length - 1) return;
    const next = STATUS_FLOW[statusIdx + 1];
    setTechStatus(next.key);

    // Persist to API
    try {
      await apiFetch(`/api/jobs/${id}/transition`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: next.apiStatus }),
      });
    } catch {
      // status update failure is non-critical for the field UI
    }

    const msgs: Record<TechStatus, string> = {
      en_route: '', on_site: 'Arrived at job site', in_progress: 'Started work on the job',
      waiting: 'Waiting for parts', complete: 'Marked job complete',
    };
    setActivities(prev => [...prev, {
      id: `tech-${Date.now()}`, type: 'check_in',
      content: msgs[next.key], time: now(),
      author: techName,
      authorInitials: techInitials,
      authorColor: techColor,
    }]);
  }

  async function saveNoteToApi(content: string, source: 'voice' | 'typed'): Promise<string | null> {
    try {
      const res = await apiFetch('/api/notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entityType: 'job', entityId: id, content }),
      });
      if (res.ok) {
        const data = await res.json() as { id?: string };
        return data.id ?? null;
      }
    } catch {
      // note save failure is non-critical
    }
    return null;
  }

  function handleVoiceResult(result: VoiceResult) {
    const t = now();
    if (result.statusUpdate) {
      setTechStatus(result.statusUpdate);
      const apiStatus = STATUS_FLOW.find(s => s.key === result.statusUpdate)?.apiStatus ?? 'in_progress';
      void apiFetch(`/api/jobs/${id}/transition`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: apiStatus }),
      });
    }
    if (result.notes.length > 0) {
      const newNotes = result.notes.map(n => ({ ...n, source: 'voice' as const }));
      setNotes(prev => [...prev, ...newNotes]);
      // Persist each voice note
      result.notes.forEach(n => void saveNoteToApi(n.text, 'voice'));
    }
    if (result.parts.length > 0) setMaterials(prev => [...prev, ...result.parts.map(p => ({ ...p, id: `vp-${Date.now()}-${Math.random()}` }))]);
    setActivities(prev => [...prev, {
      id: `va-${Date.now()}`, type: 'voice',
      content: `"${result.transcript.slice(0, 80)}${result.transcript.length > 80 ? '…' : ''}"`,
      time: t, author: techName,
      authorInitials: techInitials,
      authorColor: techColor,
      voiceDuration: 8 + Math.floor(Math.random() * 6),
    }]);
  }

  async function addNote(text: string) {
    const savedId = await saveNoteToApi(text, 'typed');
    const n: FieldNote = { id: savedId ?? `n-${Date.now()}`, text, time: now(), source: 'typed' };
    setNotes(prev => [...prev, n]);
    setActivities(prev => [...prev, {
      id: `na-${Date.now()}`, type: 'note', content: text, time: now(),
      author: techName,
      authorInitials: techInitials,
      authorColor: techColor,
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
        time: now(), author: techName,
        authorInitials: techInitials,
        authorColor: techColor,
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
            {jobData.priority === 'urgent' && (
              <span className="flex items-center gap-1 text-xs bg-red-500 text-white rounded-full px-2 py-0.5">
                <Zap size={10} /> Urgent
              </span>
            )}
            <span className="text-xs text-slate-400">#{jobData.jobNumber}</span>
            <span
              className="flex size-7 items-center justify-center rounded-full text-white text-xs"
              style={{ background: techColor }}>
              {techInitials}
            </span>
          </div>
        </div>

        {/* ── Scrollable body ── */}
        <div className="flex-1 overflow-y-auto pb-28">
          <div className="max-w-lg mx-auto">

            {/* ── Job hero ── */}
            <div className={`${SVC_BG[svcType] ?? SVC_BG.HVAC} bg-slate-900 px-5 pt-5 pb-6`}>
              <div className="flex items-start gap-3 mb-3">
                <span className="text-3xl">{SVC_ICON[svcType] ?? '🔧'}</span>
                <div className="flex-1 min-w-0">
                  <h2 className="text-white leading-tight">{customerName}</h2>
                  <div className="flex items-center gap-1.5 mt-1">
                    <MapPin size={12} className="text-slate-400 shrink-0" />
                    <p className="text-slate-300 text-sm truncate">{address || 'No address on file'}</p>
                  </div>
                  {jobData.scheduledStart && (
                    <div className="flex items-center gap-1.5 mt-1">
                      <Clock size={12} className="text-slate-400 shrink-0" />
                      <p className="text-slate-300 text-sm">
                        {new Date(jobData.scheduledStart).toLocaleDateString([], { month: 'short', day: 'numeric' })}
                        {' · '}
                        {new Date(jobData.scheduledStart).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </p>
                    </div>
                  )}
                </div>
              </div>

              <div className="bg-white/10 rounded-xl px-3.5 py-2.5 mb-4">
                <p className="text-xs text-slate-400 mb-0.5">Job description</p>
                <p className="text-sm text-white leading-relaxed">{jobData.summary}</p>
                {jobData.problemDescription && (
                  <p className="text-xs text-slate-300 mt-1 leading-relaxed">{jobData.problemDescription}</p>
                )}
              </div>

              {/* Customer notes (access notes, preferences) */}
              {customerNotes && (
                <div className="flex items-start gap-2 bg-amber-500/20 border border-amber-400/30 rounded-xl px-3.5 py-2.5 mb-4">
                  <AlertTriangle size={13} className="text-amber-400 shrink-0 mt-0.5" />
                  <p className="text-sm text-amber-200 leading-relaxed">{customerNotes}</p>
                </div>
              )}

              {/* Contact row */}
              <div className="grid grid-cols-2 gap-2">
                <a href={mapsUrl} target="_blank" rel="noreferrer"
                  className="flex items-center gap-2 rounded-xl bg-white/10 hover:bg-white/20 px-3 py-2.5 transition-colors">
                  <Navigation size={15} className="text-violet-300 shrink-0" />
                  <div className="min-w-0">
                    <p className="text-xs text-slate-400">Directions</p>
                    <p className="text-xs text-white truncate">{address.split(',')[0] || 'Navigate'}</p>
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
                <button onClick={() => void advanceStatus()}
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
                jobId={id}
                techStatus={techStatus}
                onResult={(result, applied) => { if (applied) handleVoiceResult(result); }}
                apiFetch={apiFetch}
              />
            </div>

            {/* ── Quick action chips ── */}
            <div className="px-4 mt-3">
              <div className="rounded-2xl border border-slate-200 bg-white p-3.5 mb-3">
                <p className="text-xs text-slate-500 mb-2.5">Running behind?</p>
                <div className="flex items-center gap-2">
                  {(['Yes', 'No'] as const).map((label) => {
                    const selected =
                      (label === 'Yes' && isRunningBehind === true) ||
                      (label === 'No' && isRunningBehind === false);
                    return (
                      <button
                        key={label}
                        onClick={() => {
                          const behind = label === 'Yes';
                          setIsRunningBehind(behind);
                          if (!behind) setDelayMinutes(null);
                        }}
                        className={`rounded-full px-3 py-1.5 text-xs border transition-colors ${
                          selected
                            ? 'bg-slate-900 text-white border-slate-900'
                            : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
                        }`}
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>
                <div className="flex flex-wrap gap-2 mt-2.5">
                  {DELAY_OPTIONS.map((minutes) => (
                    <button
                      key={minutes}
                      onClick={() => setDelayMinutes(minutes)}
                      disabled={isRunningBehind !== true}
                      className={`rounded-full px-3 py-1.5 text-xs border transition-colors ${
                        delayMinutes === minutes
                          ? 'bg-indigo-600 text-white border-indigo-600'
                          : 'bg-white text-slate-600 border-slate-200'
                      } ${isRunningBehind === true ? 'hover:bg-slate-50' : 'opacity-50 cursor-not-allowed'}`}
                    >
                      {minutes}
                    </button>
                  ))}
                </div>
              </div>
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
              <NotesSection notes={notes} onAdd={(text) => void addNote(text)} />
              <PhotosSection media={photos} onAdd={() => setCam(true)} />
              <MaterialsSection materials={materials} onUpdate={setMaterials} />

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
            <button onClick={() => void advanceStatus()}
              className={`flex-1 flex items-center justify-center gap-2 rounded-xl text-white text-sm py-3 transition-colors ${currentStatus.ctaBg}`}>
              <CheckCircle2 size={16} /> {currentStatus.cta}
            </button>
          </div>
        )}

      </div>

      {/* ── Sheets ── */}
      {sheet === 'cancel' && (
        <CancelNoShowSheet
          job={{ id, jobNumber: jobData.jobNumber, customer: customerName, customerId: jobData.customerId ?? '', address, serviceType: svcType, status: 'Active', priority: 'Normal', assignedTech: techName, description: jobData.summary, statusHistory: [], activity: [], materials: [] }}
          customerName={customerName}
          customerPhone={customerPhone}
          onClose={() => setSheet(null)}
        />
      )}
      {sheet === 'call' && (
        <CallScreen
          name={customerName} phone={customerPhone}
          initials={customerName.split(' ').map((n: string) => n[0]).join('')}
          color={techColor}
          onEnd={() => setSheet(null)}
        />
      )}
      {sheet === 'text' && (
        <TextSheet name={customerName} phone={customerPhone} onClose={() => setSheet(null)} />
      )}
      {cameraOpen && <CameraCapture onClose={handleCameraClose} />}

      <style>{`
        @keyframes fadeUp { from{opacity:0;transform:translateY(6px)} to{opacity:1;transform:translateY(0)} }
      `}</style>
    </>
  );
}

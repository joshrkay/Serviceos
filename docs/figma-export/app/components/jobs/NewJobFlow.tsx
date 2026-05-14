import { useState, useEffect, useRef } from 'react';
import {
  X, Search, Check, ArrowLeft, Mic, StopCircle, Sparkles,
  RotateCcw, Calendar, Clock, User, AlertCircle, MapPin,
  ChevronRight, ClipboardList, Pencil, Zap, Send, FileText,
  Plus, ChevronDown,
} from 'lucide-react';
import { customers, technicians } from '../../data/mock-data';
import type { ServiceType } from '../../data/mock-data';

// ─── Types ────────────────────────────────────────────────────────────────────
type FlowStep   = 'start' | 'voice' | 'customer' | 'details' | 'schedule' | 'done';
type VoicePhase = 'idle' | 'recording' | 'processing' | 'parsed' | 'confirmed';

interface JobDraft {
  customerId:    string | null;
  locationId:    string | null;
  serviceType:   ServiceType | null;
  description:   string;
  priority:      'Normal' | 'Urgent';
  scheduledDate: string;
  scheduledTime: string;
  assignedTech:  string;
  notes:         string;
}

interface ParsedJob extends JobDraft {
  customerName: string;
  address:      string;
}

// ─── Constants ────────────────────────────────────────────────────────────────
const SVC_CHIP: Record<ServiceType, string> = {
  HVAC:     'bg-blue-50 text-blue-700 border-blue-200',
  Plumbing: 'bg-green-50 text-green-700 border-green-200',
  Painting: 'bg-violet-50 text-violet-700 border-violet-200',
};
const SVC_ICON: Record<ServiceType, string> = { HVAC: '❄️', Plumbing: '🔧', Painting: '🎨' };

const BLANK: JobDraft = {
  customerId: null, locationId: null, serviceType: null,
  description: '', priority: 'Normal',
  scheduledDate: '', scheduledTime: '', assignedTech: '', notes: '',
};

// ─── Voice demo transcripts ───────────────────────────────────────────────────
const VOICE_SAMPLES = [
  "Schedule an HVAC job for Maria Garcia tomorrow at 2pm, assign to Carlos Reyes. AC unit not cooling in the bedroom.",
  "New urgent plumbing job for James Wilson today. Pipe burst under kitchen sink. Get Marcus Webb on it right away.",
  "Exterior painting job for the Chen family on Friday at 10am. Assign Sarah Lin. They need the south wall repainted.",
];

// ─── Voice parser (mock AI) ───────────────────────────────────────────────────
function parseVoice(input: string): ParsedJob {
  const t = input.toLowerCase();

  const matchedCustomer = customers.find(c =>
    t.includes(c.name.toLowerCase()) ||
    t.includes(c.name.split(' ')[0].toLowerCase()) ||
    t.includes((c.name.split(' ')[1] ?? '').toLowerCase())
  );

  const serviceType: ServiceType | null =
    /hvac|ac |condenser|heat|cool|furnace|duct|thermostat|refrigerant/.test(t) ? 'HVAC' :
    /plumb|drain|pipe|water heater|faucet|toilet|leak|sewer/.test(t) ? 'Plumbing' :
    /paint|primer|wall|exterior|interior|stain/.test(t) ? 'Painting' : null;

  const priority: 'Normal' | 'Urgent' =
    /urgent|asap|emergency|immediately|right away|burst|flood/.test(t) ? 'Urgent' : 'Normal';

  const scheduledDate =
    /today|this (morning|afternoon|evening)/.test(t) ? 'Today' :
    /tomorrow/.test(t)  ? 'Tomorrow' :
    /monday/.test(t)    ? 'Mon Mar 16' :
    /tuesday/.test(t)   ? 'Tue Mar 11' :
    /wednesday/.test(t) ? 'Wed Mar 12' :
    /thursday/.test(t)  ? 'Thu Mar 13' :
    /friday/.test(t)    ? 'Fri Mar 14' : '';

  const timeMatch = t.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)/);
  const scheduledTime = timeMatch
    ? `${timeMatch[1]}:${timeMatch[2] ?? '00'} ${timeMatch[3].toUpperCase()}`
    : '';

  const matchedTech = technicians.find(tech =>
    t.includes(tech.name.toLowerCase()) ||
    t.includes(tech.name.split(' ')[0].toLowerCase())
  );

  // Strip names from description
  let desc = input;
  if (matchedCustomer) desc = desc.replace(new RegExp(matchedCustomer.name, 'gi'), '').trim();
  if (matchedTech)     desc = desc.replace(new RegExp(matchedTech.name, 'gi'), '').trim();
  desc = desc
    .replace(/^(schedule|create|new|book|add)\s*(a\s*)?(job|service|appointment)?\s*(for|with)?\s*/i, '')
    .replace(/(today|tomorrow|monday|tuesday|wednesday|thursday|friday)/gi, '')
    .replace(/at \d{1,2}(?::\d{2})?\s*(?:am|pm)/gi, '')
    .replace(/assign\s+to\s+\w+\s+\w+/gi, '')
    .replace(/get\s+\w+\s+\w+\s+on\s+it/gi, '')
    .replace(/right away|immediately|asap/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

  const primaryLoc = matchedCustomer?.locations[0];

  return {
    customerId:    matchedCustomer?.id    ?? null,
    locationId:    primaryLoc?.id         ?? null,
    customerName:  matchedCustomer?.name  ?? '',
    address:       primaryLoc?.address    ?? matchedCustomer?.address ?? '',
    serviceType:   serviceType ?? matchedCustomer?.serviceType ?? null,
    description:   desc.length > 6 ? desc : '',
    priority,
    scheduledDate,
    scheduledTime,
    assignedTech:  matchedTech?.name ?? '',
    notes:         '',
  };
}

// ─── Waveform ─────────────────────────────────────────────────────────────────
function Waveform({ active }: { active: boolean }) {
  return (
    <div className="flex items-center justify-center gap-[3px] h-7">
      {Array.from({ length: 20 }).map((_, i) => (
        <div key={i}
          className={`w-[3px] rounded-full ${active ? 'bg-red-400' : 'bg-slate-300'}`}
          style={{
            animation: active ? 'wBar 0.7s ease-in-out infinite' : 'none',
            animationDelay: `${i * 0.04}s`, height: '100%',
          }}
        />
      ))}
      <style>{`@keyframes wBar { 0%,100%{transform:scaleY(0.12)} 50%{transform:scaleY(1)} }`}</style>
    </div>
  );
}

// ─── Parsed result review card ────────────────────────────────────────────────
function ParsedReviewCard({
  parsed, onEdit,
}: { parsed: ParsedJob; onEdit: (field: string, val: string) => void }) {
  const [expandNotes, setExpandNotes] = useState(false);

  const rows: { icon: typeof Mic; label: string; value: string; field: string; empty?: boolean }[] = [
    {
      icon: User, label: 'Customer',
      value: parsed.customerName || '—',
      field: 'customerName',
      empty: !parsed.customerName,
    },
    {
      icon: Zap, label: 'Service',
      value: parsed.serviceType ? `${SVC_ICON[parsed.serviceType]} ${parsed.serviceType}` : '—',
      field: 'serviceType',
      empty: !parsed.serviceType,
    },
    {
      icon: ClipboardList, label: 'Description',
      value: parsed.description || '—',
      field: 'description',
      empty: !parsed.description,
    },
    {
      icon: Calendar, label: 'Date',
      value: parsed.scheduledDate || 'Unscheduled',
      field: 'scheduledDate',
    },
    {
      icon: Clock, label: 'Time',
      value: parsed.scheduledTime || '—',
      field: 'scheduledTime',
      empty: !parsed.scheduledTime,
    },
    {
      icon: User, label: 'Technician',
      value: parsed.assignedTech || 'Unassigned',
      field: 'assignedTech',
    },
  ];

  return (
    <div className="rounded-2xl border border-slate-200 overflow-hidden bg-white"
      style={{ animation: 'fadeUp 0.25s ease' }}>
      {/* AI header */}
      <div className="flex items-center gap-2.5 px-4 py-3 bg-indigo-50 border-b border-indigo-100">
        <div className="flex size-6 items-center justify-center rounded-full bg-indigo-600 shrink-0">
          <Sparkles size={11} className="text-white" />
        </div>
        <p className="text-sm text-indigo-800">Fieldly AI · Job parsed from voice</p>
        {parsed.priority === 'Urgent' && (
          <span className="ml-auto flex items-center gap-1 text-xs bg-red-100 text-red-600 border border-red-200 rounded-full px-2 py-0.5">
            <AlertCircle size={10} /> Urgent
          </span>
        )}
      </div>

      <div className="divide-y divide-slate-50">
        {rows.map(({ icon: Icon, label, value, field, empty }) => (
          <div key={field} className="flex items-start gap-3 px-4 py-3">
            <Icon size={14} className={`mt-0.5 shrink-0 ${empty ? 'text-amber-400' : 'text-slate-400'}`} />
            <div className="flex-1 min-w-0">
              <p className="text-xs text-slate-400 mb-0.5">{label}</p>
              <p className={`text-sm leading-snug ${empty ? 'text-amber-500 italic' : 'text-slate-800'}`}>
                {value}
              </p>
            </div>
            {empty && (
              <span className="text-xs text-amber-500 shrink-0 mt-0.5">needs input</span>
            )}
          </div>
        ))}
      </div>

      {parsed.address && (
        <div className="flex items-start gap-3 px-4 py-2.5 border-t border-slate-50 bg-slate-50/50">
          <MapPin size={13} className="text-slate-400 mt-0.5 shrink-0" />
          <p className="text-xs text-slate-500">{parsed.address}</p>
        </div>
      )}
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────
export function NewJobFlow({
  onClose, onCreated, onOpenEstimate,
  preSelectedCustomerId,
}: {
  onClose:          () => void;
  onCreated:        () => void;
  onOpenEstimate?:  () => void;
  preSelectedCustomerId?: string;
}) {
  const preCustomer  = customers.find(c => c.id === preSelectedCustomerId);
  const initialLocId = preCustomer?.locations.length === 1
    ? preCustomer.locations[0].id : null;

  const [step,     setStep]     = useState<FlowStep>('start');
  const [draft,    setDraft]    = useState<JobDraft>({
    ...BLANK,
    customerId:  preSelectedCustomerId ?? null,
    locationId:  initialLocId,
    serviceType: preCustomer?.serviceType ?? null,
  });
  const [parsed,   setParsed]   = useState<ParsedJob | null>(null);
  const [search,   setSearch]   = useState('');
  const [creating, setCreating] = useState(false);
  const [jobNum,   setJobNum]   = useState('');

  // Voice state
  const [vPhase,      setVPhase]      = useState<VoicePhase>('idle');
  const [vSeconds,    setVSeconds]    = useState(0);
  const [vTranscript, setVTranscript] = useState('');
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (vPhase !== 'recording') return;
    timerRef.current = setInterval(() => setVSeconds(s => s + 1), 1000);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [vPhase]);
  useEffect(() => { if (vPhase === 'recording' && vSeconds >= 9) stopRecording(); }, [vSeconds, vPhase]);

  function startRecording() { setVPhase('recording'); setVSeconds(0); }
  function stopRecording() {
    if (timerRef.current) clearInterval(timerRef.current);
    setVPhase('processing');
    const sample = VOICE_SAMPLES[Math.floor(Math.random() * VOICE_SAMPLES.length)];
    setTimeout(() => { setVTranscript(sample); setVPhase('parsed'); }, 1800);
  }
  function buildFromVoice() {
    const result = parseVoice(vTranscript);
    setParsed(result);
    setDraft(d => ({
      ...d,
      customerId:    result.customerId,
      locationId:    result.locationId,
      serviceType:   result.serviceType,
      description:   result.description,
      priority:      result.priority,
      scheduledDate: result.scheduledDate,
      scheduledTime: result.scheduledTime,
      assignedTech:  result.assignedTech,
    }));
    setVPhase('confirmed');
  }

  // Derived
  const customer   = customers.find(c => c.id === draft.customerId);
  const multiLoc   = (customer?.locations.length ?? 0) > 1;
  const location   = customer?.locations.find(l => l.id === draft.locationId);
  const primaryLoc = customer?.locations.find(l => l.isPrimary) ?? customer?.locations[0];
  const address    = (draft.locationId ? location?.address : primaryLoc?.address) ?? customer?.address ?? '';
  const tech       = technicians.find(t => t.name === draft.assignedTech);

  const filteredCustomers = search
    ? customers.filter(c =>
        c.name.toLowerCase().includes(search.toLowerCase()) ||
        c.phone.includes(search) ||
        c.address.toLowerCase().includes(search.toLowerCase()))
    : customers;

  function selectCustomer(id: string) {
    const c = customers.find(c => c.id === id);
    setDraft(d => ({
      ...d,
      customerId:  id,
      locationId:  (c?.locations.length ?? 0) <= 1 ? (c?.locations[0]?.id ?? null) : null,
      serviceType: d.serviceType ?? c?.serviceType ?? null,
    }));
  }

  function setField<K extends keyof JobDraft>(k: K, v: JobDraft[K]) {
    setDraft(d => ({ ...d, [k]: v }));
  }

  function createJob() {
    setCreating(true);
    const num = `10${50 + Math.floor(Math.random() * 9)}`;
    setJobNum(num);
    setTimeout(() => { setCreating(false); setStep('done'); }, 1400);
  }

  const canCreate = !!draft.customerId && !!draft.serviceType && !!draft.description.trim();

  // Step labels
  const STEP_DOTS: FlowStep[] = ['customer', 'details', 'schedule'];
  const dotIdx = STEP_DOTS.indexOf(step);

  function goBack() {
    if (step === 'schedule') { setStep('details');  return; }
    if (step === 'details')  { setStep('customer'); return; }
    if (step === 'customer') { setStep('start');    return; }
    if (step === 'voice')    { setStep('start');    return; }
  }

  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

  // ── Date quick-picks ──
  const DATE_CHIPS = [
    { label: 'Today',     value: 'Today'       },
    { label: 'Tomorrow',  value: 'Tomorrow'    },
    { label: 'Tue 11',    value: 'Tue Mar 11'  },
    { label: 'Wed 12',    value: 'Wed Mar 12'  },
    { label: 'Thu 13',    value: 'Thu Mar 13'  },
    { label: 'Fri 14',    value: 'Fri Mar 14'  },
    { label: 'Later',     value: '__custom'    },
  ];
  const [customDate, setCustomDate] = useState('');

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-black/50 md:items-center md:justify-center"
      onClick={onClose}
    >
      <div
        className="mt-auto md:mt-0 bg-white rounded-t-3xl md:rounded-2xl w-full md:max-w-lg max-h-[94vh] overflow-hidden flex flex-col shadow-2xl"
        style={{ animation: 'jobUp 0.28s cubic-bezier(0.32,0.72,0,1)' }}
        onClick={e => e.stopPropagation()}
      >

        {/* ── Handle (mobile) ── */}
        <div className="flex justify-center pt-3 pb-0 shrink-0 md:hidden">
          <div className="w-9 h-1 rounded-full bg-slate-200" />
        </div>

        {/* ── Header ── */}
        <div className="flex items-center gap-3 px-5 py-3.5 border-b border-slate-100 shrink-0">
          {step !== 'start' && step !== 'done' && (
            <button onClick={goBack} className="text-slate-400 hover:text-slate-600 transition-colors -ml-1">
              <ArrowLeft size={16} />
            </button>
          )}
          {['customer','details','schedule'].includes(step) && dotIdx >= 0 && (
            <div className="flex gap-1.5">
              {STEP_DOTS.map((_, i) => (
                <div key={i} className={`rounded-full transition-all duration-200 ${
                  i < dotIdx  ? 'w-2 h-2 bg-blue-400' :
                  i === dotIdx ? 'w-5 h-2 bg-slate-900' : 'w-2 h-2 bg-slate-200'
                }`} />
              ))}
            </div>
          )}
          <p className="text-sm text-slate-600 flex-1">
            {step === 'start'    ? 'New job' :
             step === 'voice'    ? 'New job · Voice' :
             step === 'customer' ? 'Customer' :
             step === 'details'  ? 'Job details' :
             step === 'schedule' ? 'Schedule & assign' : 'Job created'}
          </p>
          {step !== 'done' && (
            <button onClick={onClose} className="flex size-7 items-center justify-center rounded-full hover:bg-slate-100 transition-colors">
              <X size={15} className="text-slate-500" />
            </button>
          )}
        </div>

        {/* ── Body ── */}
        <div className="flex-1 overflow-y-auto">

          {/* ══ START ══ */}
          {step === 'start' && (
            <div className="p-5 flex flex-col gap-3">
              {/* Customer chip if pre-selected */}
              {preSelectedCustomerId && customer && (
                <div className="flex items-center gap-2.5 rounded-xl bg-green-50 border border-green-200 px-3.5 py-2.5">
                  <div className="flex size-7 items-center justify-center rounded-full bg-green-100 shrink-0">
                    <Check size={12} className="text-green-600" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-slate-800">{customer.name}</p>
                    <p className="text-xs text-slate-400 truncate">{address || customer.address}</p>
                  </div>
                </div>
              )}

              <p className="text-sm text-slate-500 mb-1">How would you like to create this job?</p>

              {/* Speak it */}
              <button
                onClick={() => setStep('voice')}
                className="flex items-start gap-4 rounded-2xl border-2 border-slate-200 bg-white px-5 py-4 text-left hover:border-indigo-300 hover:shadow-sm active:bg-slate-50 transition-all group"
              >
                <div className="flex size-11 items-center justify-center rounded-2xl bg-slate-900 shrink-0 group-hover:bg-indigo-600 transition-colors">
                  <Mic size={20} className="text-white" />
                </div>
                <div>
                  <p className="text-slate-900">Speak it</p>
                  <p className="text-xs text-slate-400 mt-1 leading-relaxed">
                    Say the customer, service, date, and tech — AI fills in the whole job from your voice.
                  </p>
                </div>
              </button>

              {/* Fill it in */}
              <button
                onClick={() => setStep(preSelectedCustomerId ? 'details' : 'customer')}
                className="flex items-start gap-4 rounded-2xl border-2 border-slate-200 bg-white px-5 py-4 text-left hover:border-blue-300 hover:shadow-sm active:bg-slate-50 transition-all group"
              >
                <div className="flex size-11 items-center justify-center rounded-2xl bg-slate-100 shrink-0 group-hover:bg-blue-50 transition-colors">
                  <ClipboardList size={20} className="text-slate-600 group-hover:text-blue-600 transition-colors" />
                </div>
                <div>
                  <p className="text-slate-900">Fill it in</p>
                  <p className="text-xs text-slate-400 mt-1 leading-relaxed">
                    Step through customer, details, and scheduling — best for complex or custom jobs.
                  </p>
                </div>
              </button>
            </div>
          )}

          {/* ══ VOICE ══ */}
          {step === 'voice' && (
            <div className="p-5 flex flex-col gap-4">

              {/* Idle */}
              {vPhase === 'idle' && (
                <div className="flex flex-col items-center gap-5 py-6">
                  <p className="text-sm text-slate-500 text-center leading-relaxed px-2">
                    Say the customer name, service type, what needs to be done, when, and who to assign.
                  </p>
                  <div className="text-xs text-slate-400 bg-slate-50 rounded-xl px-4 py-3 w-full leading-relaxed">
                    <span className="text-slate-600">Try: </span>
                    "Schedule an HVAC job for Maria Garcia tomorrow at 2pm, assign Carlos Reyes — AC not cooling."
                  </div>
                  <button onClick={startRecording} className="group flex flex-col items-center gap-3">
                    <div className="relative flex size-20 items-center justify-center rounded-full bg-slate-900 shadow-xl shadow-slate-900/20 hover:bg-slate-700 active:scale-95 transition-all">
                      <Mic size={28} className="text-white" />
                      <div className="absolute inset-0 rounded-full border-2 border-slate-900/20 scale-110 group-hover:scale-125 transition-transform" />
                    </div>
                    <p className="text-sm text-slate-700">Tap to start</p>
                  </button>
                </div>
              )}

              {/* Recording */}
              {vPhase === 'recording' && (
                <div className="flex flex-col items-center gap-4 py-6">
                  <div className="flex items-center gap-2">
                    <span className="size-2 rounded-full bg-red-500 animate-pulse" />
                    <p className="text-sm text-red-600">{fmt(vSeconds)} · Recording…</p>
                  </div>
                  <Waveform active />
                  <button onClick={stopRecording}
                    className="flex items-center gap-2 rounded-xl bg-red-500 text-white px-6 py-3 text-sm hover:bg-red-600 active:scale-95 transition-all shadow-lg shadow-red-500/30">
                    <StopCircle size={16} /> Tap to stop
                  </button>
                  <p className="text-xs text-slate-400">Auto-stops at 10s</p>
                </div>
              )}

              {/* Processing */}
              {vPhase === 'processing' && (
                <div className="flex flex-col items-center gap-4 py-14">
                  <Waveform active={false} />
                  <div className="flex items-center gap-2 text-sm text-slate-500">
                    <span className="size-4 rounded-full border-2 border-slate-200 border-t-slate-600 animate-spin" />
                    Transcribing…
                  </div>
                </div>
              )}

              {/* Parsed transcript → review */}
              {(vPhase === 'parsed' || vPhase === 'confirmed') && (
                <div className="flex flex-col gap-4" style={{ animation: 'fadeUp 0.2s ease' }}>
                  {/* Transcript bubble */}
                  <div className="flex items-start gap-2.5">
                    <div className="flex size-7 items-center justify-center rounded-full bg-slate-900 shrink-0 mt-0.5">
                      <Mic size={12} className="text-white" />
                    </div>
                    <div className="flex-1 bg-slate-100 rounded-2xl rounded-tl-sm px-4 py-3">
                      <p className="text-xs text-slate-400 mb-1">Your recording</p>
                      <p className="text-sm text-slate-800 leading-relaxed italic">"{vTranscript}"</p>
                    </div>
                  </div>

                  {vPhase === 'parsed' && (
                    <div className="flex gap-2">
                      <button onClick={() => { setVPhase('idle'); setVTranscript(''); }}
                        className="flex items-center gap-1.5 rounded-xl border border-slate-200 px-3 py-2.5 text-sm text-slate-600 hover:bg-slate-50 transition-colors">
                        <RotateCcw size={13} /> Re-record
                      </button>
                      <button onClick={buildFromVoice}
                        className="flex-1 flex items-center justify-center gap-1.5 rounded-xl bg-indigo-600 text-white py-2.5 text-sm hover:bg-indigo-700 transition-colors">
                        <Sparkles size={14} /> Parse this job
                      </button>
                    </div>
                  )}

                  {vPhase === 'confirmed' && parsed && (
                    <>
                      <ParsedReviewCard parsed={parsed} onEdit={() => {}} />
                      <button onClick={() => { setVPhase('idle'); setVTranscript(''); setParsed(null); }}
                        className="flex items-center justify-center gap-1.5 text-xs text-slate-400 hover:text-slate-600 transition-colors">
                        <RotateCcw size={11} /> Re-record
                      </button>
                    </>
                  )}
                </div>
              )}
            </div>
          )}

          {/* ══ CUSTOMER ══ */}
          {step === 'customer' && (
            <div className="p-5 flex flex-col gap-4">
              <div className="flex items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3.5 py-2.5">
                <Search size={14} className="text-slate-400 shrink-0" />
                <input
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  placeholder="Search customers…"
                  autoFocus
                  className="flex-1 bg-transparent text-sm text-slate-700 placeholder-slate-400 outline-none"
                />
                {search && (
                  <button onClick={() => setSearch('')}><X size={12} className="text-slate-300" /></button>
                )}
              </div>

              <div className="flex flex-col gap-2">
                {filteredCustomers.map(c => {
                  const sel = draft.customerId === c.id;
                  return (
                    <button key={c.id} onClick={() => selectCustomer(c.id)}
                      className={`flex items-center gap-3 rounded-xl px-4 py-3 text-left border transition-all ${
                        sel ? 'border-blue-300 bg-blue-50 shadow-sm' : 'border-slate-200 bg-white hover:border-slate-300'
                      }`}>
                      <span className="flex size-9 items-center justify-center rounded-full bg-slate-100 text-sm shrink-0 text-slate-600">
                        {c.name.split(' ').map(n => n[0]).join('')}
                      </span>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="text-sm text-slate-900">{c.name}</p>
                          {c.tags?.includes('VIP') && (
                            <span className="text-xs bg-amber-100 text-amber-600 rounded-full px-2 py-0.5">VIP</span>
                          )}
                          {c.openJobs > 0 && (
                            <span className="text-xs bg-blue-50 text-blue-600 rounded-full px-2 py-0.5">{c.openJobs} open</span>
                          )}
                        </div>
                        <p className="text-xs text-slate-400 mt-0.5 truncate">
                          {c.locations.length > 1 ? `${c.locations.length} locations` : c.address}
                        </p>
                      </div>
                      {sel ? <Check size={15} className="text-blue-600 shrink-0" /> : <ChevronRight size={14} className="text-slate-300 shrink-0" />}
                    </button>
                  );
                })}
              </div>

              {/* Location picker for multi-location customers */}
              {draft.customerId && multiLoc && (
                <div className="flex flex-col gap-2 pt-2 border-t border-slate-100">
                  <p className="text-xs text-slate-500">Service location</p>
                  {customer?.locations.map(loc => (
                    <button key={loc.id} onClick={() => setField('locationId', loc.id)}
                      className={`flex items-center gap-3 rounded-xl px-4 py-3 text-left border transition-all ${
                        draft.locationId === loc.id ? 'border-blue-300 bg-blue-50' : 'border-slate-200 bg-white hover:border-slate-300'
                      }`}>
                      <MapPin size={14} className={draft.locationId === loc.id ? 'text-blue-500 shrink-0' : 'text-slate-400 shrink-0'} />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm text-slate-800">{loc.nickname}</p>
                        <p className="text-xs text-slate-400 mt-0.5 truncate">{loc.address}</p>
                      </div>
                      {draft.locationId === loc.id && <Check size={14} className="text-blue-600 shrink-0" />}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ══ DETAILS ══ */}
          {step === 'details' && (
            <div className="p-5 flex flex-col gap-4">
              {/* Customer chip */}
              {customer && (
                <div className="flex items-center gap-2.5 rounded-xl bg-slate-50 border border-slate-200 px-3.5 py-2.5">
                  <span className="flex size-7 items-center justify-center rounded-full bg-slate-800 text-white text-xs shrink-0">
                    {customer.name.split(' ').map(n => n[0]).join('')}
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-slate-800">{customer.name}</p>
                    <p className="text-xs text-slate-400 truncate">{address}</p>
                  </div>
                  {!preSelectedCustomerId && (
                    <button onClick={() => setStep('customer')}
                      className="text-xs text-blue-600 hover:underline shrink-0">Change</button>
                  )}
                </div>
              )}

              {/* Service type */}
              <div>
                <p className="text-xs text-slate-500 mb-2">Service type *</p>
                <div className="flex gap-2">
                  {(['HVAC', 'Plumbing', 'Painting'] as ServiceType[]).map(s => (
                    <button key={s} onClick={() => setField('serviceType', s)}
                      className={`flex-1 flex items-center justify-center gap-1.5 rounded-full border py-2.5 text-sm transition-all ${
                        draft.serviceType === s
                          ? `${SVC_CHIP[s]} shadow-sm`
                          : 'border-slate-200 text-slate-500 hover:border-slate-300 bg-white'
                      }`}>
                      {SVC_ICON[s]} {s}
                    </button>
                  ))}
                </div>
              </div>

              {/* Description */}
              <div>
                <p className="text-xs text-slate-500 mb-2">What needs to be done? *</p>
                <textarea
                  value={draft.description}
                  onChange={e => setField('description', e.target.value)}
                  placeholder="Describe the issue or scope of work…"
                  rows={4}
                  autoFocus={!draft.description}
                  className="w-full rounded-xl border border-slate-200 px-4 py-3 text-sm text-slate-700 placeholder-slate-400 focus:outline-none focus:border-blue-400 transition-colors resize-none leading-relaxed"
                />
              </div>

              {/* Priority */}
              <div>
                <p className="text-xs text-slate-500 mb-2">Priority</p>
                <div className="flex gap-2">
                  {(['Normal', 'Urgent'] as const).map(p => (
                    <button key={p} onClick={() => setField('priority', p)}
                      className={`flex items-center gap-1.5 rounded-full border px-4 py-2 text-sm transition-all ${
                        draft.priority === p
                          ? p === 'Urgent'
                            ? 'bg-red-500 border-red-500 text-white shadow-sm'
                            : 'bg-slate-900 border-slate-900 text-white'
                          : 'border-slate-200 text-slate-500 hover:border-slate-300 bg-white'
                      }`}>
                      {p === 'Urgent' && <AlertCircle size={13} />}
                      {p}
                    </button>
                  ))}
                </div>
              </div>

              {/* Notes (optional) */}
              <div>
                <p className="text-xs text-slate-500 mb-2">Internal notes <span className="text-slate-400">(optional)</span></p>
                <input
                  value={draft.notes}
                  onChange={e => setField('notes', e.target.value)}
                  placeholder="Gate code, access instructions, customer preferences…"
                  className="w-full rounded-xl border border-slate-200 px-4 py-3 text-sm focus:outline-none focus:border-blue-400 transition-colors"
                />
              </div>
            </div>
          )}

          {/* ══ SCHEDULE ══ */}
          {step === 'schedule' && (
            <div className="p-5 flex flex-col gap-5">

              {/* Job summary chip */}
              <div className="flex items-center gap-2.5 rounded-xl bg-slate-50 border border-slate-200 px-3.5 py-2.5">
                <span className="text-base">{draft.serviceType ? SVC_ICON[draft.serviceType] : '🔧'}</span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-slate-800 truncate">{draft.description || 'No description'}</p>
                  <p className="text-xs text-slate-400">{customer?.name} · {draft.serviceType}</p>
                </div>
                {draft.priority === 'Urgent' && (
                  <span className="flex items-center gap-1 text-xs bg-red-100 text-red-600 rounded-full px-2 py-0.5 shrink-0">
                    <AlertCircle size={10} /> Urgent
                  </span>
                )}
              </div>

              {/* Date */}
              <div>
                <p className="text-xs text-slate-500 mb-2.5">When?</p>
                <div className="flex flex-wrap gap-2">
                  {DATE_CHIPS.map(chip => {
                    const isCustom  = chip.value === '__custom';
                    const isSelected = isCustom
                      ? !DATE_CHIPS.slice(0,-1).some(c => c.value === draft.scheduledDate) && !!draft.scheduledDate
                      : draft.scheduledDate === chip.value;
                    return (
                      <button key={chip.value}
                        onClick={() => {
                          if (isCustom) setField('scheduledDate', customDate || 'Custom');
                          else setField('scheduledDate', chip.value);
                        }}
                        className={`rounded-full border px-3.5 py-2 text-sm transition-all ${
                          isSelected
                            ? 'bg-slate-900 border-slate-900 text-white shadow-sm'
                            : 'border-slate-200 text-slate-600 bg-white hover:border-slate-400'
                        }`}>
                        {isCustom ? '📅 Pick date' : chip.label}
                      </button>
                    );
                  })}
                  <button
                    onClick={() => setField('scheduledDate', '')}
                    className={`rounded-full border px-3.5 py-2 text-sm transition-all ${
                      draft.scheduledDate === ''
                        ? 'bg-slate-100 border-slate-300 text-slate-700'
                        : 'border-slate-200 text-slate-400 bg-white hover:border-slate-300'
                    }`}>
                    Unscheduled
                  </button>
                </div>

                {/* Custom date input */}
                {draft.scheduledDate === 'Custom' || draft.scheduledDate === '__custom' ? (
                  <input
                    type="date"
                    value={customDate}
                    onChange={e => { setCustomDate(e.target.value); setField('scheduledDate', e.target.value); }}
                    className="mt-2.5 w-full rounded-xl border border-slate-200 px-4 py-3 text-sm focus:outline-none focus:border-blue-400 transition-colors"
                  />
                ) : null}
              </div>

              {/* Time */}
              {draft.scheduledDate && draft.scheduledDate !== '' && (
                <div style={{ animation: 'fadeUp 0.15s ease' }}>
                  <p className="text-xs text-slate-500 mb-2.5">What time?</p>
                  <div className="flex flex-wrap gap-2">
                    {['8:00 AM','9:00 AM','10:00 AM','11:00 AM','1:00 PM','2:00 PM','3:00 PM','4:00 PM'].map(t => (
                      <button key={t} onClick={() => setField('scheduledTime', draft.scheduledTime === t ? '' : t)}
                        className={`rounded-full border px-3 py-2 text-sm transition-all ${
                          draft.scheduledTime === t
                            ? 'bg-slate-900 border-slate-900 text-white'
                            : 'border-slate-200 text-slate-600 bg-white hover:border-slate-400'
                        }`}>
                        {t}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Tech assignment */}
              <div>
                <p className="text-xs text-slate-500 mb-2.5">Assign technician</p>
                <div className="flex flex-col gap-2">
                  {/* Unassigned */}
                  <button onClick={() => setField('assignedTech', '')}
                    className={`flex items-center gap-3 rounded-xl border px-4 py-3 text-left transition-all ${
                      draft.assignedTech === ''
                        ? 'border-slate-300 bg-slate-50 shadow-sm'
                        : 'border-slate-200 bg-white hover:border-slate-300'
                    }`}>
                    <div className="flex size-9 items-center justify-center rounded-full bg-slate-200 shrink-0">
                      <User size={16} className="text-slate-500" />
                    </div>
                    <p className="flex-1 text-sm text-slate-600">Unassigned</p>
                    {draft.assignedTech === '' && <Check size={14} className="text-slate-700 shrink-0" />}
                  </button>

                  {technicians.map(t => (
                    <button key={t.id} onClick={() => setField('assignedTech', t.name)}
                      className={`flex items-center gap-3 rounded-xl border px-4 py-3 text-left transition-all ${
                        draft.assignedTech === t.name
                          ? 'border-blue-300 bg-blue-50 shadow-sm'
                          : 'border-slate-200 bg-white hover:border-slate-300'
                      }`}>
                      <div
                        className="flex size-9 items-center justify-center rounded-full text-white text-xs shrink-0"
                        style={{ background: t.color }}
                      >
                        {t.initials}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm text-slate-800">{t.name}</p>
                        <p className="text-xs text-slate-400 mt-0.5">{t.activeJobs} active job{t.activeJobs !== 1 ? 's' : ''}</p>
                      </div>
                      {draft.assignedTech === t.name && <Check size={14} className="text-blue-600 shrink-0" />}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* ══ DONE ══ */}
          {step === 'done' && (
            <div className="p-5 flex flex-col gap-5" style={{ animation: 'fadeUp 0.25s ease' }}>
              {/* Success */}
              <div className="flex flex-col items-center gap-3 pt-3 text-center">
                <div className="flex size-16 items-center justify-center rounded-full bg-green-100">
                  <Check size={28} className="text-green-600" />
                </div>
                <div>
                  <p className="text-slate-900" style={{ fontSize: '1.05rem' }}>Job #{jobNum} created</p>
                  <p className="text-sm text-slate-400 mt-0.5">{customer?.name}</p>
                </div>
              </div>

              {/* Summary card */}
              <div className="rounded-2xl border border-slate-200 overflow-hidden bg-white">
                <div className="px-4 py-3 bg-slate-900">
                  <div className="flex items-center justify-between">
                    <p className="text-sm text-white">{draft.serviceType ? `${SVC_ICON[draft.serviceType]} ${draft.serviceType}` : '🔧 Service'}</p>
                    <span className="text-xs text-slate-400">#{jobNum}</span>
                  </div>
                  <p className="text-xs text-slate-400 mt-1.5 leading-relaxed">{draft.description}</p>
                </div>
                <div className="divide-y divide-slate-50">
                  <div className="flex items-center gap-3 px-4 py-2.5">
                    <User size={13} className="text-slate-400 shrink-0" />
                    <p className="text-xs text-slate-500">Customer</p>
                    <p className="text-sm text-slate-800 ml-auto">{customer?.name}</p>
                  </div>
                  <div className="flex items-center gap-3 px-4 py-2.5">
                    <MapPin size={13} className="text-slate-400 shrink-0" />
                    <p className="text-xs text-slate-500 flex-1 truncate">{address || customer?.address}</p>
                  </div>
                  <div className="flex items-center gap-3 px-4 py-2.5">
                    <Calendar size={13} className="text-slate-400 shrink-0" />
                    <p className="text-xs text-slate-500">Date</p>
                    <p className="text-sm text-slate-800 ml-auto">
                      {draft.scheduledDate
                        ? `${draft.scheduledDate}${draft.scheduledTime ? ` · ${draft.scheduledTime}` : ''}`
                        : 'Unscheduled'}
                    </p>
                  </div>
                  <div className="flex items-center gap-3 px-4 py-2.5">
                    <User size={13} className="text-slate-400 shrink-0" />
                    <p className="text-xs text-slate-500">Technician</p>
                    <div className="ml-auto flex items-center gap-1.5">
                      {tech ? (
                        <>
                          <span className="flex size-5 items-center justify-center rounded-full text-white" style={{ fontSize: 8, background: tech.color }}>{tech.initials}</span>
                          <p className="text-sm text-slate-800">{tech.name.split(' ')[0]}</p>
                        </>
                      ) : (
                        <p className="text-sm text-slate-400">Unassigned</p>
                      )}
                    </div>
                  </div>
                  {draft.priority === 'Urgent' && (
                    <div className="flex items-center gap-3 px-4 py-2.5 bg-red-50">
                      <AlertCircle size={13} className="text-red-500 shrink-0" />
                      <p className="text-sm text-red-600">Marked urgent</p>
                    </div>
                  )}
                </div>
              </div>

              {/* Next actions */}
              <div>
                <p className="text-xs text-slate-400 text-center mb-3">What would you like to do next?</p>
                <div className="grid grid-cols-2 gap-3">
                  <button
                    onClick={() => { onCreated(); onClose(); }}
                    className="flex flex-col items-center gap-2.5 rounded-2xl border-2 border-slate-200 bg-white py-4 px-3 hover:border-blue-300 hover:bg-blue-50/60 active:scale-[0.97] transition-all group"
                  >
                    <div className="flex size-11 items-center justify-center rounded-xl bg-blue-100 group-hover:bg-blue-200 transition-colors">
                      <ClipboardList size={20} className="text-blue-600" />
                    </div>
                    <div className="text-center">
                      <p className="text-sm text-slate-800">View job</p>
                      <p className="text-xs text-slate-400 mt-0.5">Open detail</p>
                    </div>
                  </button>

                  {onOpenEstimate ? (
                    <button
                      onClick={() => { onCreated(); onOpenEstimate(); }}
                      className="flex flex-col items-center gap-2.5 rounded-2xl border-2 border-slate-200 bg-white py-4 px-3 hover:border-indigo-300 hover:bg-indigo-50/60 active:scale-[0.97] transition-all group"
                    >
                      <div className="flex size-11 items-center justify-center rounded-xl bg-indigo-100 group-hover:bg-indigo-200 transition-colors">
                        <FileText size={20} className="text-indigo-600" />
                      </div>
                      <div className="text-center">
                        <p className="text-sm text-slate-800">Add estimate</p>
                        <p className="text-xs text-slate-400 mt-0.5">Build a quote</p>
                      </div>
                    </button>
                  ) : (
                    <button
                      onClick={() => { onCreated(); onClose(); }}
                      className="flex flex-col items-center gap-2.5 rounded-2xl border-2 border-slate-200 bg-white py-4 px-3 hover:border-green-300 hover:bg-green-50/60 active:scale-[0.97] transition-all group"
                    >
                      <div className="flex size-11 items-center justify-center rounded-xl bg-green-100 group-hover:bg-green-200 transition-colors">
                        <Send size={20} className="text-green-600" />
                      </div>
                      <div className="text-center">
                        <p className="text-sm text-slate-800">Dispatch</p>
                        <p className="text-xs text-slate-400 mt-0.5">Notify tech</p>
                      </div>
                    </button>
                  )}
                </div>
              </div>

              <button onClick={onClose} className="text-sm text-slate-400 hover:text-slate-600 transition-colors text-center">
                Done for now
              </button>
            </div>
          )}

        </div>

        {/* ── Footer CTA ── */}
        {step === 'voice' && vPhase === 'confirmed' && parsed && (
          <div className="shrink-0 px-5 py-4 border-t border-slate-100 bg-white">
            <button
              onClick={createJob}
              disabled={!parsed.customerId || !parsed.serviceType || creating}
              className="flex items-center justify-center gap-2 w-full rounded-xl bg-slate-900 text-white py-3.5 text-sm disabled:opacity-40 hover:bg-slate-700 transition-colors"
            >
              {creating
                ? <><span className="size-4 rounded-full border-2 border-white/30 border-t-white animate-spin" /> Creating job…</>
                : <><Check size={14} /> Create job {parsed.scheduledDate ? `· ${parsed.scheduledDate}` : ''}</>
              }
            </button>
            {!parsed.customerId && (
              <p className="text-xs text-amber-600 text-center mt-2">Couldn't detect customer — use "Fill it in" for manual entry</p>
            )}
          </div>
        )}

        {step === 'customer' && (
          <div className="shrink-0 px-5 py-4 border-t border-slate-100 bg-white">
            <button
              onClick={() => setStep('details')}
              disabled={!draft.customerId || (multiLoc && !draft.locationId)}
              className="flex items-center justify-center gap-2 w-full rounded-xl bg-slate-900 text-white py-3.5 text-sm disabled:opacity-40 hover:bg-slate-700 transition-colors"
            >
              Next: Job details →
            </button>
          </div>
        )}

        {step === 'details' && (
          <div className="shrink-0 px-5 py-4 border-t border-slate-100 bg-white">
            <button
              onClick={() => setStep('schedule')}
              disabled={!draft.serviceType || !draft.description.trim()}
              className="flex items-center justify-center gap-2 w-full rounded-xl bg-slate-900 text-white py-3.5 text-sm disabled:opacity-40 hover:bg-slate-700 transition-colors"
            >
              Next: Schedule →
            </button>
          </div>
        )}

        {step === 'schedule' && (
          <div className="shrink-0 px-5 py-4 border-t border-slate-100 bg-white">
            <button
              onClick={createJob}
              disabled={creating || !canCreate}
              className="flex items-center justify-center gap-2 w-full rounded-xl bg-slate-900 text-white py-3.5 text-sm disabled:opacity-40 hover:bg-slate-700 transition-colors"
            >
              {creating
                ? <><span className="size-4 rounded-full border-2 border-white/30 border-t-white animate-spin" /> Creating job…</>
                : <>
                    <Check size={14} />
                    Create job{draft.scheduledDate
                      ? ` · ${draft.scheduledDate}${draft.assignedTech ? ` · ${draft.assignedTech.split(' ')[0]}` : ''}`
                      : ' (unscheduled)'}
                  </>
              }
            </button>
          </div>
        )}

      </div>

      <style>{`
        @keyframes jobUp  { from { transform:translateY(100%); opacity:0 } to { transform:translateY(0); opacity:1 } }
        @keyframes fadeUp { from { opacity:0; transform:translateY(6px) } to { opacity:1; transform:translateY(0) } }
      `}</style>
    </div>
  );
}

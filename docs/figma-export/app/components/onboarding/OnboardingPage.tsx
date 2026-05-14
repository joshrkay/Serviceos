import { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router';
import {
  Mic, Keyboard, Check, ArrowRight, Sparkles, ChevronRight,
  Zap, Clock, Receipt, AlertTriangle, MessageSquare, Eye, Camera,
  Building2, Users,
} from 'lucide-react';

// ─── Types ────────────────────────────────────────────────────────────────
interface Answers {
  name: string;
  businessName: string;
  services: string[];
  teamSize: string;
  workerTerm: string;
  jobTerm: string;
  estimateTerm: string;
}

interface Rule {
  id: string; title: string; desc: string;
  icon: string; enabled: boolean; services: string[];
}

// ─── Constants ────────────────────────────────────────────────────────────
const BLANK: Answers = {
  name: '', businessName: '', services: [],
  teamSize: '', workerTerm: '', jobTerm: '', estimateTerm: '',
};

const SERVICE_OPTIONS = [
  { value: 'HVAC',        label: 'HVAC',               emoji: '❄️' },
  { value: 'Plumbing',    label: 'Plumbing',           emoji: '🔧' },
  { value: 'Painting',    label: 'Painting',           emoji: '🎨' },
  { value: 'Electrical',  label: 'Electrical',         emoji: '⚡' },
  { value: 'Contracting', label: 'Contracting',        emoji: '🏠' },
  { value: 'Other',       label: 'Other',              emoji: '✦'  },
];
const TEAM_OPTIONS = [
  { value: 'Just me',     label: 'Just me',     sub: 'Solo operator'    },
  { value: '2–5 people',  label: '2–5 people',  sub: 'Small crew'       },
  { value: '6–15 people', label: '6–15 people', sub: 'Growing team'     },
  { value: '16+ people',  label: '16+ people',  sub: 'Larger operation' },
];
const WORKER_TERMS = [
  { value: 'Technicians', label: 'Technicians', sub: 'HVAC & trade service'    },
  { value: 'Crew',        label: 'Crew',        sub: 'Painting & construction' },
  { value: 'Installers',  label: 'Installers',  sub: 'HVAC equipment installs' },
  { value: 'Plumbers',    label: 'Plumbers',    sub: 'Plumbing-specific'       },
  { value: 'Painters',    label: 'Painters',    sub: 'Painting-specific'       },
  { value: 'Workers',     label: 'Workers',     sub: 'General term'            },
];
const JOB_TERMS = [
  { value: 'Jobs',          label: 'Jobs',          sub: 'Simple and universal'        },
  { value: 'Service calls', label: 'Service calls', sub: 'Common for HVAC & plumbing'  },
  { value: 'Work orders',   label: 'Work orders',   sub: 'Formal field service'        },
  { value: 'Projects',      label: 'Projects',      sub: 'Painting & construction'     },
  { value: 'Tickets',       label: 'Tickets',       sub: 'Tech-forward operations'     },
];
const ESTIMATE_TERMS = [
  { value: 'Estimates', label: 'Estimates', sub: 'Standard term'         },
  { value: 'Quotes',    label: 'Quotes',    sub: 'Quick and informal'    },
  { value: 'Proposals', label: 'Proposals', sub: 'Professional services' },
  { value: 'Bids',      label: 'Bids',      sub: 'Competitive projects'  },
];

const BASE_RULES: Rule[] = [
  { id: 'r1', icon: 'clock',   enabled: true,  services: [],
    title: 'Appointment reminders',
    desc:  'Auto-send an SMS reminder 2 hours before each job — no manual texting needed' },
  { id: 'r2', icon: 'receipt', enabled: true,  services: [],
    title: 'Auto-draft invoices',
    desc:  "When a job is marked complete, I'll prep an invoice draft ready for 1-tap review" },
  { id: 'r3', icon: 'alert',   enabled: true,  services: ['HVAC', 'Plumbing'],
    title: 'Smart urgent detection',
    desc:  'Flag as urgent when notes contain "emergency", "flood", "burst", "no heat", or similar' },
  { id: 'r4', icon: 'eye',     enabled: true,  services: [],
    title: 'Estimate follow-up nudge',
    desc:  "Remind you when an estimate hasn't been opened in 3 days — catch missed revenue" },
  { id: 'r5', icon: 'message', enabled: false, services: [],
    title: 'Post-job check-in text',
    desc:  "Draft a friendly check-in message for your approval 24 hours after each completed job" },
  { id: 'r6', icon: 'camera',  enabled: false, services: ['Painting', 'Plumbing'],
    title: 'Before/after photo prompt',
    desc:  'Remind techs to capture site photos before and after every job' },
];

const RULE_ICONS: Record<string, React.ElementType> = {
  clock: Clock, receipt: Receipt, alert: AlertTriangle,
  eye: Eye, message: MessageSquare, camera: Camera,
};

function rulesFor(services: string[]) {
  return BASE_RULES.filter(r => !r.services.length || r.services.some(s => services.includes(s)));
}

// ─── Step definitions ─────────────────────────────────────────────────────
// 0=name 1=business 2=services 3=teamSize 4=workerTerm 5=jobTerm 6=estimateTerm 7=rules 8=confirm
const TOTAL = 9;

function question(step: number, a: Answers): string {
  switch (step) {
    case 0: return "What's your first name?";
    case 1: return `Nice to meet you, ${a.name}!\n\nWhat's the name of your business?`;
    case 2: return `What kind of work does ${a.businessName || 'your business'} do?`;
    case 3: return "How big is your team?";
    case 4: return "What do you call the people doing the fieldwork?";
    case 5: return "What do you call the work itself?";
    case 6: return "What do you call pricing proposals to customers?";
    case 7: return "Here are the automations I'd turn on for you.\n\nToggle off anything that doesn't fit.";
    case 8: return "Here's your complete setup.\n\nDoes everything look right?";
    default: return '';
  }
}

function breadcrumb(step: number, a: Answers): string {
  const parts: string[] = [];
  if (step > 0 && a.name)              parts.push(a.name);
  if (step > 1 && a.businessName)      parts.push(a.businessName);
  if (step > 2 && a.services.length)   parts.push(a.services.join(', '));
  if (step > 3 && a.teamSize)          parts.push(a.teamSize);
  return parts.join(' · ');
}

// ─── Voice + Text input ────────────────────────────────────────────────────
function VoiceAnswer({
  onSubmit, placeholder, mockVoice,
}: { onSubmit: (v: string) => void; placeholder: string; mockVoice: string }) {
  const [phase, setPhase] = useState<'idle' | 'listening' | 'text'>('idle');
  const [val,   setVal]   = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  function tapMic() {
    setPhase('listening');
    setTimeout(() => {
      setVal(mockVoice);
      setPhase('text');
      setTimeout(() => inputRef.current?.focus(), 50);
    }, 2000);
  }

  function submit() {
    const v = val.trim();
    if (!v) return;
    onSubmit(v);
    setVal(''); setPhase('idle');
  }

  /* ── Idle: big mic + "type instead" link ── */
  if (phase === 'idle') return (
    <div className="flex flex-col items-center gap-5">
      <button
        onClick={tapMic}
        className="relative flex size-20 items-center justify-center rounded-full bg-indigo-600 hover:bg-indigo-500 active:scale-95 transition-all shadow-xl shadow-indigo-200"
      >
        <span className="absolute inset-0 rounded-full bg-indigo-400/30 animate-ping" />
        <Mic size={30} className="text-white relative z-10" />
      </button>
      <p className="text-sm text-slate-400">Tap to speak</p>
      <button
        onClick={() => { setPhase('text'); setTimeout(() => inputRef.current?.focus(), 50); }}
        className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-600 transition-colors"
      >
        <Keyboard size={11} /> Type instead
      </button>

      {/* Invisible input so we can always show text mode */}
      <input ref={inputRef} className="sr-only" />
    </div>
  );

  /* ── Listening: waveform ── */
  if (phase === 'listening') return (
    <div className="flex flex-col items-center gap-5">
      <div className="relative flex size-20 items-center justify-center rounded-full bg-red-500 shadow-xl shadow-red-200">
        <span className="absolute inset-0 rounded-full bg-red-400/30 animate-ping" />
        <Mic size={30} className="text-white relative z-10" />
      </div>
      <div className="flex items-end gap-1 h-7">
        {[5, 10, 16, 9, 13, 18, 11, 14, 7, 12, 16, 10].map((h, i) => (
          <span
            key={i}
            className="w-1.5 rounded-full bg-indigo-400"
            style={{
              height: h,
              animation: 'wave 0.8s ease-in-out infinite',
              animationDelay: `${(i % 4) * 0.13}s`,
            }}
          />
        ))}
      </div>
      <p className="text-sm text-slate-400 flex items-center gap-1.5">
        <span className="size-1.5 rounded-full bg-red-500 animate-pulse" /> Listening…
      </p>
    </div>
  );

  /* ── Text mode ── */
  return (
    <div className="flex flex-col gap-3 w-full">
      {val && phase === 'text' && (
        <p className="text-center text-xs text-indigo-400 flex items-center justify-center gap-1">
          <Mic size={10} /> Heard — edit if needed
        </p>
      )}
      <div className="flex items-center gap-2">
        <input
          ref={inputRef}
          value={val}
          onChange={e => setVal(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && submit()}
          placeholder={placeholder}
          autoFocus
          className="flex-1 rounded-2xl border border-slate-200 px-4 py-3.5 text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none focus:border-indigo-400 bg-white transition-colors"
        />
        <button
          onClick={submit}
          disabled={!val.trim()}
          className="flex size-12 shrink-0 items-center justify-center rounded-2xl bg-indigo-600 text-white hover:bg-indigo-500 disabled:opacity-30 active:scale-95 transition-all"
        >
          <ArrowRight size={18} />
        </button>
      </div>
      <button
        onClick={() => { setVal(''); setPhase('idle'); }}
        className="flex items-center justify-center gap-1.5 text-xs text-slate-400 hover:text-slate-600 transition-colors"
      >
        <Mic size={11} /> Switch to voice
      </button>
    </div>
  );
}

// ─── Multi-select chips ────────────────────────────────────────────────────
function MultiChoice({ onSubmit }: { onSubmit: (v: string[]) => void }) {
  const [sel, setSel] = useState<string[]>([]);
  const toggle = (v: string) => setSel(p => p.includes(v) ? p.filter(x => x !== v) : [...p, v]);

  return (
    <div className="flex flex-col gap-3 w-full">
      <div className="grid grid-cols-2 gap-2.5">
        {SERVICE_OPTIONS.map(o => {
          const on = sel.includes(o.value);
          return (
            <button
              key={o.value}
              onClick={() => toggle(o.value)}
              className={`flex items-center gap-2.5 rounded-2xl border px-4 py-3.5 text-left transition-all active:scale-95 ${
                on
                  ? 'border-indigo-400 bg-indigo-50 shadow-sm'
                  : 'border-slate-200 bg-white hover:border-slate-300'
              }`}
            >
              <span className="text-xl leading-none">{o.emoji}</span>
              <span className={`text-sm flex-1 ${on ? 'text-indigo-700' : 'text-slate-700'}`}>{o.label}</span>
              {on && <Check size={13} className="text-indigo-500 shrink-0" />}
            </button>
          );
        })}
      </div>
      {sel.length > 0 && (
        <button
          onClick={() => onSubmit(sel)}
          className="flex items-center justify-center gap-2 rounded-2xl bg-indigo-600 text-white py-3.5 text-sm hover:bg-indigo-500 active:scale-95 transition-all"
          style={{ animation: 'stepIn 0.2s ease' }}
        >
          <Check size={14} /> Continue with {sel.join(' & ')}
        </button>
      )}
    </div>
  );
}

// ─── Single-select list ────────────────────────────────────────────────────
function SingleChoice({
  options, cols = 1, onSubmit,
}: { options: { value: string; label: string; sub?: string }[]; cols?: 1|2; onSubmit: (v: string) => void }) {
  const [chosen, setChosen] = useState<string | null>(null);

  function pick(v: string) {
    setChosen(v);
    setTimeout(() => onSubmit(v), 280);
  }

  return (
    <div className={`grid gap-2.5 w-full ${cols === 2 ? 'grid-cols-2' : 'grid-cols-1'}`}>
      {options.map(o => {
        const on = chosen === o.value;
        return (
          <button
            key={o.value}
            onClick={() => pick(o.value)}
            className={`flex items-center gap-3 rounded-2xl border px-4 py-3.5 text-left transition-all active:scale-95 ${
              on ? 'border-indigo-400 bg-indigo-50 shadow-sm' : 'border-slate-200 bg-white hover:border-slate-300'
            }`}
          >
            <div className="flex-1 min-w-0">
              <p className={`text-sm ${on ? 'text-indigo-700' : 'text-slate-800'}`}>{o.label}</p>
              {o.sub && <p className={`text-xs mt-0.5 ${on ? 'text-indigo-400' : 'text-slate-400'}`}>{o.sub}</p>}
            </div>
            <div className={`size-5 shrink-0 rounded-full border-2 flex items-center justify-center transition-all ${
              on ? 'border-indigo-500 bg-indigo-500' : 'border-slate-200'
            }`}>
              {on && <Check size={11} className="text-white" strokeWidth={3} />}
            </div>
          </button>
        );
      })}
    </div>
  );
}

// ─── Rule toggle cards ─────────────────────────────────────────────────────
function RuleCards({ initial, onConfirm }: { initial: Rule[]; onConfirm: (r: Rule[]) => void }) {
  const [rules, setRules] = useState<Rule[]>(initial);
  const count = rules.filter(r => r.enabled).length;

  function toggle(id: string) {
    setRules(p => p.map(r => r.id === id ? { ...r, enabled: !r.enabled } : r));
  }

  return (
    <div className="flex flex-col gap-2.5 w-full">
      {rules.map(rule => {
        const Icon = RULE_ICONS[rule.icon] ?? Zap;
        return (
          <div
            key={rule.id}
            className={`flex items-start gap-3 rounded-2xl border px-4 py-3.5 transition-all ${
              rule.enabled ? 'border-green-200 bg-green-50/60' : 'border-slate-200 bg-white'
            }`}
          >
            <div className={`flex size-8 shrink-0 items-center justify-center rounded-xl mt-0.5 ${
              rule.enabled ? 'bg-green-100' : 'bg-slate-100'
            }`}>
              <Icon size={15} className={rule.enabled ? 'text-green-600' : 'text-slate-400'} />
            </div>
            <div className="flex-1 min-w-0">
              <p className={`text-sm ${rule.enabled ? 'text-slate-900' : 'text-slate-500'}`}>{rule.title}</p>
              <p className="text-xs text-slate-400 mt-0.5 leading-snug">{rule.desc}</p>
            </div>
            <button
              onClick={() => toggle(rule.id)}
              className={`relative mt-0.5 flex h-6 w-11 shrink-0 rounded-full transition-all ${
                rule.enabled ? 'bg-green-500' : 'bg-slate-200'
              }`}
            >
              <span className={`absolute top-0.5 size-5 rounded-full bg-white shadow transition-all ${
                rule.enabled ? 'left-[22px]' : 'left-0.5'
              }`} />
            </button>
          </div>
        );
      })}
      <button
        onClick={() => onConfirm(rules)}
        className="flex items-center justify-center gap-2 rounded-2xl bg-indigo-600 text-white py-3.5 text-sm hover:bg-indigo-500 active:scale-95 transition-all mt-1"
      >
        <Check size={14} /> Confirm {count} automation{count !== 1 ? 's' : ''}
      </button>
    </div>
  );
}

// ─── Config summary ────────────────────────────────────────────────────────
function ConfigSummary({ answers: a, rules, onConfirm }: {
  answers: Answers; rules: Rule[]; onConfirm: () => void;
}) {
  const active = rules.filter(r => r.enabled);
  return (
    <div className="flex flex-col gap-3 w-full">
      <div className="rounded-2xl border border-slate-200 bg-white overflow-hidden">
        <div className="flex items-center gap-2 px-4 py-2.5 bg-slate-50 border-b border-slate-100">
          <Building2 size={12} className="text-slate-400" /><p className="text-xs text-slate-500">Business</p>
        </div>
        <div className="px-4 py-3">
          <p className="text-sm text-slate-900">{a.name} · {a.businessName}</p>
          <div className="flex flex-wrap gap-1.5 mt-2">
            {a.services.map(s => (
              <span key={s} className="text-xs bg-slate-100 text-slate-600 rounded-full px-2 py-0.5">{s}</span>
            ))}
            {a.teamSize && <span className="text-xs bg-slate-100 text-slate-600 rounded-full px-2 py-0.5">{a.teamSize}</span>}
          </div>
        </div>
      </div>

      <div className="rounded-2xl border border-slate-200 bg-white overflow-hidden">
        <div className="flex items-center gap-2 px-4 py-2.5 bg-slate-50 border-b border-slate-100">
          <Users size={12} className="text-slate-400" /><p className="text-xs text-slate-500">Terminology</p>
        </div>
        <div className="px-4 py-3 grid grid-cols-3 gap-3">
          {[
            { label: 'Field staff',  val: a.workerTerm   },
            { label: 'Work called',  val: a.jobTerm      },
            { label: 'Proposals',    val: a.estimateTerm },
          ].map(({ label, val }) => (
            <div key={label}>
              <p className="text-xs text-slate-400">{label}</p>
              <p className="text-sm text-slate-800 mt-0.5">{val}</p>
            </div>
          ))}
        </div>
      </div>

      <div className="rounded-2xl border border-slate-200 bg-white overflow-hidden">
        <div className="flex items-center justify-between px-4 py-2.5 bg-slate-50 border-b border-slate-100">
          <div className="flex items-center gap-2">
            <Zap size={12} className="text-slate-400" /><p className="text-xs text-slate-500">Automations</p>
          </div>
          <span className="text-xs bg-green-100 text-green-700 rounded-full px-2 py-0.5">{active.length} on</span>
        </div>
        <div className="px-4 py-3 flex flex-col gap-1.5">
          {active.map(r => (
            <div key={r.id} className="flex items-center gap-2">
              <span className="size-1.5 rounded-full bg-green-500 shrink-0" />
              <p className="text-xs text-slate-700">{r.title}</p>
            </div>
          ))}
        </div>
      </div>

      <button
        onClick={onConfirm}
        className="flex items-center justify-center gap-2 rounded-2xl bg-indigo-600 text-white py-4 text-sm hover:bg-indigo-500 active:scale-95 transition-all"
      >
        <Check size={15} /> Looks good — launch my workspace
      </button>
    </div>
  );
}

// ─── Welcome screen ────────────────────────────────────────────────────────
function WelcomeScreen({ onStart }: { onStart: () => void }) {
  const [vis, setVis] = useState(false);
  useEffect(() => { const t = setTimeout(() => setVis(true), 80); return () => clearTimeout(t); }, []);

  return (
    <div className="min-h-screen bg-slate-950 flex flex-col items-center justify-center px-8 text-center overflow-hidden">
      <div className="absolute inset-0 pointer-events-none">
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-2/3 w-80 h-80 rounded-full bg-indigo-600/12 blur-3xl" />
      </div>
      <div
        className="flex flex-col items-center gap-8 relative z-10 max-w-xs w-full"
        style={{ opacity: vis ? 1 : 0, transform: vis ? 'translateY(0)' : 'translateY(20px)', transition: 'all 0.65s ease' }}
      >
        <div className="relative">
          <div className="flex size-20 items-center justify-center rounded-3xl bg-indigo-600 shadow-2xl shadow-indigo-600/40">
            <Sparkles size={34} className="text-white" />
          </div>
          <div className="absolute -inset-3 rounded-[32px] border-2 border-indigo-500/20"
            style={{ animation: 'glow 2.8s ease-in-out infinite' }} />
        </div>

        <div>
          <p className="text-indigo-400 tracking-widest uppercase text-xs mb-2.5">Fieldly</p>
          <h1 className="text-white" style={{ fontSize: '2rem', lineHeight: 1.2 }}>
            Your AI service<br />business OS
          </h1>
          <p className="text-slate-500 mt-3 leading-relaxed text-sm">
            Let's get you configured.<br />It's a conversation, not a form.
          </p>
        </div>

        <div className="flex flex-col gap-3 w-full">
          <button
            onClick={onStart}
            className="flex items-center justify-center gap-2.5 rounded-2xl bg-indigo-600 text-white py-4 hover:bg-indigo-500 active:scale-95 transition-all shadow-xl shadow-indigo-600/25"
          >
            <Mic size={18} /> Start with voice
          </button>
          <button
            onClick={onStart}
            className="flex items-center justify-center gap-2.5 rounded-2xl border border-slate-700 text-slate-300 py-3.5 hover:bg-slate-900 hover:border-slate-600 active:scale-95 transition-all"
          >
            <Keyboard size={16} /> I'll type instead
          </button>
        </div>

        <div className="flex items-center gap-4 text-xs text-slate-600">
          {['No forms', '~2 minutes', 'Always editable'].map(l => (
            <span key={l} className="flex items-center gap-1">
              <Check size={9} className="text-slate-500" /> {l}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Done screen ───────────────────────────────────────────────────────────
function DoneScreen({ name, onGo }: { name: string; onGo: () => void }) {
  const [vis, setVis] = useState(false);
  useEffect(() => { const t = setTimeout(() => setVis(true), 100); return () => clearTimeout(t); }, []);

  return (
    <div className="min-h-screen bg-slate-950 flex flex-col items-center justify-center px-8 text-center">
      <div
        className="flex flex-col items-center gap-8 max-w-xs w-full"
        style={{ opacity: vis ? 1 : 0, transform: vis ? 'translateY(0)' : 'translateY(20px)', transition: 'all 0.6s ease' }}
      >
        <div className="relative">
          <div
            className="flex size-24 items-center justify-center rounded-full bg-green-500 shadow-2xl shadow-green-500/30"
            style={{ animation: 'popIn 0.5s cubic-bezier(0.34,1.56,0.64,1) both' }}
          >
            <Check size={44} className="text-white" strokeWidth={2.5} />
          </div>
          <div className="absolute -inset-3 rounded-full bg-green-400/12" style={{ animation: 'glow 2s ease-in-out infinite' }} />
        </div>
        <div>
          <p className="text-green-400 text-sm mb-1.5">You're all set</p>
          <h1 className="text-white" style={{ fontSize: '1.85rem', lineHeight: 1.15 }}>
            Welcome{name ? `, ${name}` : ''}! 🎉
          </h1>
          <p className="text-slate-500 mt-2.5 leading-relaxed text-sm">
            Your workspace is configured<br />and automations are live.
          </p>
        </div>
        <button
          onClick={onGo}
          className="flex items-center gap-2.5 rounded-2xl bg-white text-slate-900 px-10 py-4 hover:bg-slate-100 active:scale-95 transition-all shadow-lg"
        >
          Enter Fieldly <ChevronRight size={17} />
        </button>
      </div>
    </div>
  );
}

// ─── Main question screen ──────────────────────────────────────────────────
function QuestionScreen({ onDone }: { onDone: (name: string) => void }) {
  const [step,    setStep]    = useState(0);
  const [answers, setAnswers] = useState<Answers>(BLANK);
  const [rules,   setRules]   = useState<Rule[]>([]);
  const [animKey, setAnimKey] = useState(0);   // triggers re-animation on step change
  const [fading,  setFading]  = useState(false);

  function advance(update: Partial<Answers>) {
    const na = { ...answers, ...update };
    setAnswers(na);
    setFading(true);

    setTimeout(() => {
      const next = step + 1;
      if (next >= TOTAL) { onDone(na.name); return; }
      if (next === 7) setRules(rulesFor(na.services));
      setStep(next);
      setAnimKey(k => k + 1);
      setFading(false);
    }, 220);
  }

  const crumb = breadcrumb(step, answers);
  const q     = question(step, answers);
  const prog  = step / (TOTAL - 1);

  function renderAnswer() {
    switch (step) {
      case 0: return <VoiceAnswer onSubmit={v => advance({ name: v })}         placeholder="Your first name…"    mockVoice="Mike"                />;
      case 1: return <VoiceAnswer onSubmit={v => advance({ businessName: v })} placeholder="Business name…"      mockVoice="Austin Pro Services"  />;
      case 2: return <MultiChoice onSubmit={v  => advance({ services: v })} />;
      case 3: return <SingleChoice cols={2} options={TEAM_OPTIONS}     onSubmit={v => advance({ teamSize: v })}    />;
      case 4: return <SingleChoice         options={WORKER_TERMS}     onSubmit={v => advance({ workerTerm: v })}  />;
      case 5: return <SingleChoice         options={JOB_TERMS}        onSubmit={v => advance({ jobTerm: v })}     />;
      case 6: return <SingleChoice cols={2} options={ESTIMATE_TERMS}  onSubmit={v => advance({ estimateTerm: v })}/>;
      case 7: return (
        <RuleCards
          initial={rules}
          onConfirm={r => {
            setRules(r);
            advance({});
          }}
        />
      );
      case 8: return (
        <ConfigSummary
          answers={answers}
          rules={rules}
          onConfirm={() => onDone(answers.name)}
        />
      );
      default: return null;
    }
  }

  const isLongStep = step >= 7;

  return (
    <div className="flex flex-col min-h-screen bg-white">
      {/* Header */}
      <div className="shrink-0 px-5 pt-4 pb-0 border-b border-slate-100 bg-white">
        <div className="flex items-center justify-between mb-3 max-w-lg mx-auto">
          <div className="flex items-center gap-2">
            <div className="flex size-6 items-center justify-center rounded-lg bg-indigo-600">
              <Sparkles size={12} className="text-white" />
            </div>
            <p className="text-sm text-slate-500">Fieldly Setup</p>
          </div>
          <div className="flex items-center gap-2.5">
            <p className="text-xs text-slate-400">{Math.min(step + 1, 7)} / 7</p>
            <div className="flex gap-1">
              {Array.from({ length: 7 }).map((_, i) => (
                <span key={i} className={`rounded-full transition-all duration-300 ${
                  i < step        ? 'size-1.5 bg-indigo-500'       :
                  i === step && step < 7 ? 'w-3 h-1.5 bg-indigo-500' :
                                    'size-1.5 bg-slate-200'
                }`} />
              ))}
            </div>
          </div>
        </div>
        <div className="h-0.5 bg-slate-100 max-w-lg mx-auto">
          <div className="h-0.5 bg-indigo-500 rounded-full transition-all duration-500" style={{ width: `${prog * 100}%` }} />
        </div>
      </div>

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto">
        <div
          key={animKey}
          className="max-w-lg mx-auto px-5 w-full"
          style={{
            opacity: fading ? 0 : 1,
            transform: fading ? 'translateY(6px)' : 'translateY(0)',
            transition: 'opacity 0.2s ease, transform 0.2s ease',
            animation: !fading ? 'stepIn 0.3s ease both' : undefined,
          }}
        >
          {/* Breadcrumb trail */}
          {crumb && (
            <p className="text-center text-xs text-slate-400 mt-6 mb-0 truncate px-4">{crumb}</p>
          )}

          {/* AI avatar + question */}
          <div className={`flex flex-col items-center text-center ${isLongStep ? 'pt-6 pb-4' : 'py-10'}`}>
            <div className="flex size-10 items-center justify-center rounded-full bg-indigo-600 mb-5 shadow-lg shadow-indigo-200">
              <Sparkles size={16} className="text-white" />
            </div>
            <h2
              className="text-slate-900 leading-snug"
              style={{ fontSize: '1.25rem', maxWidth: '22rem' }}
            >
              {q.split('\n').map((line, i) =>
                line ? <span key={i}>{line}</span> : <br key={i} />
              )}
            </h2>
          </div>

          {/* Answer area */}
          <div className={`${isLongStep ? 'pb-10' : 'pb-12'}`}>
            {renderAnswer()}
          </div>
        </div>
      </div>

      <style>{`
        @keyframes stepIn {
          from { opacity: 0; transform: translateY(14px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        @keyframes wave {
          0%, 100% { transform: scaleY(0.35); opacity: 0.5; }
          50%       { transform: scaleY(1);    opacity: 1;   }
        }
        @keyframes glow {
          0%, 100% { opacity: 0.2; transform: scale(1); }
          50%       { opacity: 0.5; transform: scale(1.05); }
        }
        @keyframes popIn {
          0%  { transform: scale(0.5); opacity: 0; }
          70% { transform: scale(1.1); }
          100%{ transform: scale(1);   opacity: 1; }
        }
      `}</style>
    </div>
  );
}

// ─── Entry point ──────────────────────────────────────────────────────────
export function OnboardingPage() {
  const navigate = useNavigate();
  const [phase,    setPhase]    = useState<'welcome' | 'chat' | 'done'>('welcome');
  const [doneName, setDoneName] = useState('');

  if (phase === 'welcome') return <WelcomeScreen onStart={() => setPhase('chat')} />;
  if (phase === 'done')    return <DoneScreen name={doneName} onGo={() => navigate('/')} />;
  return <QuestionScreen onDone={name => { setDoneName(name); setPhase('done'); }} />;
}

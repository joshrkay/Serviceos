import { useState, useEffect, useRef } from 'react';
import { Mic, X, Send, Sparkles } from 'lucide-react';
import { useNavigate } from 'react-router';

type BarPhase = 'idle' | 'listening' | 'transcript' | 'sending';

const DEMO_COMMANDS = [
  'Invoice the Rodriguez job',
  'Schedule the Thompson exterior paint job',
  'What do I have going on today?',
  'Send a follow-up to Michael Davis',
  "How's the Williams paint job going?",
  "What's on the schedule tomorrow?",
  'Show me overdue invoices',
];

// ─── Compact waveform ─────────────────────────────────────────────
function Waveform() {
  const heights = [0.45, 0.75, 1, 0.6, 0.85, 0.5, 0.8, 0.55, 0.9, 0.4];
  return (
    <div className="flex items-center gap-[3px]" style={{ height: 22 }}>
      {heights.map((h, i) => (
        <span
          key={i}
          className="rounded-full bg-blue-500"
          style={{
            width: 2.5,
            height: `${h * 100}%`,
            animation: `waveBarCompact 0.7s ease-in-out ${i * 0.07}s infinite alternate`,
            opacity: 0.6 + h * 0.4,
          }}
        />
      ))}
      <style>{`
        @keyframes waveBarCompact {
          from { transform: scaleY(0.35); }
          to   { transform: scaleY(1); }
        }
      `}</style>
    </div>
  );
}

interface VoiceBarProps {
  /** Renders as an inline sidebar element (desktop) rather than the mobile bottom bar */
  variant?: 'mobile' | 'desktop';
}

export function VoiceBar({ variant = 'mobile' }: VoiceBarProps) {
  const navigate = useNavigate();
  const [phase, setPhase] = useState<BarPhase>('idle');
  const [transcript, setTranscript] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  // Pick a random demo command each time listening starts
  const startListening = () => {
    const cmd = DEMO_COMMANDS[Math.floor(Math.random() * DEMO_COMMANDS.length)];
    setTranscript(cmd);
    setPhase('listening');
  };

  // Auto-advance: listening → transcript after 2.2s
  useEffect(() => {
    if (phase !== 'listening') return;
    const t = setTimeout(() => {
      setPhase('transcript');
    }, 2200);
    return () => clearTimeout(t);
  }, [phase]);

  // Focus input when transcript appears
  useEffect(() => {
    if (phase === 'transcript') {
      setTimeout(() => inputRef.current?.focus(), 80);
    }
  }, [phase]);

  function handleSend() {
    if (!transcript.trim()) return;
    setPhase('sending');
    setTimeout(() => {
      navigate(`/assistant?q=${encodeURIComponent(transcript.trim())}`);
      setPhase('idle');
      setTranscript('');
    }, 420);
  }

  function handleCancel() {
    setPhase('idle');
    setTranscript('');
  }

  const isDesktop = variant === 'desktop';

  const containerClass = isDesktop
    ? 'px-3 py-2.5'
    : 'px-3 py-2.5 bg-white border-t border-slate-100';

  return (
    <div className={containerClass}>

      {/* ── IDLE ── */}
      {phase === 'idle' && (
        <button
          onClick={startListening}
          className={`
            flex items-center gap-3 w-full text-left transition-all
            rounded-2xl border border-slate-200 bg-slate-50 px-4
            hover:border-blue-300 hover:bg-blue-50/40 active:scale-[0.99]
            group
            ${isDesktop ? 'py-2.5' : 'py-3'}
          `}
        >
          <span className="flex shrink-0 size-7 items-center justify-center rounded-full bg-blue-600 shadow-sm group-hover:bg-blue-700 transition-colors">
            <Mic size={14} className="text-white" />
          </span>
          <span className="text-sm text-slate-400 flex-1">Ask Fieldly AI anything…</span>
          <span className="text-xs text-slate-300">tap to speak</span>
        </button>
      )}

      {/* ── LISTENING ── */}
      {phase === 'listening' && (
        <div className={`
          flex items-center gap-3 rounded-2xl border border-blue-200 bg-blue-50
          px-4 transition-all
          ${isDesktop ? 'py-2.5' : 'py-3'}
        `}>
          {/* Live indicator */}
          <span className="flex shrink-0 size-7 items-center justify-center rounded-full bg-blue-600">
            <span className="size-2.5 rounded-full bg-white" style={{ animation: 'liveDot 1s ease-in-out infinite' }} />
          </span>
          {/* Waveform + label */}
          <div className="flex-1 flex items-center gap-3 min-w-0">
            <span className="text-sm text-blue-700 shrink-0">Listening…</span>
            <div className="flex-1"><Waveform /></div>
          </div>
          {/* Cancel */}
          <button
            onClick={handleCancel}
            className="shrink-0 flex size-6 items-center justify-center rounded-full bg-blue-100 hover:bg-blue-200 transition-colors"
          >
            <X size={13} className="text-blue-600" />
          </button>
          <style>{`
            @keyframes liveDot {
              0%, 100% { transform: scale(0.7); opacity: 0.6; }
              50%       { transform: scale(1);   opacity: 1; }
            }
          `}</style>
        </div>
      )}

      {/* ── TRANSCRIPT (review & edit before sending) ── */}
      {phase === 'transcript' && (
        <div className="flex flex-col gap-1.5">
          <div className={`
            flex items-center gap-2.5 rounded-2xl border border-slate-900/20 bg-white
            shadow-sm px-3
            ${isDesktop ? 'py-2' : 'py-2.5'}
          `}
            style={{ boxShadow: '0 0 0 3px rgba(37,99,235,0.08), 0 1px 4px rgba(0,0,0,0.06)' }}
          >
            <span className="flex shrink-0 size-6 items-center justify-center rounded-full bg-slate-100">
              <Mic size={12} className="text-slate-500" />
            </span>
            <input
              ref={inputRef}
              value={transcript}
              onChange={e => setTranscript(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleSend(); if (e.key === 'Escape') handleCancel(); }}
              className="flex-1 text-sm text-slate-900 outline-none bg-transparent min-w-0"
            />
            <button
              onClick={handleCancel}
              className="shrink-0 p-1 rounded-full text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition-colors"
            >
              <X size={14} />
            </button>
            <button
              onClick={handleSend}
              disabled={!transcript.trim()}
              className="shrink-0 flex size-7 items-center justify-center rounded-full bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40 transition-colors"
            >
              <Send size={13} />
            </button>
          </div>
          <p className="text-xs text-slate-400 pl-1">Edit if needed, then tap <span className="text-blue-500">send</span></p>
        </div>
      )}

      {/* ── SENDING ── */}
      {phase === 'sending' && (
        <div className={`
          flex items-center gap-3 rounded-2xl border border-blue-100 bg-blue-50
          px-4
          ${isDesktop ? 'py-2.5' : 'py-3'}
        `}>
          <Sparkles
            size={16}
            className="text-blue-500 shrink-0"
            style={{ animation: 'spin 1.2s linear infinite' }}
          />
          <span className="text-sm text-blue-700 flex-1 truncate">{transcript}</span>
          <div className="flex gap-1 shrink-0">
            {[0, 1, 2].map(i => (
              <span
                key={i}
                className="size-1.5 rounded-full bg-blue-400 animate-bounce"
                style={{ animationDelay: `${i * 120}ms` }}
              />
            ))}
          </div>
          <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
        </div>
      )}

    </div>
  );
}

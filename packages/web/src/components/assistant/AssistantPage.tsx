import { useState, useRef, useEffect, useCallback } from 'react';
import {
  Send, Mic, Paperclip, Sparkles, Check, Zap,
  Square, Image, FileText, X, ThumbsUp, ThumbsDown,
  Copy, ChevronDown, Clock, Briefcase, Receipt, Calendar,
  AlertCircle, Volume2,
} from 'lucide-react';
import { useSearchParams } from 'react-router';
import { type Message, type AIProposal } from '../../data/mock-data';
import { AIProposalCard } from '../shared/AIProposalCard';
import { useDetailQuery } from '../../hooks/useDetailQuery';

interface ApiMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
}

interface ApiConversation {
  id: string;
  messages: ApiMessage[];
}

function mapApiMessage(msg: ApiMessage): Message {
  return {
    id: msg.id,
    role: msg.role,
    content: msg.content,
    time: new Date(msg.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
  };
}

// ─── Unique ID ─────────────────────────────────────────────────
let msgId = 200;
const uid = () => `m${++msgId}`;

// ─── Context strip data ─────────────────────────────────────────
const TODAY_CONTEXT = [
  { icon: Briefcase, label: '3 active', sub: 'jobs today',   color: 'text-green-600', bg: 'bg-green-50',  border: 'border-green-100' },
  { icon: Receipt,   label: '$1,850',   sub: 'pending invoice', color: 'text-blue-600',  bg: 'bg-blue-50',   border: 'border-blue-100' },
  { icon: AlertCircle,label: '2 items', sub: 'need attention',  color: 'text-amber-600', bg: 'bg-amber-50',  border: 'border-amber-100' },
  { icon: Calendar,  label: '2 jobs',   sub: 'tomorrow',       color: 'text-violet-600',bg: 'bg-violet-50', border: 'border-violet-100' },
];

// ─── Suggestion chips ───────────────────────────────────────────
const SUGGESTIONS = [
  { text: 'Invoice the Rodriguez job',        icon: Receipt },
  { text: 'Schedule Thompson exterior paint', icon: Calendar },
  { text: 'Send follow-up to Davis',          icon: Send },
  { text: "What's on tomorrow's schedule?",   icon: Clock },
  { text: 'Who\'s free Thursday morning?',    icon: Briefcase },
  { text: 'Any overdue invoices?',            icon: AlertCircle },
];

// ─── AI Conversation API ────────────────────────────────────────
// Send user messages to the backend conversation API and receive real AI responses.
// Falls back to a simple echo if the API is unavailable.
async function sendToConversationAPI(
  conversationId: string | null,
  text: string,
): Promise<{ content: string; reasoning?: string; proposal?: AIProposal; autoApplied?: boolean; newConversationId?: string }> {
  try {
    const body: Record<string, unknown> = { content: text, messageType: 'text' };
    if (conversationId) body.conversationId = conversationId;

    const res = await fetch('/api/conversations/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      throw new Error(`API error: ${res.status}`);
    }

    const data = await res.json();
    return {
      content: data.content || data.message || 'I received your message but could not generate a response.',
      reasoning: data.reasoning,
      proposal: data.proposal,
      autoApplied: data.autoApplied,
      newConversationId: data.conversationId,
    };
  } catch {
    // Fallback when API is unreachable (e.g., local dev without backend)
    return {
      content: `I received your message: "${text}". The AI backend is not connected yet — connect it via AI_PROVIDER_API_KEY to get real responses.`,
      reasoning: 'API unavailable — showing fallback response.',
    };
  }
}

// ─── Message timestamp helper ───────────────────────────────────
function now() { return new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }

// ─── Typing Indicator ───────────────────────────────────────────
function TypingIndicator({ reasoning }: { reasoning?: string }) {
  return (
    <div className="flex gap-3 mb-4" style={{ animation: 'fadeIn 0.2s ease' }}>
      <AvatarAI />
      <div className="flex flex-col gap-1.5">
        {reasoning && (
          <div className="flex items-center gap-1.5 text-xs text-slate-400 mb-1">
            <span className="size-1 rounded-full bg-indigo-400" style={{ animation: 'pulse 1s infinite' }} />
            {reasoning}
          </div>
        )}
        <div className="rounded-2xl rounded-tl-sm bg-white border border-slate-200 px-4 py-3 shadow-sm">
          <div className="flex items-center gap-1.5">
            {[0, 1, 2].map(i => (
              <span
                key={i}
                className="size-1.5 rounded-full bg-slate-300"
                style={{ animation: `typingBounce 1.2s ease-in-out ${i * 0.18}s infinite` }}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Avatars ────────────────────────────────────────────────────
function AvatarAI() {
  return (
    <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-blue-500 to-indigo-600 shadow-sm mt-0.5">
      <Sparkles size={12} className="text-white" />
    </span>
  );
}

// ─── User voice waveform decoration ────────────────────────────
function VoiceWaveform({ duration }: { duration: number }) {
  return (
    <div className="flex items-center gap-1 py-1">
      <Volume2 size={12} className="text-white/70 shrink-0" />
      <div className="flex items-center gap-0.5">
        {Array.from({ length: 16 }).map((_, i) => (
          <div
            key={i}
            className="w-0.5 rounded-full bg-white/60"
            style={{ height: `${6 + Math.sin(i * 0.8) * 5 + Math.random() * 6}px` }}
          />
        ))}
      </div>
      <span className="text-xs text-white/70 ml-1 tabular-nums">{duration}s</span>
    </div>
  );
}

// ─── Message Bubble ─────────────────────────────────────────────
function MessageBubble({ msg, isLast }: { msg: Message; isLast: boolean }) {
  const [reaction, setReaction] = useState<'up' | 'down' | null>(null);
  const [showActions, setShowActions] = useState(false);
  const isUser = msg.role === 'user';

  // Format markdown-ish bold
  function formatContent(text: string) {
    const parts = text.split(/\*\*(.*?)\*\*/g);
    return parts.map((part, i) =>
      i % 2 === 1
        ? <strong key={i} className="text-slate-900">{part}</strong>
        : <span key={i}>{part}</span>
    );
  }

  if (isUser) {
    return (
      <div className="flex justify-end mb-4" style={{ animation: 'fadeSlideUp 0.2s ease' }}>
        <div className="max-w-[78%] md:max-w-[60%]">
          {/* Voice input */}
          {msg.inputMode === 'voice' && (
            <div className="bg-slate-900 text-white rounded-2xl rounded-tr-sm px-4 py-3 mb-1">
              <div className="flex items-center gap-2 mb-1">
                <Mic size={12} className="text-slate-400" />
                <span className="text-xs text-slate-400">Voice note</span>
              </div>
              {msg.voiceDuration && <VoiceWaveform duration={msg.voiceDuration} />}
              <p className="text-sm text-slate-200 italic mt-1">"{msg.content}"</p>
            </div>
          )}

          {/* Photo attachment */}
          {msg.attachments && msg.attachments.map((att, i) => (
            <div key={i} className="mb-1.5">
              {att.type === 'photo' ? (
                <div className="rounded-2xl rounded-tr-sm overflow-hidden bg-slate-800 w-48 h-36 flex items-center justify-center">
                  <Image size={28} className="text-slate-500" />
                </div>
              ) : (
                <div className="flex items-center gap-2 rounded-xl bg-slate-100 border border-slate-200 px-3 py-2.5">
                  <FileText size={14} className="text-slate-500" />
                  <span className="text-sm text-slate-700">{att.name}</span>
                </div>
              )}
            </div>
          ))}

          {/* Normal text bubble */}
          {msg.inputMode !== 'voice' && (
            <div className="bg-slate-900 text-white rounded-2xl rounded-tr-sm px-4 py-3 text-sm leading-relaxed">
              {msg.content}
            </div>
          )}

          <p className="text-right text-xs text-slate-400 mt-1 mr-1">{msg.time}</p>
        </div>
      </div>
    );
  }

  // ── AI Message ───────────────────────────────────────────────
  return (
    <div
      className="flex gap-3 mb-4 group"
      style={{ animation: 'fadeSlideUp 0.25s ease' }}
      onMouseEnter={() => setShowActions(true)}
      onMouseLeave={() => setShowActions(false)}
    >
      <AvatarAI />

      <div className="flex-1 min-w-0 max-w-[80%] md:max-w-[70%]">
        {/* Auto-applied badge */}
        {msg.autoApplied && (
          <div className="flex items-center gap-1.5 mb-2 rounded-full bg-green-50 border border-green-200 px-3 py-1.5 w-fit">
            <span className="size-1.5 rounded-full bg-green-500" />
            <span className="text-xs text-green-700">Applied automatically</span>
          </div>
        )}

        {/* Message content */}
        {msg.content && (
          <div className="bg-white border border-slate-200 rounded-2xl rounded-tl-sm px-4 py-3 text-sm text-slate-700 leading-relaxed shadow-sm whitespace-pre-line">
            {formatContent(msg.content)}
          </div>
        )}

        {/* Proposal card */}
        {msg.proposal && (
          <div className="mt-2">
            <AIProposalCard proposal={msg.proposal} />
          </div>
        )}

        {/* Timestamp + reaction row */}
        <div className="flex items-center gap-3 mt-1.5 ml-1">
          <p className="text-xs text-slate-400">{msg.time}</p>

          {/* Hover actions */}
          {showActions && !msg.proposal && (
            <div className="flex items-center gap-1" style={{ animation: 'fadeIn 0.15s ease' }}>
              <button
                onClick={() => setReaction(r => r === 'up' ? null : 'up')}
                className={`flex size-6 items-center justify-center rounded-full transition-colors ${reaction === 'up' ? 'bg-green-100 text-green-600' : 'text-slate-300 hover:text-slate-500 hover:bg-slate-100'}`}
              >
                <ThumbsUp size={11} />
              </button>
              <button
                onClick={() => setReaction(r => r === 'down' ? null : 'down')}
                className={`flex size-6 items-center justify-center rounded-full transition-colors ${reaction === 'down' ? 'bg-red-100 text-red-500' : 'text-slate-300 hover:text-slate-500 hover:bg-slate-100'}`}
              >
                <ThumbsDown size={11} />
              </button>
              <button
                onClick={() => navigator.clipboard?.writeText(msg.content)}
                className="flex size-6 items-center justify-center rounded-full text-slate-300 hover:text-slate-500 hover:bg-slate-100 transition-colors"
              >
                <Copy size={11} />
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Date separator ─────────────────────────────────────────────
function DateSep({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-3 my-5">
      <div className="flex-1 h-px bg-slate-100" />
      <span className="text-xs text-slate-400 px-2">{label}</span>
      <div className="flex-1 h-px bg-slate-100" />
    </div>
  );
}

// ─── Voice Recording Overlay ────────────────────────────────────
function VoiceRecordingBar({ onCancel, onSend }: {
  onCancel: () => void;
  onSend: (transcript: string, duration: number) => void;
}) {
  const [seconds, setSeconds]         = useState(0);
  const [transcribing, setTranscribing] = useState(false);
  const [transcript, setTranscript]   = useState('');

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);

  useEffect(() => {
    // Start recording via MediaRecorder API
    navigator.mediaDevices?.getUserMedia({ audio: true }).then((stream) => {
      const recorder = new MediaRecorder(stream);
      mediaRecorderRef.current = recorder;
      audioChunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data);
      };

      recorder.start();
    }).catch(() => {
      // Microphone not available — user will need to type instead
    });

    const t = setInterval(() => setSeconds(s => s + 1), 1000);
    return () => {
      clearInterval(t);
      mediaRecorderRef.current?.stream.getTracks().forEach(t => t.stop());
    };
  }, []);

  function stop() {
    const recorder = mediaRecorderRef.current;
    if (!recorder || recorder.state === 'inactive') {
      setTranscribing(true);
      // Fallback: no recorder available
      setTimeout(() => {
        setTranscribing(false);
        setTranscript('(Microphone not available — please type your message)');
      }, 500);
      return;
    }

    setTranscribing(true);
    recorder.onstop = async () => {
      const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
      try {
        const formData = new FormData();
        formData.append('audio', audioBlob, 'recording.webm');
        const res = await fetch('/api/voice/transcribe', {
          method: 'POST',
          credentials: 'include',
          body: formData,
        });
        if (res.ok) {
          const data = await res.json();
          setTranscript(data.transcript || '(Could not transcribe audio)');
        } else {
          setTranscript('(Transcription service unavailable)');
        }
      } catch {
        setTranscript('(Transcription service unavailable)');
      }
      setTranscribing(false);
    };
    recorder.stop();
  }

  const fmt = (s: number) =>
    `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;

  return (
    <div className="flex flex-col gap-3 px-4 py-3 bg-white border-t border-slate-200">
      {transcript ? (
        /* Transcript preview */
        <div className="flex flex-col gap-3">
          <div className="flex items-start gap-2 rounded-xl bg-violet-50 border border-violet-100 px-3 py-3">
            <Mic size={13} className="text-violet-500 shrink-0 mt-0.5" />
            <p className="text-sm text-slate-700 flex-1 italic">"{transcript}"</p>
            <button onClick={() => setTranscript('')} className="text-slate-300 hover:text-slate-500 transition-colors shrink-0">
              <X size={14} />
            </button>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => onSend(transcript, seconds)}
              className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-slate-900 text-white py-3 text-sm hover:bg-slate-700 transition-colors"
            >
              <Send size={14} /> Send
            </button>
            <button
              onClick={onCancel}
              className="flex items-center justify-center gap-1.5 rounded-xl border border-slate-200 bg-white text-slate-600 px-4 py-3 text-sm hover:bg-slate-50 transition-colors"
            >
              <X size={14} /> Cancel
            </button>
          </div>
        </div>
      ) : transcribing ? (
        /* Transcribing */
        <div className="flex items-center justify-between py-2">
          <div className="flex items-center gap-2">
            <span className="size-1.5 rounded-full bg-violet-500" style={{ animation: 'pulse 0.8s infinite' }} />
            <span className="text-sm text-slate-500">Transcribing…</span>
          </div>
          <div className="flex gap-1">
            {[0,1,2].map(i => <span key={i} className="size-1.5 rounded-full bg-violet-300" style={{ animation: `typingBounce 0.9s ease ${i*0.15}s infinite` }} />)}
          </div>
        </div>
      ) : (
        /* Recording */
        <div className="flex items-center gap-3">
          {/* Cancel */}
          <button onClick={onCancel} className="flex size-10 shrink-0 items-center justify-center rounded-full border border-slate-200 text-slate-400 hover:bg-slate-100 transition-colors">
            <X size={16} />
          </button>

          {/* Live waveform */}
          <div className="flex-1 flex items-center gap-2 rounded-xl bg-red-50 border border-red-100 px-3 py-2.5">
            <span className="size-2 rounded-full bg-red-500 shrink-0" style={{ animation: 'pulse 1s infinite' }} />
            <div className="flex items-center gap-0.5 flex-1">
              {Array.from({ length: 24 }).map((_, i) => (
                <div
                  key={i}
                  className="w-0.5 rounded-full bg-red-400"
                  style={{
                    height: `${8 + Math.sin(i * 0.6 + Date.now() * 0.001) * 8}px`,
                    animation: `waveBar ${0.5 + (i % 5) * 0.1}s ease-in-out ${i * 0.03}s infinite alternate`,
                  }}
                />
              ))}
            </div>
            <span className="text-sm text-red-600 tabular-nums shrink-0">{fmt(seconds)}</span>
          </div>

          {/* Stop */}
          <button
            onClick={stop}
            className="flex size-10 shrink-0 items-center justify-center rounded-full bg-red-500 hover:bg-red-600 active:scale-95 transition-all shadow-md"
          >
            <Square size={14} className="text-white fill-current" />
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Attachment Picker ──────────────────────────────────────────
function AttachmentPicker({ onSelect, onClose }: {
  onSelect: (type: 'photo' | 'document') => void;
  onClose: () => void;
}) {
  return (
    <>
      <div className="fixed inset-0 z-10" onClick={onClose} />
      <div className="absolute bottom-full left-0 mb-2 z-20 flex flex-col gap-1 rounded-xl border border-slate-200 bg-white shadow-lg overflow-hidden" style={{ animation: 'fadeSlideUp 0.15s ease' }}>
        <button
          onClick={() => { onSelect('photo'); onClose(); }}
          className="flex items-center gap-3 px-4 py-3 text-sm text-slate-700 hover:bg-slate-50 transition-colors text-left"
        >
          <Image size={16} className="text-sky-500" /> Photo from camera
        </button>
        <button
          onClick={() => { onSelect('document'); onClose(); }}
          className="flex items-center gap-3 px-4 py-3 text-sm text-slate-700 hover:bg-slate-50 transition-colors text-left border-t border-slate-100"
        >
          <FileText size={16} className="text-slate-500" /> Document / file
        </button>
      </div>
    </>
  );
}

// ─── Main Page ──────────────────────────────────────────────────
export function AssistantPage() {
  const [messages, setMessages]       = useState<Message[]>([]);
  const [input, setInput]             = useState('');
  const [typing, setTyping]           = useState(false);
  const [typingReason, setTypingReason] = useState('');
  const [voiceMode, setVoiceMode]     = useState(false);
  const [attachPickerOpen, setAttachPickerOpen] = useState(false);
  const [pendingAttachment, setPendingAttachment] = useState<Message['attachments']>([]);
  const [showScrollBtn, setShowScrollBtn] = useState(false);

  const endRef    = useRef<HTMLDivElement>(null);
  const inputRef  = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [searchParams, setSearchParams] = useSearchParams();

  // Derive conversationId from URL param or localStorage
  const conversationId = searchParams.get('conversationId') || localStorage.getItem('conversationId') || null;
  const { data: conversation, isLoading: convLoading, error: convError } =
    useDetailQuery<ApiConversation>('/api/conversations', conversationId);

  // Seed messages from API — show empty state if no conversation exists yet
  useEffect(() => {
    if (convLoading) return;
    if (conversation?.messages?.length) {
      setMessages(conversation.messages.map(mapApiMessage));
    } else {
      // No mock data — start with an empty conversation or a welcome message
      setMessages([{
        id: 'welcome',
        role: 'assistant' as const,
        content: "Hi! I'm your AI assistant. I can help you manage jobs, create estimates, schedule appointments, and more. What can I help you with?",
        time: new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
      }]);
    }
  }, [convLoading, conversation, convError]);

  // Auto-submit from voice bar ?q= param
  useEffect(() => {
    const q = searchParams.get('q');
    if (q) {
      setSearchParams({}, { replace: true });
      setTimeout(() => send(q), 300);
    }
  }, []); // eslint-disable-line

  useEffect(() => {
    scrollToBottom();
  }, [messages, typing]);

  function scrollToBottom() {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }

  function handleScroll() {
    if (!scrollRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
    setShowScrollBtn(scrollHeight - scrollTop - clientHeight > 120);
  }

  const send = useCallback(async (text: string, opts?: { inputMode?: 'voice' | 'photo'; voiceDuration?: number; attachments?: Message['attachments'] }) => {
    if (!text.trim() && !opts?.attachments?.length) return;
    const t = now();

    const userMsg: Message = {
      id: uid(),
      role: 'user',
      content: text,
      time: t,
      inputMode: opts?.inputMode ?? 'text',
      voiceDuration: opts?.voiceDuration,
      attachments: opts?.attachments,
    };

    setMessages(prev => [...prev, userMsg]);
    setInput('');
    setPendingAttachment([]);
    setTyping(true);
    setTypingReason('Thinking…');

    try {
      const reply = await sendToConversationAPI(conversationId, text);

      // If a new conversation was created, store it
      if (reply.newConversationId && !conversationId) {
        localStorage.setItem('conversationId', reply.newConversationId);
      }

      const aiMsg: Message = {
        id: uid(),
        role: 'assistant',
        content: reply.content,
        time: now(),
        proposal: reply.proposal,
        autoApplied: reply.autoApplied,
      };
      setMessages(prev => [...prev, aiMsg]);
    } catch {
      setMessages(prev => [...prev, {
        id: uid(),
        role: 'assistant',
        content: 'Sorry, something went wrong. Please try again.',
        time: now(),
      }]);
    } finally {
      setTyping(false);
      setTypingReason('');
    }
  }, [conversationId]);

  function handleSend() {
    if (pendingAttachment && pendingAttachment.length > 0) {
      send(input || 'Here\'s the photo — can you identify the issue?', { attachments: pendingAttachment });
    } else {
      send(input);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  function handleAttachSelect(type: 'photo' | 'document') {
    setPendingAttachment([{
      type,
      name: type === 'document' ? 'Work order #1042.pdf' : undefined,
    }]);
  }

  function handleVoiceSend(transcript: string, duration: number) {
    setVoiceMode(false);
    send(transcript, { inputMode: 'voice', voiceDuration: duration });
  }

  const canSend = input.trim().length > 0 || (pendingAttachment?.length ?? 0) > 0;

  return (
    <div className="flex flex-col h-full bg-slate-50">

      {/* ── Header ──────────────────────────────────────────── */}
      <div className="shrink-0 bg-white border-b border-slate-100 px-4 md:px-6 py-3.5">
        <div className="max-w-3xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="relative">
              <span className="flex size-9 items-center justify-center rounded-xl bg-gradient-to-br from-blue-500 to-indigo-600 shadow-md">
                <Sparkles size={16} className="text-white" />
              </span>
              <span className="absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full bg-green-400 border-2 border-white" />
            </div>
            <div>
              <h2 className="text-slate-900" style={{ fontSize: '0.95rem' }}>Fieldly AI</h2>
              <div className="flex items-center gap-1.5">
                <span className="text-xs text-green-600">Online</span>
                <span className="text-slate-300">·</span>
                <span className="text-xs text-slate-400">Aware of all your jobs & schedule</span>
              </div>
            </div>
          </div>

          <button className="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-500 hover:bg-slate-50 transition-colors">
            <ChevronDown size={12} /> Context
          </button>
        </div>
      </div>

      {/* ── Today context strip ─────────────────────────────── */}
      <div className="shrink-0 border-b border-slate-100 bg-white/80 px-4 md:px-6 py-2.5 backdrop-blur-sm">
        <div className="max-w-3xl mx-auto flex gap-2 overflow-x-auto" style={{ scrollbarWidth: 'none' }}>
          {TODAY_CONTEXT.map(({ icon: Icon, label, sub, color, bg, border }) => (
            <div
              key={sub}
              className={`shrink-0 flex items-center gap-2 rounded-lg border px-2.5 py-1.5 ${bg} ${border}`}
            >
              <Icon size={12} className={color} />
              <span className={`text-xs ${color}`}>{label}</span>
              <span className="text-xs text-slate-400">{sub}</span>
            </div>
          ))}
        </div>
      </div>

      {/* ── Messages ────────────────────────────────────────── */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto px-4 md:px-6 py-5 relative"
        style={{ scrollbarWidth: 'thin', scrollbarColor: '#e2e8f0 transparent' }}
      >
        <div className="max-w-3xl mx-auto">

          <DateSep label={`Today · ${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`} />

          {messages.map((msg, i) => (
            <MessageBubble key={msg.id} msg={msg} isLast={i === messages.length - 1} />
          ))}

          {typing && <TypingIndicator reasoning={typingReason} />}

          <div ref={endRef} />
        </div>

        {/* Scroll to bottom btn */}
        {showScrollBtn && (
          <button
            onClick={scrollToBottom}
            className="fixed bottom-32 right-6 flex size-9 items-center justify-center rounded-full bg-white border border-slate-200 shadow-md text-slate-500 hover:bg-slate-50 transition-all z-10"
            style={{ animation: 'fadeIn 0.2s ease' }}
          >
            <ChevronDown size={16} />
          </button>
        )}
      </div>

      {/* ── Suggestion chips ─────────────────────────────────── */}
      {!voiceMode && (
        <div className="shrink-0 bg-white border-t border-slate-100 px-4 md:px-6 pt-2.5 pb-2">
          <div className="max-w-3xl mx-auto flex gap-1.5 overflow-x-auto" style={{ scrollbarWidth: 'none' }}>
            {SUGGESTIONS.map(({ text, icon: Icon }) => (
              <button
                key={text}
                onClick={() => send(text)}
                className="shrink-0 flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-600 hover:border-blue-300 hover:text-blue-700 hover:bg-blue-50 transition-colors"
              >
                <Icon size={10} className="text-slate-400" />
                {text}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ── Input area ───────────────────────────────────────── */}
      {voiceMode ? (
        <VoiceRecordingBar
          onCancel={() => setVoiceMode(false)}
          onSend={handleVoiceSend}
        />
      ) : (
        <div className="shrink-0 bg-white border-t border-slate-100 px-4 md:px-6 py-3">
          <div className="max-w-3xl mx-auto">

            {/* Pending attachment preview */}
            {pendingAttachment && pendingAttachment.length > 0 && (
              <div className="flex items-center gap-2 mb-2 flex-wrap">
                {pendingAttachment.map((att, i) => (
                  <div key={i} className="flex items-center gap-1.5 rounded-lg bg-slate-100 border border-slate-200 px-2.5 py-1.5">
                    {att.type === 'photo'
                      ? <Image size={13} className="text-sky-500" />
                      : <FileText size={13} className="text-slate-500" />
                    }
                    <span className="text-xs text-slate-600">{att.name ?? 'Photo'}</span>
                    <button
                      onClick={() => setPendingAttachment(prev => prev?.filter((_, j) => j !== i))}
                      className="ml-1 text-slate-400 hover:text-slate-600"
                    >
                      <X size={11} />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* Compose bar */}
            <div className="flex items-end gap-2">
              {/* Attach button */}
              <div className="relative shrink-0">
                <button
                  onClick={() => setAttachPickerOpen(v => !v)}
                  className={`flex size-10 items-center justify-center rounded-xl border transition-colors ${
                    attachPickerOpen
                      ? 'border-blue-300 bg-blue-50 text-blue-600'
                      : 'border-slate-200 bg-white text-slate-400 hover:text-slate-600 hover:border-slate-300'
                  }`}
                >
                  <Paperclip size={15} />
                </button>
                {attachPickerOpen && (
                  <AttachmentPicker
                    onSelect={handleAttachSelect}
                    onClose={() => setAttachPickerOpen(false)}
                  />
                )}
              </div>

              {/* Text input */}
              <div className={`flex flex-1 items-end gap-2 rounded-2xl border px-3 py-2.5 transition-colors ${
                input.length > 0 || pendingAttachment?.length
                  ? 'border-blue-300 bg-white shadow-sm'
                  : 'border-slate-200 bg-slate-50'
              }`}>
                <textarea
                  ref={inputRef}
                  value={input}
                  onChange={e => {
                    setInput(e.target.value);
                    // auto-grow
                    e.target.style.height = 'auto';
                    e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px';
                  }}
                  onKeyDown={handleKeyDown}
                  placeholder={pendingAttachment?.length ? 'Add a note about this attachment…' : 'Ask anything or give a command…'}
                  rows={1}
                  className="flex-1 bg-transparent text-sm text-slate-700 placeholder-slate-400 outline-none resize-none leading-relaxed"
                  style={{ maxHeight: 120 }}
                />

                {/* Mic inside box */}
                <button
                  onClick={() => setVoiceMode(true)}
                  className="shrink-0 flex size-7 items-center justify-center rounded-lg text-slate-400 hover:text-blue-600 hover:bg-blue-50 transition-colors mb-0.5"
                >
                  <Mic size={15} />
                </button>
              </div>

              {/* Send button */}
              <button
                onClick={handleSend}
                disabled={!canSend && !typing}
                className={`flex size-10 shrink-0 items-center justify-center rounded-xl transition-all ${
                  canSend
                    ? 'bg-blue-600 text-white hover:bg-blue-700 shadow-md active:scale-95'
                    : 'bg-slate-100 text-slate-300 cursor-not-allowed'
                }`}
              >
                <Send size={15} />
              </button>
            </div>

            {/* Keyboard hint */}
            <p className="text-xs text-slate-400 text-center mt-2">
              <kbd className="rounded border border-slate-200 bg-slate-50 px-1 py-0.5 text-slate-500">↵ Enter</kbd> to send &nbsp;·&nbsp; <kbd className="rounded border border-slate-200 bg-slate-50 px-1 py-0.5 text-slate-500">⇧ Shift+Enter</kbd> for new line
            </p>
          </div>
        </div>
      )}

      <style>{`
        @keyframes fadeIn       { from { opacity:0; }              to { opacity:1; } }
        @keyframes fadeSlideUp  { from { opacity:0; transform:translateY(6px); } to { opacity:1; transform:translateY(0); } }
        @keyframes typingBounce { 0%,100%{transform:translateY(0)} 50%{transform:translateY(-4px)} }
        @keyframes waveBar      { from { transform:scaleY(0.4); } to { transform:scaleY(1); } }
        @keyframes pulse        { 0%,100%{opacity:1} 50%{opacity:0.3} }
      `}</style>
    </div>
  );
}

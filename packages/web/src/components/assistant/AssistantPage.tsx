import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { useUser } from '@clerk/clerk-react';
import { apiFetch } from '../../utils/api-fetch';
import { getLocalFlag, setLocalFlag } from '../../lib/uiFlags';
import { firstNameFromUser } from '../../utils/greeting';
import {
  Send, Mic, Paperclip, Sparkles, Check, Zap,
  Square, Image, FileText, X, ThumbsUp, ThumbsDown,
  Copy, ChevronDown, Clock, Briefcase, Receipt, Calendar,
  AlertCircle, Volume2, VolumeX, PhoneCall,
} from 'lucide-react';
import { toast } from 'sonner';
import { VoiceSessionPanel } from './VoiceSessionPanel';
import { useSearchParams } from 'react-router';
import { type Message, type AIProposal } from '../../data/mock-data';
import { AIProposalCard } from '../shared/AIProposalCard';
import { UndoToast } from '../common/UndoToast';
import { useDetailQuery } from '../../hooks/useDetailQuery';
import { useTTS } from '../../hooks/useTTS';
import { useConversationVoice } from '../../hooks/useConversationVoice';
import { useUndoableApproval, type StartUndoInput, type ApproveResponseLike } from '../../hooks/useUndoableApproval';
import { emitProposalsChanged } from '../../lib/proposal-events';
import { reportError, toSafeErrorShape } from '../../lib/errorReporter';

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
  history: Array<{ role: 'user' | 'assistant'; content: string }>,
  inputMode?: 'voice',
): Promise<{ content: string; reasoning?: string; proposal?: AIProposal; autoApplied?: boolean; newConversationId?: string; failed?: boolean }> {
  try {
    // AST-01b: chat → /api/assistant/chat. The server runs intent
    // classification first; recognized actions (e.g. create_customer)
    // come back as a proposal the UI renders inline instead of as free
    // text. Everything else falls through to the generic LLM reply.
    // Story 3.11 — pin the running conversation so each turn persists to the
    // same thread (server opens one on the first turn and echoes its id).
    // UB-B3 — voice-originating turns carry inputMode so the server can
    // refuse voice approval intents deterministically.
    const res = await apiFetch('/api/assistant/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [...history, { role: 'user', content: text }],
        ...(conversationId ? { conversationId } : {}),
        ...(inputMode ? { inputMode } : {}),
      }),
    });

    if (!res.ok) {
      throw new Error(`API error: ${res.status}`);
    }

    const data = await res.json();
    const msg = data.message ?? {};
    return {
      content: msg.content || 'I received your message but could not generate a response.',
      reasoning: msg.reasoning,
      proposal: msg.proposal,
      autoApplied: msg.autoApplied,
      newConversationId: data.conversationId,
    };
  } catch (err) {
    // Network/auth failure reaching the assistant API. Surface an accurate,
    // non-misleading message. OBS-41 — log/report only a safe {name,
    // message} shape, never the raw error object: `err` can be a fetch
    // Response-derived Error whose message embeds the API response body
    // (customer data) or, via apiFetch's 401 retry path, a token.
    const safe = toSafeErrorShape(err);
    console.error('AI chat request failed:', safe);
    reportError(err, 'assistant-chat');
    return {
      content: 'Unable to connect to AI service — please try again or contact support.',
      reasoning: 'Could not reach the AI service.',
      failed: true,
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
function MessageBubble({
  msg,
  isLast,
  onApproved,
}: {
  msg: Message;
  isLast: boolean;
  // Finding 2 — invoked after a proposal approve succeeds so the page can raise
  // the shared undo toast (same affordance as the inbox).
  onApproved?: (input: StartUndoInput) => void;
}) {
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
            <AIProposalCard
              proposal={msg.proposal}
              onApprove={async (edits) => {
                const proposalId = msg.proposal!.id;
                // If the operator edited fields in the card, persist them
                // first via the edit endpoint — the approve endpoint takes
                // no payload and applies the proposal as stored, so without
                // this the edits are silently discarded. Throw on failure so
                // AIProposalCard reverts its optimistic "Approved" state.
                if (edits && Object.keys(edits).length > 0) {
                  const editRes = await apiFetch(`/api/proposals/${proposalId}`, {
                    method: 'PUT',
                    body: JSON.stringify({ edits }),
                  });
                  if (!editRes.ok) {
                    throw new Error(`Saving edits failed: ${editRes.status} ${editRes.statusText}`);
                  }
                }
                // Use apiFetch so the Clerk bearer token is attached — a
                // bare fetch() sends no Authorization header and the
                // backend rejects it with 401. Throw on a non-OK response
                // so AIProposalCard reverts its optimistic "Approved"
                // state and shows an error instead of faking success.
                const response = await apiFetch(`/api/proposals/${proposalId}/approve`, {
                  method: 'POST',
                });
                if (!response.ok) {
                  throw new Error(`Approve failed: ${response.status} ${response.statusText}`);
                }
                // Finding 2 — parity with the inbox: raise the undo toast,
                // anchored to the server's real window (approvedAt /
                // undoExpiresAt ride the approve response).
                const body = (await response.json().catch(() => null)) as ApproveResponseLike | null;
                onApproved?.({
                  proposalId,
                  summary: msg.proposal!.title,
                  response: body,
                });
              }}
              onReject={async () => {
                // Same authenticated client + throw-on-failure contract as
                // approve: AIProposalCard reverts its "Rejected" state and
                // shows an error toast when this rejects.
                const response = await apiFetch(`/api/proposals/${msg.proposal!.id}/reject`, {
                  method: 'POST',
                });
                if (!response.ok) {
                  throw new Error(`Reject failed: ${response.status} ${response.statusText}`);
                }
              }}
            />
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
const MAX_RECORDING_SECONDS = 600;
const VOICE_POLL_INTERVAL_MS = 1500;
const VOICE_POLL_TIMEOUT_MS = 90000;

function isIOSSafari(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  const iOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const webkit = /WebKit/.test(ua);
  const isCriOS = /CriOS/.test(ua);
  const isFxiOS = /FxiOS/.test(ua);
  return iOS && webkit && !isCriOS && !isFxiOS;
}

function getSupportedAudioMimeType(): string | null {
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') {
    return null;
  }
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4',
    'audio/ogg;codecs=opus',
  ];
  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) ?? null;
}

async function createSignedAudioUpload(blob: Blob) {
  const filename = `voice-${Date.now()}.${blob.type.includes('mp4') ? 'm4a' : 'webm'}`;
  // MediaRecorder emits "audio/webm;codecs=opus" but the backend whitelist
  // keys on the base type only. Strip codec params before sending.
  const contentType = (blob.type || 'audio/webm').split(';')[0].trim();
  const body = JSON.stringify({
    filename,
    contentType,
    sizeBytes: blob.size,
    entityType: 'voice_recording',
  });

  const requestSigned = async (url: string) => apiFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });

  let response = await requestSigned('/api/files/upload-url');
  if (!response.ok) {
    response = await requestSigned('/api/files/upload');
  }
  if (!response.ok) {
    throw new Error('Unable to get a signed upload URL.');
  }

  const payload = await response.json();
  const fileId = payload.fileId ?? payload.fileRecord?.id;
  const uploadUrl = payload.uploadUrl;
  const audioUrl = payload.audioUrl ?? payload.downloadUrl ?? payload.fileUrl;

  if (!fileId || !uploadUrl) {
    throw new Error('Upload URL response is missing required fields.');
  }

  const uploadResult = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': contentType },
    body: blob,
  });

  if (!uploadResult.ok) {
    throw new Error('Audio upload failed. Please retry.');
  }

  return { fileId, audioUrl: audioUrl ?? uploadUrl.split('?')[0] };
}

async function pollRecordingUntilDone(recordingId: string) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < VOICE_POLL_TIMEOUT_MS) {
    const res = await apiFetch(`/api/voice/recordings/${recordingId}`, {
      method: 'GET',
    });

    if (!res.ok) {
      throw new Error('Could not fetch transcription status.');
    }

    const status = await res.json();
    if (status.status === 'completed') return status;
    if (status.status === 'failed') {
      throw new Error(status.errorMessage || 'Transcription failed.');
    }

    await new Promise((resolve) => setTimeout(resolve, VOICE_POLL_INTERVAL_MS));
  }

  throw new Error('Transcription is taking longer than expected. Please retry.');
}

function VoiceRecordingBar({ onCancel, onSend }: {
  onCancel: () => void;
  onSend: (transcript: string, duration: number) => void;
}) {
  const [seconds, setSeconds] = useState(0);
  const [phase, setPhase] = useState<'idle' | 'recording' | 'uploading' | 'transcribing'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [canRetry, setCanRetry] = useState(false);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const hasUploadedRef = useRef(false);

  const stopStream = useCallback(() => {
    if (!streamRef.current) return;
    streamRef.current.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }, []);

  const uploadRecording = useCallback(async (blob: Blob, duration: number) => {
    setPhase('uploading');
    try {
      const { fileId, audioUrl } = await createSignedAudioUpload(blob);
      const idempotencyKey = typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `voice-${Date.now()}-${Math.random().toString(16).slice(2)}`;

      const createRes = await apiFetch('/api/voice/recordings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileId, audioUrl, idempotencyKey }),
      });

      if (!createRes.ok) {
        throw new Error('Unable to start transcription.');
      }

      setPhase('transcribing');
      const created = await createRes.json();
      const recordingId = created.recording?.id;
      if (!recordingId) {
        throw new Error('Missing recording id from API.');
      }

      const completed = await pollRecordingUntilDone(recordingId);
      const transcript = (completed.transcript || '').trim();
      if (!transcript) {
        throw new Error('No transcript was returned for this recording.');
      }

      onSend(transcript, duration);
    } catch (err) {
      setPhase('idle');
      const message = err instanceof Error ? err.message : 'Voice upload failed. Please retry.';
      setError(message);
      setCanRetry(true);
    }
  }, [onSend]);

  const stopAndUpload = useCallback(async () => {
    const recorder = mediaRecorderRef.current;
    if (!recorder || recorder.state !== 'recording') return;
    hasUploadedRef.current = true;

    await new Promise<void>((resolve) => {
      recorder.onstop = () => {
        const recordedBlob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' });
        const capturedDuration = seconds;
        stopStream();

        if (!recordedBlob.size) {
          setError('No audio captured. Please retry recording.');
          setCanRetry(true);
          setPhase('idle');
          resolve();
          return;
        }

        void uploadRecording(recordedBlob, capturedDuration).finally(resolve);
      };
      recorder.stop();
    });
  }, [seconds, stopStream, uploadRecording]);

  const startRecording = useCallback(async () => {
    setError(null);
    setCanRetry(false);

    const supportedType = getSupportedAudioMimeType();
    if (!supportedType) {
      setError('This browser does not support a compatible recording format.');
      setCanRetry(true);
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const recorder = new MediaRecorder(stream, { mimeType: supportedType });
      mediaRecorderRef.current = recorder;
      chunksRef.current = [];
      hasUploadedRef.current = false;
      setSeconds(0);
      setPhase('recording');

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };

      recorder.onerror = () => {
        setError('Recording failed. Please retry.');
        setCanRetry(true);
        setPhase('idle');
        stopStream();
      };

      recorder.start(1000);
    } catch {
      setError('Microphone permission is required to record voice messages.');
      setCanRetry(true);
      setPhase('idle');
      stopStream();
    }
  }, [stopStream]);

  useEffect(() => {
    if (phase !== 'recording') return;

    const timer = setInterval(() => {
      setSeconds((prev) => {
        const next = prev + 1;
        if (next >= MAX_RECORDING_SECONDS) {
          setError('Recording is too long. Please stop and retry with a shorter message.');
          setCanRetry(true);
          void stopAndUpload();
        }
        return next;
      });
    }, 1000);

    return () => clearInterval(timer);
  }, [phase, stopAndUpload]);

  useEffect(() => {
    if (phase !== 'recording') return;

    const onVisibilityChange = () => {
      if (!document.hidden || hasUploadedRef.current) return;
      setError('Recording paused when app moved to background. Uploaded partial audio.');
      setCanRetry(true);
      void stopAndUpload();
    };

    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, [phase, stopAndUpload]);

  useEffect(() => {
    return () => {
      const recorder = mediaRecorderRef.current;
      if (recorder?.state === 'recording') recorder.stop();
      stopStream();
    };
  }, [stopStream]);

  const fmt = (s: number) =>
    `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;

  const showIOSBanner = phase === 'recording' && isIOSSafari();

  return (
    <div className="flex flex-col gap-3 px-4 py-3 bg-white border-t border-slate-200">
      {showIOSBanner && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          Keep this screen on and keep Rivet in the foreground while recording (iOS Safari limitation).
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      )}

      {phase === 'idle' && (
        <div className="flex items-center gap-2">
          <button
            onClick={startRecording}
            className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-slate-900 text-white py-3 text-sm hover:bg-slate-700 transition-colors"
          >
            <Mic size={14} /> Start recording
          </button>
          {canRetry && (
            <button
              onClick={startRecording}
              className="flex items-center justify-center gap-1.5 rounded-xl border border-slate-200 bg-white text-slate-700 px-4 py-3 text-sm hover:bg-slate-50 transition-colors"
            >
              Retry
            </button>
          )}
          <button
            onClick={onCancel}
            className="flex items-center justify-center gap-1.5 rounded-xl border border-slate-200 bg-white text-slate-600 px-4 py-3 text-sm hover:bg-slate-50 transition-colors"
          >
            <X size={14} /> Cancel
          </button>
        </div>
      )}

      {phase === 'recording' && (
        <div className="flex items-center gap-3">
          <button onClick={onCancel} className="flex size-10 shrink-0 items-center justify-center rounded-full border border-slate-200 text-slate-400 hover:bg-slate-100 transition-colors">
            <X size={16} />
          </button>

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

          <button
            onClick={() => { void stopAndUpload(); }}
            className="flex size-10 shrink-0 items-center justify-center rounded-full bg-red-500 hover:bg-red-600 active:scale-95 transition-all shadow-md"
          >
            <Square size={14} className="text-white fill-current" />
          </button>
        </div>
      )}

      {(phase === 'uploading' || phase === 'transcribing') && (
        <div className="flex items-center justify-between py-2">
          <div className="flex items-center gap-2">
            <span className="size-1.5 rounded-full bg-violet-500" style={{ animation: 'pulse 0.8s infinite' }} />
            <span className="text-sm text-slate-500">{phase === 'uploading' ? 'Uploading audio…' : 'Transcribing…'}</span>
          </div>
          <div className="flex gap-1">
            {[0, 1, 2].map(i => <span key={i} className="size-1.5 rounded-full bg-violet-300" style={{ animation: `typingBounce 0.9s ease ${i * 0.15}s infinite` }} />)}
          </div>
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
  const { user } = useUser();
  const ownerFirstName = useMemo(
    () => firstNameFromUser(user?.fullName, user?.primaryEmailAddress?.emailAddress),
    [user?.fullName, user?.primaryEmailAddress?.emailAddress],
  );
  const welcomeMessage = useMemo(
    () =>
      ownerFirstName === 'there'
        ? "Hi! I'm your AI assistant. I can help you manage jobs, create estimates, schedule appointments, and more. What can I help you with?"
        : `Hi ${ownerFirstName}! I'm your AI assistant. I can help you manage jobs, create estimates, schedule appointments, and more. What can I help you with?`,
    [ownerFirstName],
  );

  const [messages, setMessages]       = useState<Message[]>([]);
  // Keep the latest messages in a ref so the memoized `send` callback reads
  // the current history, not the snapshot from the render that created it —
  // otherwise from the third turn on, the history POSTed to the assistant is
  // stale and the model loses recent context.
  const messagesRef = useRef<Message[]>([]);
  useEffect(() => { messagesRef.current = messages; }, [messages]);
  const [input, setInput]             = useState('');
  const [typing, setTyping]           = useState(false);
  const [typingReason, setTypingReason] = useState('');
  const [voiceMode, setVoiceMode]     = useState(false);
  const [liveSessionOpen, setLiveSessionOpen] = useState(false);
  const [attachPickerOpen, setAttachPickerOpen] = useState(false);
  const [pendingAttachment, setPendingAttachment] = useState<Message['attachments']>([]);
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  // Story 3.12 — when a turn fails (model/tool/network), keep the failed input
  // so the operator can RETRY in one tap instead of re-typing. Cleared on the
  // next attempt and on success.
  const [failedSend, setFailedSend] = useState<{
    text: string;
    opts?: { inputMode?: 'voice' | 'photo'; voiceDuration?: number; attachments?: Message['attachments'] };
  } | null>(null);
  const [ttsEnabled, setTtsEnabled]   = useState(() => getLocalFlag('rivet:tts-enabled') === 'true');
  const { speak, stop: stopTTS, isSpeaking } = useTTS({ rate: 1.0 });

  // Finding 2 — approval-undo toast, identical to the inbox affordance and
  // driven by the same server-anchored countdown. Fixes the assistant surface
  // approving with NO undo path at all.
  const undoToast = useUndoableApproval({
    requestUndo: (proposalId) =>
      apiFetch(`/api/proposals/${proposalId}/undo`, { method: 'POST' }),
    // Keep the inbox (and any other live surface) in sync after an undo.
    onUndone: () => emitProposalsChanged(),
    onError: (message) => toast.error(message),
  });
  const lastInputWasVoiceRef = useRef(false);
  // UB-B2 — conversation mode. Populated after `send` is defined (the hook
  // needs `send`; `send` needs the session to speak replies through the
  // conversation's TTS so barge-in can cut them off).
  const conversationRef = useRef<{ active: boolean; speak: (text: string) => void } | null>(null);

  const endRef    = useRef<HTMLDivElement>(null);
  const inputRef  = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [searchParams, setSearchParams] = useSearchParams();

  // Derive conversationId from URL param or localStorage
  const conversationId = searchParams.get('conversationId') || getLocalFlag('conversationId') || null;
  const { data: conversation, isLoading: convLoading, error: convError } =
    useDetailQuery<ApiConversation>('/api/conversations', conversationId);

  // Seed messages from API — show the welcome bubble if no conversation
  // exists yet. Journey QA 2026-07-02 (bug 11): this effect re-runs right
  // after every turn (the reply pins newConversationId → refetch), and it
  // used to REPLACE local state unconditionally — a server response with an
  // empty/partial thread wiped the reply the user was reading. Defensive
  // rule (belt-and-braces with the API fix that now returns `messages`):
  // only adopt the server thread when it is AHEAD of what's on screen;
  // never downgrade local messages to an emptier server copy.
  useEffect(() => {
    if (convLoading) return;
    const serverMessages = conversation?.messages ?? [];
    setMessages((prev) => {
      const localTurns = prev.filter((m) => m.id !== 'welcome');
      if (serverMessages.length > localTurns.length) {
        return serverMessages.map(mapApiMessage);
      }
      if (localTurns.length > 0) return prev;
      return [{
        id: 'welcome',
        role: 'assistant' as const,
        content: welcomeMessage,
        time: new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
      }];
    });
  }, [convLoading, conversation, convError, welcomeMessage]);

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
    lastInputWasVoiceRef.current = opts?.inputMode === 'voice';

    const userMsg: Message = {
      id: uid(),
      role: 'user',
      content: text,
      time: t,
      inputMode: opts?.inputMode ?? 'text',
      voiceDuration: opts?.voiceDuration,
      attachments: opts?.attachments,
    };

    // Snapshot prior chat (before the new user message) to send as
    // context — the server expects the current message appended at
    // the end of `messages`, not duplicated. Read from the ref so the
    // history is current even when this memoized callback was created
    // several turns ago.
    const history = messagesRef.current.map((m) => ({ role: m.role, content: m.content }));

    setMessages(prev => [...prev, userMsg]);
    setInput('');
    setPendingAttachment([]);
    setFailedSend(null); // a fresh attempt clears any prior retry affordance
    setTyping(true);
    setTypingReason('Thinking…');

    try {
      const reply = await sendToConversationAPI(
        conversationId,
        text,
        history,
        opts?.inputMode === 'voice' ? 'voice' : undefined,
      );

      // Story 3.11 — pin the server's conversation id so the next turn appends
      // to the same persisted thread (and survives reload).
      if (reply.newConversationId) {
        setLocalFlag('conversationId', reply.newConversationId);
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

      // Story 3.12 — the assistant API swallows transport failures into a
      // degraded reply (failed:true) so the error renders inline; surface a
      // one-tap RETRY for the failed input alongside it.
      if (reply.failed) {
        setFailedSend({ text, opts });
      }

      // Speak the response. In conversation mode the reply goes through the
      // session's TTS (markdown stripped, barge-in interruptible); otherwise
      // keep the existing behavior (TTS toggle or voice-note input).
      if (conversationRef.current?.active && reply.content) {
        conversationRef.current.speak(reply.content);
      } else if ((ttsEnabled || lastInputWasVoiceRef.current) && reply.content) {
        speak(reply.content);
      }
    } catch {
      setMessages(prev => [...prev, {
        id: uid(),
        role: 'assistant',
        content: 'Sorry, something went wrong.',
        time: now(),
      }]);
      // Keep the failed input so the operator can retry in one tap (3.12) —
      // never a silent partial write: nothing was persisted on this turn.
      setFailedSend({ text, opts });
    } finally {
      setTyping(false);
      setTypingReason('');
    }
  }, [conversationId, ttsEnabled, speak]);

  // UB-B2 — conversational voice session: continuous STT, per-utterance
  // auto-submit through the SAME chat path as typed input (inputMode: 'voice'
  // rides the request so the server's voice-approval guard applies), spoken
  // replies, barge-in, 60s silence timeout.
  const voiceConversation = useConversationVoice({
    onSubmit: (text) => { void send(text, { inputMode: 'voice' }); },
  });
  conversationRef.current = voiceConversation;

  const retryFailed = useCallback(() => {
    if (!failedSend) return;
    const { text, opts } = failedSend;
    setFailedSend(null);
    void send(text, opts);
  }, [failedSend, send]);

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
              <h2 className="text-slate-900" style={{ fontSize: '0.95rem' }}>Rivet AI</h2>
              <div className="flex items-center gap-1.5">
                <span className="text-xs text-green-600">Online</span>
                <span className="text-slate-300">·</span>
                <span className="text-xs text-slate-400">Aware of all your jobs & schedule</span>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                const next = !ttsEnabled;
                setTtsEnabled(next);
                setLocalFlag('rivet:tts-enabled', String(next));
                if (!next) stopTTS();
              }}
              className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs transition-colors ${
                ttsEnabled
                  ? 'border-indigo-200 bg-indigo-50 text-indigo-600'
                  : 'border-slate-200 bg-white text-slate-400 hover:bg-slate-50'
              }`}
              title={ttsEnabled ? 'Voice responses on' : 'Voice responses off'}
            >
              {ttsEnabled ? <Volume2 size={12} /> : <VolumeX size={12} />}
              {isSpeaking && <span className="size-1.5 rounded-full bg-indigo-400 animate-pulse" />}
            </button>
            {/* UB-B2 — conversation-mode toggle (≥44px tap target) */}
            <button
              onClick={() => (voiceConversation.active ? voiceConversation.stop() : void voiceConversation.start())}
              title={voiceConversation.active ? 'End conversation mode' : 'Start conversation mode'}
              aria-pressed={voiceConversation.active}
              disabled={!voiceConversation.supported}
              className={`flex items-center gap-1.5 min-h-11 rounded-lg border px-3 text-xs transition-colors disabled:opacity-40 ${
                voiceConversation.active
                  ? 'border-green-300 bg-green-50 text-green-700'
                  : 'border-slate-200 bg-white text-slate-500 hover:bg-slate-50'
              }`}
            >
              <Mic size={12} /> {voiceConversation.active ? 'Listening' : 'Conversation'}
              {voiceConversation.active && <span className="size-1.5 rounded-full bg-green-500 animate-pulse" />}
            </button>
            <button
              onClick={() => setLiveSessionOpen(v => !v)}
              title="Live voice session"
              className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs transition-colors ${
                liveSessionOpen
                  ? 'border-blue-300 bg-blue-50 text-blue-700'
                  : 'border-slate-200 bg-white text-slate-500 hover:bg-slate-50'
              }`}
            >
              <PhoneCall size={12} /> Live session
            </button>
            <button className="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-500 hover:bg-slate-50 transition-colors">
              <ChevronDown size={12} /> Context
            </button>
          </div>
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
            <MessageBubble
              key={msg.id}
              msg={msg}
              isLast={i === messages.length - 1}
              onApproved={undoToast.start}
            />
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

      {/* ── Retry strip (Story 3.12) — surfaced when a turn fails ── */}
      {failedSend && !typing && (
        <div className="shrink-0 bg-white border-t border-slate-100 px-4 md:px-6 py-2">
          <div className="max-w-3xl mx-auto flex items-center justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2">
            <div className="flex items-center gap-2 min-w-0">
              <AlertCircle size={14} className="text-amber-600 shrink-0" />
              <span className="text-sm text-amber-800 truncate">
                Couldn’t reach the assistant.
              </span>
            </div>
            <button
              type="button"
              onClick={retryFailed}
              className="flex items-center gap-1.5 min-h-11 rounded-lg bg-amber-600 px-3 text-sm text-white hover:bg-amber-700 transition-colors shrink-0"
            >
              Retry
            </button>
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

            {/* UB-B2 — live partial transcript while conversation mode listens */}
            {voiceConversation.active && (
              <div
                data-testid="conversation-live-partial"
                className="flex items-center gap-2 mb-2 rounded-xl border border-green-200 bg-green-50 px-3 py-2.5"
              >
                <Mic size={13} className="text-green-600 shrink-0" />
                <span className="text-sm text-green-800 italic truncate">
                  {voiceConversation.partial || 'Listening…'}
                </span>
                {voiceConversation.isSpeaking && (
                  <span className="ml-auto flex items-center gap-1 text-xs text-green-600 shrink-0">
                    <Volume2 size={12} /> Speaking — talk to interrupt
                  </span>
                )}
              </div>
            )}

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

      {/* ── Live voice session panel (P8-009) ───────────────── */}
      {liveSessionOpen && (
        <div className="fixed bottom-24 right-6 z-50 w-96">
          <VoiceSessionPanel />
        </div>
      )}

      {/* Finding 2 — approval-undo toast (same component + server-driven window
          as the inbox), so approving in the assistant is undoable too. */}
      {undoToast.isActive && (
        <UndoToast
          summary={undoToast.summary}
          remainingMs={undoToast.remainingMs}
          windowMs={undoToast.windowMs}
          onUndo={() => void undoToast.undo()}
          onDismiss={undoToast.dismiss}
        />
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

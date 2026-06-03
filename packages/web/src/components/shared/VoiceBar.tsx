import { useState, useEffect, useRef, useCallback, useImperativeHandle, forwardRef } from 'react';
import { Mic, X, Send, Sparkles } from 'lucide-react';
import { useNavigate } from 'react-router';
import { apiFetch } from '../../utils/api-fetch';
import { matchVoiceCommand } from '../../hooks/useVoiceCommands';
import { useTTS } from '../../hooks/useTTS';

type BarPhase = 'idle' | 'listening' | 'transcribing' | 'transcript' | 'sending';

export interface VoiceBarHandle {
  /** Programmatically start listening (e.g. from a keyboard shortcut) */
  activate: () => void;
}

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

const VOICE_POLL_INTERVAL_MS = 1500;
const VOICE_POLL_TIMEOUT_MS = 90000;

function isIOSSafari(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  const iOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const webkit = /WebKit/.test(ua);
  return iOS && webkit && !/CriOS|FxiOS/.test(ua);
}

function getSupportedAudioMimeType(): string | null {
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') return null;
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
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
  if (!response.ok) throw new Error('Unable to get a signed upload URL.');

  const payload = await response.json();
  const fileId = payload.fileId ?? payload.fileRecord?.id;
  const uploadUrl = payload.uploadUrl;
  const downloadUrl = payload.downloadUrl ?? payload.audioUrl ?? payload.fileUrl;

  if (!fileId || !uploadUrl) throw new Error('Upload URL response is missing required fields.');

  // Content-Type must match what was signed server-side — we used the
  // normalized (no-codec-params) value in the upload-url request, so
  // echo that here.
  const uploadResult = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': contentType },
    body: blob,
  });

  if (!uploadResult.ok) throw new Error('Audio upload failed. Please retry.');

  return { fileId, audioUrl: downloadUrl ?? uploadUrl.split('?')[0] };
}

async function pollRecordingUntilDone(recordingId: string) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < VOICE_POLL_TIMEOUT_MS) {
    const res = await apiFetch(`/api/voice/recordings/${recordingId}`);
    if (!res.ok) throw new Error('Could not fetch transcription status.');

    const status = await res.json();
    if (status.status === 'completed') return status;
    if (status.status === 'failed') throw new Error(status.errorMessage || 'Transcription failed.');

    await new Promise((resolve) => setTimeout(resolve, VOICE_POLL_INTERVAL_MS));
  }
  throw new Error('Transcription timed out. Please retry.');
}

interface VoiceBarProps {
  variant?: 'mobile' | 'desktop';
}

export const VoiceBar = forwardRef<VoiceBarHandle, VoiceBarProps>(function VoiceBar({ variant = 'mobile' }, ref) {
  const navigate = useNavigate();
  const [phase, setPhase] = useState<BarPhase>('idle');
  const [transcript, setTranscript] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [canRetry, setCanRetry] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const { speak } = useTTS({ rate: 1.05 });

  // Expose imperative handle so parent (Shell) can trigger via keyboard shortcut
  useImperativeHandle(ref, () => ({
    activate: () => { if (phase === 'idle') startListening(); },
  }), [phase]);
  const stoppingRef = useRef(false);

  const stopStream = useCallback(() => {
    if (!streamRef.current) return;
    streamRef.current.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }, []);

  const uploadAndTranscribe = useCallback(async (audioBlob: Blob) => {
    const { fileId, audioUrl } = await createSignedAudioUpload(audioBlob);
    // Reconcile declared vs. actual uploaded size. The signed URL does not
    // bind content length, so the API HEADs the object and rejects over-max
    // payloads. A non-2xx here means the upload exceeded the size ceiling
    // or storage was otherwise unhappy; treat it as a hard failure.
    const verifyRes = await apiFetch(`/api/files/${fileId}/verify`, {
      method: 'POST',
    });
    if (!verifyRes.ok) throw new Error('Upload verification failed.');
    const idempotencyKey = typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `voice-${Date.now()}-${Math.random().toString(16).slice(2)}`;

    const createRes = await apiFetch('/api/voice/recordings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileId, audioUrl, idempotencyKey }),
    });

    if (!createRes.ok) throw new Error('Unable to start transcription.');

    const created = await createRes.json();
    const recordingId = created.recording?.id;
    if (!recordingId) throw new Error('Missing recording id from API.');

    const completed = await pollRecordingUntilDone(recordingId);
    return (completed.transcript || '').trim();
  }, []);

  const stopListening = useCallback(async () => {
    const recorder = mediaRecorderRef.current;
    if (!recorder || recorder.state !== 'recording' || stoppingRef.current) return;

    stoppingRef.current = true;
    setPhase('transcribing');

    await new Promise<void>((resolve) => {
      recorder.onstop = () => {
        const audioBlob = new Blob(audioChunksRef.current, { type: recorder.mimeType || 'audio/webm' });
        stopStream();

        if (!audioBlob.size) {
          setError('No audio captured. Please retry.');
          setCanRetry(true);
          setPhase('idle');
          stoppingRef.current = false;
          resolve();
          return;
        }

        void uploadAndTranscribe(audioBlob)
          .then((text) => {
            if (!text) {
              setError('No transcript was returned. Please retry.');
              setCanRetry(true);
              setPhase('idle');
            } else {
              setTranscript(text);
              setPhase('transcript');
            }
          })
          .catch((err) => {
            setError(err instanceof Error ? err.message : 'Transcription failed.');
            setCanRetry(true);
            setPhase('idle');
          })
          .finally(() => {
            stoppingRef.current = false;
            resolve();
          });
      };
      recorder.stop();
    });
  }, [stopStream, uploadAndTranscribe]);

  const startListening = useCallback(async () => {
    setError(null);
    setCanRetry(false);
    setTranscript('');

    const mimeType = getSupportedAudioMimeType();
    if (!mimeType) {
      setError('This browser does not support a compatible recording format.');
      setCanRetry(true);
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const recorder = new MediaRecorder(stream, { mimeType });
      mediaRecorderRef.current = recorder;
      audioChunksRef.current = [];
      stoppingRef.current = false;

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) audioChunksRef.current.push(event.data);
      };

      recorder.onerror = () => {
        stopStream();
        setError('Recording failed. Please retry.');
        setCanRetry(true);
        setPhase('idle');
      };

      recorder.start(1000);
      setPhase('listening');
    } catch {
      setError('Microphone permission is required to record voice messages.');
      setCanRetry(true);
      setPhase('idle');
      stopStream();
    }
  }, [stopStream]);

  useEffect(() => {
    if (phase !== 'listening') return;

    const onVisibilityChange = () => {
      if (!document.hidden) return;
      setError('Recording paused in background. Uploaded partial audio.');
      setCanRetry(true);
      void stopListening();
    };

    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, [phase, stopListening]);

  useEffect(() => {
    if (phase === 'transcript') {
      setTimeout(() => inputRef.current?.focus(), 80);
    }
  }, [phase]);

  useEffect(() => () => {
    const recorder = mediaRecorderRef.current;
    if (recorder?.state === 'recording') recorder.stop();
    stopStream();
  }, [stopStream]);

  function handleSend() {
    if (!transcript.trim()) return;

    // Check for voice navigation commands first
    const command = matchVoiceCommand(transcript.trim());
    if (command) {
      setPhase('sending');
      speak(command.label);
      setTimeout(() => {
        navigate(command.route);
        setPhase('idle');
        setTranscript('');
      }, 420);
      return;
    }

    // Fall through to assistant
    setPhase('sending');
    setTimeout(() => {
      navigate(`/assistant?q=${encodeURIComponent(transcript.trim())}`);
      setPhase('idle');
      setTranscript('');
      setError(null);
      setCanRetry(false);
    }, 420);
  }

  function handleCancel() {
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state === 'recording') {
      recorder.stop();
    }
    stopStream();
    setPhase('idle');
    setTranscript('');
    setError(null);
  }

  const isDesktop = variant === 'desktop';
  const containerClass = isDesktop
    ? 'px-3 py-2.5'
    : 'px-3 py-2.5 bg-white border-t border-slate-100';

  return (
    <div className={containerClass}>
      {phase === 'listening' && isIOSSafari() && (
        <div className="mb-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          Keep this screen on and keep Rivet in the foreground while recording (iOS Safari limitation).
        </div>
      )}

      {error && (
        <div className="mb-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          {error}
          {canRetry && (
            <button onClick={startListening} className="ml-2 underline text-red-800">Retry</button>
          )}
        </div>
      )}

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
          <span className="text-sm text-slate-400 flex-1">Ask Rivet AI anything…</span>
          <span className="text-xs text-slate-300">tap to speak</span>
        </button>
      )}

      {phase === 'listening' && (
        <div className={`
          flex items-center gap-3 rounded-2xl border border-blue-200 bg-blue-50
          px-4 transition-all
          ${isDesktop ? 'py-2.5' : 'py-3'}
        `}>
          <span className="flex shrink-0 size-7 items-center justify-center rounded-full bg-blue-600">
            <span className="size-2.5 rounded-full bg-white" style={{ animation: 'liveDot 1s ease-in-out infinite' }} />
          </span>
          <div className="flex-1 flex items-center gap-3 min-w-0">
            <span className="text-sm text-blue-700 shrink-0">Listening…</span>
            <div className="flex-1"><Waveform /></div>
          </div>
          <button
            onClick={() => { void stopListening(); }}
            className="shrink-0 flex size-7 items-center justify-center rounded-full bg-blue-600 text-white hover:bg-blue-700 transition-colors"
          >
            <Send size={13} />
          </button>
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

      {phase === 'transcribing' && (
        <div className={`
          flex items-center gap-3 rounded-2xl border border-blue-100 bg-blue-50
          px-4
          ${isDesktop ? 'py-2.5' : 'py-3'}
        `}>
          <Sparkles size={16} className="text-blue-500 shrink-0" style={{ animation: 'spin 1.2s linear infinite' }} />
          <span className="text-sm text-blue-700 flex-1">Uploading & transcribing…</span>
          <div className="flex gap-1 shrink-0">
            {[0, 1, 2].map(i => (
              <span key={i} className="size-1.5 rounded-full bg-blue-400 animate-bounce" style={{ animationDelay: `${i * 120}ms` }} />
            ))}
          </div>
          <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
        </div>
      )}

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
        </div>
      )}
    </div>
  );
});

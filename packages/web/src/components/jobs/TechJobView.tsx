import { useState, useEffect, useRef, useCallback } from 'react';
import {
  ArrowLeft, Navigation, Phone, MapPin, Clock,
  CheckCircle2, FileText, Camera, Mic,
  AlertTriangle, X, Zap, StopCircle,
  Sparkles, ChevronDown, ChevronUp, RotateCcw,
  MessageSquare, Check, Pencil,
} from 'lucide-react';
import { Link, useNavigate } from 'react-router';
import { Textarea, ConfirmDialog } from '../ui';
import { ActivityTimeline } from './ActivityTimeline';
import { CancelNoShowSheet } from './CancelNoShowSheet';
import { CallScreen, TextSheet } from './JobSheets';
import { CameraCapture } from '../shared/CameraCapture';
import type { CapturedMedia } from '../shared/CameraCapture';
import { useApiClient } from '../../lib/apiClient';
import { useTenantTimezone } from '../../hooks/useTenantTimezone';
import { formatDateInTenantTz, formatTimeInTenantTz } from '../../utils/formatInTenantTz';
import type { JobActivity, ServiceType } from '../../types/job-ui';
import {
  needsFieldNote,
  sendTechVoiceUpdate,
  suggestTechStatus,
  type TechStatus,
  type TechVoiceOutcome,
} from './tech-voice';
import { JobPhotoGallery } from './JobPhotoGallery';
import {
  uploadJobPhoto as uploadJobPhotoApi,
  listJobPhotos as listJobPhotosApi,
  deleteJobPhoto as deleteJobPhotoApi,
  type JobPhoto,
  type JobPhotoCategory,
} from '../../api/job-photos';
import { capturedMediaToFile } from './capturedMediaToFile';

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
type VoiceState  = 'idle' | 'recording' | 'processing' | 'result';
type TechSheet   = 'cancel' | 'call' | 'text' | 'camera' | null;

interface FieldNote  { id: string; text: string; time: string; source: 'voice' | 'typed'; }
interface VoiceResult {
  transcript: string;
  durationSeconds: number;
  /** Ticked on the confirm card; unticked means leave the status alone. */
  statusUpdate?: TechStatus;
  /** The confirm card offered a status for these words, ticked or not. */
  statusOffered: boolean;
}

// ─── Status flow ───────────────────────────────────────────────────────────────
interface StatusStep {
  key: TechStatus; label: string; cta: string;
  dotColor: string; ctaBg: string;
  apiStatus: string;
}

// Linear field path. 'waiting' is a branch off in_progress (WAITING_STEP
// below), never a step the primary CTA advances into — with it in the linear
// flow, "Mark Complete" landed on "Waiting for Parts" and posted an invalid
// in_progress→in_progress self-transition.
const STATUS_FLOW: StatusStep[] = [
  { key: 'en_route',    label: 'En Route',          cta: "I've Arrived",    dotColor: 'bg-primary',   ctaBg: 'bg-primary   hover:bg-primary/90',   apiStatus: 'in_progress' },
  { key: 'on_site',     label: 'On Site',            cta: 'Start Job',       dotColor: 'bg-success',  ctaBg: 'bg-success  hover:bg-success/90',  apiStatus: 'in_progress' },
  { key: 'in_progress', label: 'In Progress',        cta: 'Mark Complete',   dotColor: 'bg-primary', ctaBg: 'bg-primary hover:bg-primary/90', apiStatus: 'in_progress' },
  { key: 'complete',    label: 'Complete',            cta: '',                dotColor: 'bg-success',  ctaBg: '', apiStatus: 'completed' },
];

// Entered only via an explicit status update (e.g. voice "waiting on parts").
// Resuming returns to in_progress locally — the job never left in_progress
// server-side, so no transition is posted.
const WAITING_STEP: StatusStep = {
  key: 'waiting', label: 'Waiting for Parts', cta: 'Resume Job',
  dotColor: 'bg-warning', ctaBg: 'bg-warning  hover:bg-warning/90',
  apiStatus: 'in_progress',
};

function statusStep(key: TechStatus): StatusStep {
  return STATUS_FLOW.find(s => s.key === key) ?? WAITING_STEP;
}

// Map API status → TechStatus
function apiStatusToTech(status: string): TechStatus {
  if (status === 'completed') return 'complete';
  if (status === 'in_progress') return 'in_progress';
  if (status === 'scheduled') return 'en_route';
  return 'en_route';
}

/**
 * #1122 — default the still-camera capture category off the job's own
 * status instead of hardcoding 'before': not started (scheduled) yields
 * 'before', in progress/done yields 'after'. Videos keep the pre-existing
 * 'other' category (out of scope for this change).
 */
function defaultPhotoCategoryForJobStatus(status: string): JobPhotoCategory {
  return status === 'scheduled' ? 'before' : 'after';
}

// ─── Waveform ──────────────────────────────────────────────────────────────────
function Waveform({ active }: { active: boolean }) {
  return (
    <div className="flex items-center justify-center gap-[3px] h-7">
      {Array.from({ length: 24 }).map((_, i) => (
        <div key={i}
          className={`w-[2.5px] rounded-full ${active ? 'bg-destructive' : 'bg-muted'}`}
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
// One spoken update: transcribed, shown back for a quick edit, then handed to
// the assistant with this job pinned (tech-voice.ts). The only thing decided
// here is a suggested status change, which the tech can untick.
function VoiceHero({
  onResult,
  apiFetch,
  reply,
}: {
  onResult: (r: VoiceResult) => Promise<void>;
  apiFetch: (url: string, init?: RequestInit) => Promise<Response>;
  /** The assistant's answer to the last update, shown under the mic. */
  reply: string | null;
}) {
  const [phase,   setPhase]   = useState<VoiceState>('idle');
  const [seconds, setSeconds] = useState(0);
  const [transcript, setTranscript] = useState('');
  const [suggested, setSuggested] = useState<TechStatus | undefined>(undefined);
  const [applyStatus, setApplyStatus] = useState(true);
  const [sending, setSending] = useState(false);
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
          const text = data.transcript?.trim() ?? '';
          if (text) {
            setTranscript(text);
            setSuggested(suggestTechStatus(text));
            setApplyStatus(true);
            setPhase('result');
            return;
          }
        }
      } catch {
        // Reported below.
      }
      // Never save a placeholder in the tech's name: say what happened.
      setMicError("Couldn't transcribe that, and nothing was saved. Please try again.");
      setPhase('idle');
    };

    if (mr.state !== 'inactive') mr.stop();
  }

  // The suggestion always follows the words being sent: fixing "all done" to
  // "not done, waiting on parts" must not still complete the job.
  function editTranscript(value: string) {
    setTranscript(value);
    const next = suggestTechStatus(value);
    if (next !== suggested) {
      setSuggested(next);
      setApplyStatus(true);
    }
  }

  async function confirm() {
    const text = transcript.trim();
    if (!text || sending) return;
    setSending(true);
    try {
      await onResult({
        transcript: text,
        durationSeconds: seconds,
        statusOffered: suggested !== undefined,
        ...(suggested && applyStatus ? { statusUpdate: suggested } : {}),
      });
    } finally {
      setSending(false);
      setPhase('idle');
      setTranscript('');
    }
  }
  function discard() { setPhase('idle'); setTranscript(''); }

  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

  if (phase === 'idle') return (
    <div className="flex flex-col items-center gap-4 py-6">
      {micError && (
        <div role="alert" className="rounded-lg bg-destructive/10 border border-destructive/30 px-3 py-2 text-xs text-destructive">
          {micError}
        </div>
      )}
      <button onClick={() => void startRecording()}
        className="group relative flex flex-col items-center gap-2.5">
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="size-24 rounded-full bg-primary/5 scale-0 group-hover:scale-100 transition-transform duration-300" />
        </div>
        <div className="relative flex size-20 items-center justify-center rounded-full bg-primary shadow-xl shadow-border/25
          hover:bg-primary/90 active:scale-95 transition-all">
          <Mic size={28} className="text-primary-foreground" />
        </div>
        <div className="text-center">
          <p className="text-sm text-foreground">Tap to add by voice</p>
          <p className="text-xs text-muted-foreground mt-0.5">note · parts &amp; labor · quote · status</p>
        </div>
      </button>
      {reply && (
        <div data-testid="tech-voice-reply" className="w-full flex items-start gap-2.5 rounded-xl border border-primary/20 bg-primary/10 px-3.5 py-2.5">
          <Sparkles size={13} className="text-primary shrink-0 mt-0.5" />
          <p className="text-sm text-foreground leading-snug break-words min-w-0">{reply}</p>
        </div>
      )}
    </div>
  );

  if (phase === 'recording') return (
    <div className="flex flex-col items-center gap-3 py-5">
      <div className="flex items-center gap-2">
        <span className="size-2.5 rounded-full bg-destructive animate-pulse" />
        <span className="text-sm text-destructive">{fmt(seconds)} · Listening…</span>
      </div>
      <Waveform active />
      <button onClick={stopRecording}
        className="flex items-center gap-2 min-h-11 bg-destructive text-primary-foreground rounded-full px-6 py-2.5 text-sm hover:bg-destructive/90 active:scale-95 transition-all shadow-lg shadow-destructive/30">
        <StopCircle size={15} /> Done talking
      </button>
      <p className="text-xs text-muted-foreground">Auto-stops at 30s</p>
    </div>
  );

  if (phase === 'processing') return (
    <div className="flex flex-col items-center gap-3 py-8">
      <div className="flex size-10 items-center justify-center rounded-full bg-primary/15">
        <Sparkles size={18} className="text-primary animate-pulse" />
      </div>
      <p className="text-sm text-foreground">Transcribing…</p>
    </div>
  );

  if (phase === 'result') return (
    <div className="flex flex-col gap-3 py-3" style={{ animation: 'fadeUp 0.2s ease' }}>
      <label className="flex flex-col gap-1.5">
        <span className="text-xs text-muted-foreground">What you said (edit if needed)</span>
        <Textarea
          value={transcript}
          onChange={(e) => editTranscript(e.target.value)}
          aria-label="What you said"
          rows={3}
          className="text-sm"
        />
      </label>

      {suggested && (
        <label className="flex items-center gap-3 min-h-11 rounded-xl border border-primary/20 bg-primary/10 px-4">
          <input
            type="checkbox"
            checked={applyStatus}
            onChange={(e) => setApplyStatus(e.target.checked)}
            className="size-5 accent-primary"
          />
          <span className="text-sm text-primary">
            Also mark the job: <span className="font-medium">{statusStep(suggested).label}</span>
          </span>
        </label>
      )}

      <p className="text-xs text-muted-foreground">
        Rivet drafts anything that needs a price or a send (parts, labor, quotes) for review. Your words are saved as a job note.
      </p>

      <div className="flex gap-2">
        <button onClick={discard} disabled={sending}
          className="flex items-center gap-1.5 min-h-11 rounded-xl border border-border px-3 text-sm text-foreground hover:bg-secondary transition-colors disabled:opacity-50">
          <RotateCcw size={12} /> Discard
        </button>
        <button onClick={() => void confirm()} disabled={sending || !transcript.trim()}
          className="flex-1 flex items-center justify-center gap-1.5 min-h-11 rounded-xl bg-primary text-primary-foreground text-sm hover:bg-primary/90 transition-colors disabled:opacity-50">
          <Check size={14} /> {sending ? 'Sending…' : 'Send to Rivet'}
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
    <div className="rounded-2xl bg-card border border-border overflow-hidden">
      <button onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-3 px-4 py-3.5 text-left hover:bg-secondary transition-colors">
        <div className="flex size-7 items-center justify-center rounded-lg bg-secondary shrink-0">
          <FileText size={13} className="text-foreground" />
        </div>
        <p className="flex-1 text-sm text-foreground">Notes</p>
        {notes.length > 0 && (
          <span className="text-xs bg-secondary text-foreground rounded-full px-2 py-0.5">{notes.length}</span>
        )}
        {open ? <ChevronUp size={14} className="text-muted-foreground shrink-0" /> : <ChevronDown size={14} className="text-muted-foreground shrink-0" />}
      </button>

      {open && (
        <div className="border-t border-border">
          {notes.length === 0 && !typing && (
            <p className="text-xs text-muted-foreground px-4 py-3 italic">No notes yet — use voice or type below</p>
          )}
          {notes.map((n, i) => (
            <div key={n.id} className={`flex items-start gap-3 px-4 py-3 ${i > 0 ? 'border-t border-border' : ''}`}>
              <div className={`flex size-6 items-center justify-center rounded-full shrink-0 mt-0.5 ${
                n.source === 'voice' ? 'bg-primary/15' : 'bg-secondary'
              }`}>
                {n.source === 'voice'
                  ? <Mic size={10} className="text-primary" />
                  : <Pencil size={10} className="text-muted-foreground" />
                }
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm text-foreground leading-relaxed">{n.text}</p>
                <p className="text-xs text-muted-foreground mt-0.5">{n.time}</p>
              </div>
            </div>
          ))}
          {typing ? (
            <div className="border-t border-border p-3 flex flex-col gap-2">
              <Textarea
                autoFocus value={draft} onChange={e => setDraft(e.target.value)}
                placeholder="Type your note…" rows={3}
                className="min-h-11 resize-none"
                onKeyDown={e => { if (e.key === 'Enter' && e.metaKey) submit(); }}
              />
              <div className="flex gap-2">
                <button onClick={() => { setTyping(false); setDraft(''); }}
                  className="flex-1 rounded-xl border border-border py-2 text-sm text-foreground hover:bg-secondary">
                  Cancel
                </button>
                <button onClick={submit} disabled={!draft.trim()}
                  className="flex-1 rounded-xl bg-primary text-primary-foreground py-2 text-sm disabled:opacity-40 hover:bg-primary/90">
                  Add note
                </button>
              </div>
            </div>
          ) : (
            <div className="border-t border-border px-4 py-2.5">
              <button onClick={() => setTyping(true)}
                className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors">
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
function PhotosSection({
  jobId,
  photos,
  category,
  onCategoryChange,
  onAdd,
  onDelete,
  saving,
  error,
}: {
  jobId: string;
  photos: JobPhoto[];
  category: JobPhotoCategory | 'all';
  onCategoryChange: (next: JobPhotoCategory | 'all') => void;
  onAdd: () => void;
  onDelete: (photo: JobPhoto) => void;
  saving: boolean;
  error: string | null;
}) {
  const [open, setOpen] = useState(true);

  return (
    <div className="rounded-2xl bg-card border border-border overflow-hidden">
      <button onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-3 px-4 py-3.5 text-left hover:bg-secondary transition-colors min-h-11">
        <div className="flex size-7 items-center justify-center rounded-lg bg-primary/15 shrink-0">
          <Camera size={13} className="text-primary" />
        </div>
        <p className="flex-1 text-sm text-foreground">Photos</p>
        {photos.length > 0 && (
          <span className="text-xs bg-primary/15 text-primary rounded-full px-2 py-0.5">{photos.length}</span>
        )}
        {open ? <ChevronUp size={14} className="text-muted-foreground shrink-0" /> : <ChevronDown size={14} className="text-muted-foreground shrink-0" />}
      </button>

      {open && (
        <div className="border-t border-border p-3">
          {error && (
            <p data-testid="tech-photo-error" role="alert" className="mb-2 text-sm text-destructive">
              {error}
            </p>
          )}
          <button
            onClick={onAdd}
            disabled={saving}
            className="mb-3 w-full min-h-11 rounded-xl border-2 border-dashed border-border flex items-center justify-center gap-2 hover:border-primary hover:bg-primary/10 active:bg-primary/15 transition-colors disabled:opacity-50"
          >
            <Camera size={16} className="text-muted-foreground" />
            <span className="text-sm text-muted-foreground">{saving ? 'Saving…' : 'Add photo'}</span>
          </button>
          <JobPhotoGallery
            photos={photos}
            activeCategory={category}
            onCategoryChange={onCategoryChange}
            onDelete={onDelete}
          />
          {/* #1122 — the technician's photo surface: category select +
              before/after pairing live on the full gallery page, not here. */}
          <Link
            to={`/jobs/${jobId}/photos`}
            className="mt-3 flex min-h-11 w-full items-center justify-center gap-1.5 rounded-xl border border-border text-sm text-primary hover:bg-secondary transition-colors"
          >
            Open full photo gallery <span aria-hidden="true">→</span>
          </Link>
        </div>
      )}
    </div>
  );
}

// ─── SVC config maps ────────────────────────────────────────────────────────────
const SVC_ICON: Record<string, string> = { HVAC: '❄️', Plumbing: '🔧', Painting: '🎨' };
const SVC_BG: Record<string, string> = {
  HVAC:     'bg-primary/40',
  Plumbing: 'bg-success/40',
  Painting: 'bg-primary/40',
};
const DELAY_OPTIONS = [10, 15, 20, 60] as const;
type DelayOption = (typeof DELAY_OPTIONS)[number];

// ─── Main page ──────────────────────────────────────────────────────────────────
export interface TechJobViewProps {
  id: string;
  /** Test seams for the persisted photo pipeline (default to the real API). */
  uploadPhoto?: (
    jobId: string,
    file: File,
    category: JobPhotoCategory,
    notes?: string,
    takenAt?: string,
  ) => Promise<JobPhoto>;
  fetchPhotos?: (jobId: string) => Promise<JobPhoto[]>;
  deletePhoto?: (jobId: string, photoId: string) => Promise<void>;
}

export function TechJobView({
  id,
  uploadPhoto = uploadJobPhotoApi,
  fetchPhotos = listJobPhotosApi,
  deletePhoto = deleteJobPhotoApi,
}: TechJobViewProps) {
  const navigate = useNavigate();
  const apiFetch = useApiClient();
  const timezone = useTenantTimezone();

  const [jobData, setJobData] = useState<ApiJobDetail | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [techStatus, setTechStatus] = useState<TechStatus>('on_site');
  const [statusError, setStatusError] = useState<string | null>(null);
  const [sheet,      setSheet]      = useState<TechSheet>(null);
  const [activities, setActivities] = useState<JobActivity[]>([]);
  const [voiceReply, setVoiceReply] = useState<string | null>(null);
  // U9 (E7): persisted photos load from the backend and refetch after capture.
  const [photos,       setPhotos]       = useState<JobPhoto[]>([]);
  const [photoCategory, setPhotoCategory] = useState<JobPhotoCategory | 'all'>('all');
  const [photoError,   setPhotoError]   = useState<string | null>(null);
  const [photoSaving,  setPhotoSaving]  = useState(false);
  const [notes,   setNotes]   = useState<FieldNote[]>([]);
  const [cameraOpen, setCam] = useState(false);
  const [isRunningBehind, setIsRunningBehind] = useState<boolean | null>(null);
  const [delayMinutes, setDelayMinutes] = useState<DelayOption | null>(null);
  // #1135 — the appointment this job's chip row confirms against. Jobs don't
  // carry an appointmentId column; POST /:apptId/running-late needs the
  // appointment id, not the job id, so it's resolved once on mount via the
  // existing jobId-filtered appointments list (technicians already hold
  // `appointments:view`, the same permission that route requires).
  const [appointmentId, setAppointmentId] = useState<string | null>(null);
  const [delaySending, setDelaySending] = useState(false);
  const [delayError, setDelayError] = useState<string | null>(null);

  // #1135 — resolve the appointment backing this job so the delay chips have
  // something to confirm against. GET /api/appointments?jobId=<id> is the
  // existing legacy (bare-array) contract; pick the latest non-canceled
  // appointment, falling back to whatever comes back if all are canceled.
  const loadAppointment = useCallback(async () => {
    try {
      const res = await apiFetch(`/api/appointments?jobId=${id}`);
      if (!res.ok) return;
      const list = await res.json() as Array<{ id: string; status?: string }>;
      if (!Array.isArray(list) || list.length === 0) return;
      const active = list.find((a) => a.status !== 'canceled') ?? list[0];
      setAppointmentId(active.id);
    } catch {
      // Non-critical for page load — the chip tap surfaces its own error
      // if it can't find an appointment to confirm against.
    }
  }, [apiFetch, id]);

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
      // GET /api/notes returns a bare array (packages/api/src/routes/notes.ts)
      const data = await res.json() as ApiNote[];
      const apiNotes = data.map<FieldNote>(n => ({
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

  // U9 (E7): load persisted job photos; refetch after each capture.
  const loadPhotos = useCallback(async () => {
    try {
      setPhotos(await fetchPhotos(id));
    } catch (err) {
      setPhotoError(err instanceof Error ? err.message : 'Failed to load photos');
    }
  }, [fetchPhotos, id]);

  // U2 (E9 follow-up): delete a wrong photo/video behind a confirm. On success
  // drop the row from local state; on failure surface the error and keep the
  // photo (no phantom removal). The DELETE endpoint audits + gates server-side.
  // #907 — window.confirm replaced with ConfirmDialog: `handleDeletePhoto`
  // (the gallery's onDelete) now only stages the target; `confirmDeletePhoto`
  // runs the actual delete once the dialog is confirmed.
  const [pendingDeletePhoto, setPendingDeletePhoto] = useState<JobPhoto | null>(null);

  const handleDeletePhoto = useCallback((photo: JobPhoto) => {
    setPendingDeletePhoto(photo);
  }, []);

  const confirmDeletePhoto = useCallback(async () => {
    const photo = pendingDeletePhoto;
    setPendingDeletePhoto(null);
    if (!id || !photo) return;
    setPhotoError(null);
    try {
      await deletePhoto(id, photo.id);
      setPhotos((prev) => prev.filter((p) => p.id !== photo.id));
    } catch (err) {
      setPhotoError(err instanceof Error ? err.message : 'Failed to delete photo');
    }
  }, [id, deletePhoto, pendingDeletePhoto]);

  useEffect(() => {
    void loadJob();
    void loadNotes();
    void loadPhotos();
    void loadAppointment();
  }, [loadJob, loadNotes, loadPhotos, loadAppointment]);

  // #1135 — the delay chip IS the confirm: tapping 10/15/20/60 posts the
  // running-late notice immediately (no second dialog). Optimistic: the chip
  // shows selected right away; on failure the selection reverts and an error
  // is surfaced instead of silently doing nothing.
  const handleDelayChipTap = useCallback(async (minutes: DelayOption) => {
    const previous = delayMinutes;
    setDelayError(null);
    setDelayMinutes(minutes);
    if (!appointmentId) {
      setDelayMinutes(previous);
      setDelayError('Unable to send a running-late notice: no appointment found for this job.');
      return;
    }
    setDelaySending(true);
    try {
      const res = await apiFetch(`/api/appointments/${appointmentId}/running-late`, {
        method: 'POST',
        body: JSON.stringify({ delayMinutes: minutes }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      setDelayMinutes(previous);
      setDelayError(err instanceof Error ? err.message : 'Failed to send running-late notice');
    } finally {
      setDelaySending(false);
    }
  }, [apiFetch, appointmentId, delayMinutes]);

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-muted-foreground text-sm">Loading job…</div>
      </div>
    );
  }

  if (loadError || !jobData) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3">
        <p className="text-muted-foreground text-sm">{loadError ?? 'Job not found'}</p>
        <button onClick={() => navigate(-1)} className="text-xs text-primary hover:underline">← Back</button>
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
  const statusIdx = STATUS_FLOW.findIndex(s => s.key === techStatus); // -1 in the waiting branch
  const currentStatus = statusStep(techStatus);
  const isComplete = techStatus === 'complete';
  // Progress dots track the linear flow; the waiting branch sits at in_progress depth.
  const progressIdx = techStatus === 'waiting'
    ? STATUS_FLOW.findIndex(s => s.key === 'in_progress')
    : statusIdx;
  const now = () => new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

  function logStatusActivity(content: string) {
    setActivities(prev => [...prev, {
      id: `tech-${Date.now()}`, type: 'check_in',
      content, time: now(),
      author: techName,
      authorInitials: techInitials,
      authorColor: techColor,
    }]);
  }

  async function advanceStatus() {
    setStatusError(null);

    if (techStatus === 'waiting') {
      // Branch state: the job never left in_progress server-side, and the
      // API rejects self-transitions — resume locally without posting.
      setTechStatus('in_progress');
      logStatusActivity('Resumed work on the job');
      return;
    }

    if (statusIdx < 0 || statusIdx >= STATUS_FLOW.length - 1) return;
    const next = STATUS_FLOW[statusIdx + 1];

    // Persist to API — only when the canonical status actually changes
    // (en_route/on_site/in_progress all map to 'in_progress' server-side,
    // and the API rejects self-transitions).
    if (jobData && jobData.status !== next.apiStatus) {
      try {
        const res = await apiFetch(`/api/jobs/${id}/transition`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: next.apiStatus }),
        });
        if (!res.ok) {
          const json = await res.json().catch(() => ({}));
          throw new Error(json?.message ?? `Failed to update status: HTTP ${res.status}`);
        }
        setJobData({ ...jobData, status: next.apiStatus });
      } catch (err) {
        // Do not advance the local state to a status the API rejected.
        setStatusError(err instanceof Error ? err.message : 'Failed to update status');
        return;
      }
    }

    setTechStatus(next.key);
    const msgs: Partial<Record<TechStatus, string>> = {
      on_site: 'Arrived at job site', in_progress: 'Started work on the job',
      complete: 'Marked job complete',
    };
    logStatusActivity(msgs[next.key] ?? '');
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

  // A status the tech confirmed on the voice card: the same audited
  // transition the status buttons post, with the same error handling.
  async function applyVoiceStatus(status: TechStatus) {
    setStatusError(null);
    const apiStatus = statusStep(status).apiStatus;
    // Skip when unchanged — the API rejects self-transitions (e.g. 'waiting'
    // is a local branch of the server's in_progress).
    if (jobData && jobData.status !== apiStatus) {
      try {
        const res = await apiFetch(`/api/jobs/${id}/transition`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: apiStatus }),
        });
        if (!res.ok) {
          const json = await res.json().catch(() => ({}));
          throw new Error(json?.message ?? `Failed to update status: HTTP ${res.status}`);
        }
        setJobData({ ...jobData, status: apiStatus });
      } catch (err) {
        setStatusError(err instanceof Error ? err.message : 'Failed to update status');
        return;
      }
    }
    setTechStatus(status);
    logStatusActivity(`Marked by voice: ${statusStep(status).label}`);
  }

  async function handleVoiceResult(result: VoiceResult) {
    if (result.statusUpdate) await applyVoiceStatus(result.statusUpdate);

    const outcome: TechVoiceOutcome = await sendTechVoiceUpdate(
      apiFetch,
      id,
      result.transcript,
      result.statusOffered,
    );
    let noteFailed = false;
    if (needsFieldNote(outcome)) {
      const savedId = await saveNoteToApi(result.transcript, 'voice');
      if (savedId) {
        setNotes(prev => [...prev, { id: savedId, text: result.transcript, time: now(), source: 'voice' }]);
      } else {
        noteFailed = true;
      }
    }
    // Never claim a save that did not happen: a failed note keeps the words
    // on screen so the tech can try again.
    const unsaved = `The job note didn't save, so please try again: "${result.transcript}"`;
    setVoiceReply(
      outcome.ok
        ? noteFailed ? `${outcome.reply} ${unsaved}` : outcome.reply
        : noteFailed
          ? `Rivet couldn't draft anything from it right now. ${unsaved}`
          : "Saved as a job note. Rivet couldn't draft anything from it right now.",
    );
    setActivities(prev => [...prev, {
      id: `va-${Date.now()}`, type: 'voice',
      content: `"${result.transcript.slice(0, 80)}${result.transcript.length > 80 ? '…' : ''}"`,
      time: now(), author: techName,
      authorInitials: techInitials,
      authorColor: techColor,
      voiceDuration: result.durationSeconds,
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

  async function handleCameraClose(media: CapturedMedia[]) {
    setCam(false);
    if (media.length === 0) return;
    setPhotoSaving(true);
    setPhotoError(null);
    let saved = 0;
    for (const m of media) {
      try {
        const file = await capturedMediaToFile(m);
        const category: JobPhotoCategory = m.type === 'video'
          ? 'other'
          : defaultPhotoCategoryForJobStatus(jobData?.status ?? '');
        await uploadPhoto(id, file, category, undefined, m.capturedAt);
        saved += 1;
      } catch (err) {
        setPhotoError(err instanceof Error ? err.message : 'Photo upload failed');
      }
    }
    await loadPhotos();
    setPhotoSaving(false);
    if (saved > 0) {
      setActivities(prev => [...prev, {
        id: `ph-${Date.now()}`, type: 'photo',
        content: `${saved} photo${saved > 1 ? 's' : ''} added`,
        time: now(), author: techName,
        authorInitials: techInitials,
        authorColor: techColor,
      }]);
    }
  }

  return (
    <>
      <div className="flex flex-col h-full bg-secondary overflow-hidden">

        {/* ── Top bar ── */}
        <div className="shrink-0 bg-primary px-4 py-3 flex items-center justify-between">
          <button onClick={() => navigate(`/jobs/${id}`)}
            className="flex items-center gap-1.5 text-muted-foreground hover:text-primary-foreground text-sm transition-colors">
            <ArrowLeft size={14} /> Owner view
          </button>
          <div className="flex items-center gap-2">
            {jobData.priority === 'urgent' && (
              <span className="flex items-center gap-1 text-xs bg-destructive text-primary-foreground rounded-full px-2 py-0.5">
                <Zap size={10} /> Urgent
              </span>
            )}
            <span className="text-xs text-muted-foreground">#{jobData.jobNumber}</span>
            <span
              className="flex size-7 items-center justify-center rounded-full text-primary-foreground text-xs"
              style={{ background: techColor }}>
              {techInitials}
            </span>
          </div>
        </div>

        {/* ── Scrollable body ── */}
        <div className="flex-1 overflow-y-auto pb-28">
          <div className="max-w-lg mx-auto">

            {/* ── Job hero ── */}
            <div className={`${SVC_BG[svcType] ?? SVC_BG.HVAC} bg-primary px-5 pt-5 pb-6`}>
              <div className="flex items-start gap-3 mb-3">
                <span className="text-3xl">{SVC_ICON[svcType] ?? '🔧'}</span>
                <div className="flex-1 min-w-0">
                  <h2 className="text-primary-foreground leading-tight">{customerName}</h2>
                  <div className="flex items-center gap-1.5 mt-1">
                    <MapPin size={12} className="text-muted-foreground shrink-0" />
                    <p className="text-muted-foreground text-sm truncate">{address || 'No address on file'}</p>
                  </div>
                  {jobData.scheduledStart && (
                    <div className="flex items-center gap-1.5 mt-1">
                      <Clock size={12} className="text-muted-foreground shrink-0" />
                      <p className="text-muted-foreground text-sm">
                        {formatDateInTenantTz(jobData.scheduledStart, timezone)}
                        {' · '}
                        {formatTimeInTenantTz(jobData.scheduledStart, timezone)}
                      </p>
                    </div>
                  )}
                </div>
              </div>

              <div className="bg-card/10 rounded-xl px-3.5 py-2.5 mb-4">
                <p className="text-xs text-muted-foreground mb-0.5">Job description</p>
                <p className="text-sm text-primary-foreground leading-relaxed">{jobData.summary}</p>
                {jobData.problemDescription && (
                  <p className="text-xs text-muted-foreground mt-1 leading-relaxed">{jobData.problemDescription}</p>
                )}
              </div>

              {/* Customer notes (access notes, preferences) */}
              {customerNotes && (
                <div className="flex items-start gap-2 bg-warning/20 border border-warning/30 rounded-xl px-3.5 py-2.5 mb-4">
                  <AlertTriangle size={13} className="text-warning shrink-0 mt-0.5" />
                  <p className="text-sm text-warning leading-relaxed">{customerNotes}</p>
                </div>
              )}

              {/* Contact row */}
              <div className="grid grid-cols-2 gap-2">
                <a href={mapsUrl} target="_blank" rel="noreferrer"
                  className="flex items-center gap-2 rounded-xl bg-card/10 hover:bg-card/20 px-3 py-2.5 transition-colors">
                  <Navigation size={15} className="text-primary shrink-0" />
                  <div className="min-w-0">
                    <p className="text-xs text-muted-foreground">Directions</p>
                    <p className="text-xs text-primary-foreground truncate">{address.split(',')[0] || 'Navigate'}</p>
                  </div>
                </a>
                <button onClick={() => setSheet('call')}
                  className="flex items-center gap-2 rounded-xl bg-card/10 hover:bg-card/20 px-3 py-2.5 transition-colors text-left">
                  <Phone size={15} className="text-success shrink-0" />
                  <div className="min-w-0">
                    <p className="text-xs text-muted-foreground">Call</p>
                    <p className="text-xs text-primary-foreground truncate">{customerPhone}</p>
                  </div>
                </button>
              </div>
            </div>

            {/* ── Status bar ── */}
            <div className="bg-card border-b border-border px-5 py-4">
              <div className="flex items-center justify-between mb-3">
                <p className="text-xs text-muted-foreground">Status</p>
                <span className={`text-xs px-2.5 py-0.5 rounded-full text-primary-foreground ${currentStatus.ctaBg.split(' ')[0]}`}>
                  {currentStatus.label}
                </span>
              </div>
              <div className="flex items-center gap-1 mb-3">
                {STATUS_FLOW.map((s, i) => {
                  const done = progressIdx >= i;
                  return (
                    <div key={s.key} className="flex items-center flex-1">
                      <div className={`size-2.5 rounded-full shrink-0 transition-all duration-300 ${done ? s.dotColor : 'bg-border'}`} />
                      {i < STATUS_FLOW.length - 1 && <div className={`flex-1 h-px transition-colors duration-300 ${done && progressIdx > i ? 'bg-success' : 'bg-border'}`} />}
                    </div>
                  );
                })}
              </div>
              {statusError && (
                <p data-testid="tech-status-error" role="alert" className="mb-2 text-sm text-destructive">
                  {statusError}
                </p>
              )}
              {!isComplete ? (
                <button onClick={() => void advanceStatus()}
                  className={`flex items-center justify-center gap-2 w-full py-3.5 rounded-xl text-primary-foreground text-sm transition-colors ${currentStatus.ctaBg}`}>
                  <CheckCircle2 size={16} /> {currentStatus.cta}
                </button>
              ) : (
                <div className="flex items-center justify-center gap-2 w-full py-3.5 rounded-xl bg-success/10 text-success text-sm border border-success/30">
                  <CheckCircle2 size={16} /> Job complete!
                </div>
              )}
            </div>

            {/* ── VOICE HERO ── */}
            <div className="mx-4 mt-4 rounded-2xl bg-card border-2 border-border px-5 py-2 overflow-hidden">
              <div className="flex items-center justify-between mb-1">
                <div className="flex items-center gap-2">
                  <div className="flex size-6 items-center justify-center rounded-full bg-primary/15">
                    <Sparkles size={11} className="text-primary" />
                  </div>
                  <p className="text-xs text-muted-foreground">Voice add — fastest in the field</p>
                </div>
              </div>
              <VoiceHero
                onResult={handleVoiceResult}
                reply={voiceReply}
                apiFetch={apiFetch}
              />
            </div>

            {/* ── Quick action chips ── */}
            <div className="px-4 mt-3">
              <div className="rounded-2xl border border-border bg-card p-3.5 mb-3">
                <p className="text-xs text-muted-foreground mb-2.5">Running behind?</p>
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
                          setDelayError(null);
                          if (!behind) setDelayMinutes(null);
                        }}
                        className={`rounded-full px-3 py-1.5 text-xs border transition-colors ${
                          selected
                            ? 'bg-primary text-primary-foreground border-primary'
                            : 'bg-card text-foreground border-border hover:bg-secondary'
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
                      onClick={() => void handleDelayChipTap(minutes)}
                      disabled={isRunningBehind !== true || delaySending}
                      className={`rounded-full px-3 py-1.5 text-xs border transition-colors ${
                        delayMinutes === minutes
                          ? 'bg-primary text-primary-foreground border-primary'
                          : 'bg-card text-foreground border-border'
                      } ${isRunningBehind === true ? 'hover:bg-secondary' : 'opacity-50 cursor-not-allowed'}`}
                    >
                      {minutes}
                    </button>
                  ))}
                </div>
                {delayError && (
                  <p data-testid="tech-delay-error" role="alert" className="mt-2 text-xs text-destructive">
                    {delayError}
                  </p>
                )}
              </div>
              <p className="text-xs text-muted-foreground mb-2 px-1">Or tap to add manually</p>
              <div className="grid grid-cols-3 gap-2">
                {[
                  { icon: Pencil,        label: 'Note',    bg: 'bg-secondary',  color: 'text-foreground', onClick: () => {} },
                  { icon: Camera,        label: 'Photo',   bg: 'bg-primary/15',    color: 'text-primary',   onClick: () => setCam(true) },
                  { icon: AlertTriangle, label: 'Issue',   bg: 'bg-destructive/15',    color: 'text-destructive',   onClick: () => setSheet('cancel') },
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
              <PhotosSection
                jobId={id}
                photos={photos}
                category={photoCategory}
                onCategoryChange={setPhotoCategory}
                onAdd={() => setCam(true)}
                onDelete={handleDeletePhoto}
                saving={photoSaving}
                error={photoError}
              />

              {activities.length > 0 && (
                <div className="rounded-2xl bg-card border border-border px-4 py-4">
                  <p className="text-sm text-foreground mb-3">Activity log</p>
                  <ActivityTimeline activities={activities.slice(-6)} compact />
                </div>
              )}
            </div>

          </div>
        </div>

        {/* ── Bottom CTA ── */}
        {!isComplete && (
          <div className="shrink-0 fixed bottom-0 left-0 right-0 md:absolute bg-card/90 backdrop-blur border-t border-border px-5 py-4 flex gap-3">
            <button onClick={() => setSheet('call')}
              className="flex size-12 items-center justify-center rounded-xl bg-secondary hover:bg-border transition-colors shrink-0">
              <Phone size={18} className="text-foreground" />
            </button>
            <button onClick={() => setCam(true)}
              className="flex size-12 items-center justify-center rounded-xl bg-secondary hover:bg-border transition-colors shrink-0">
              <Camera size={18} className="text-foreground" />
            </button>
            <button onClick={() => void advanceStatus()}
              className={`flex-1 flex items-center justify-center gap-2 rounded-xl text-primary-foreground text-sm py-3 transition-colors ${currentStatus.ctaBg}`}>
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
          customerId={jobData.customerId}
          onClose={() => setSheet(null)}
        />
      )}
      {sheet === 'call' && (
        <CallScreen
          name={customerName} phone={customerPhone}
          initials={customerName.split(' ').map((n: string) => n[0]).join('')}
          color={techColor}
          customerId={jobData.customerId}
          onEnd={() => setSheet(null)}
        />
      )}
      {sheet === 'text' && (
        <TextSheet name={customerName} phone={customerPhone} customerId={jobData.customerId} onClose={() => setSheet(null)} />
      )}
      {cameraOpen && <CameraCapture onClose={media => void handleCameraClose(media)} />}

      {/* #907 — window.confirm replaced with ConfirmDialog. */}
      <ConfirmDialog
        open={pendingDeletePhoto !== null}
        title="Delete this photo?"
        description="This cannot be undone."
        confirmLabel="Delete"
        tone="danger"
        onConfirm={() => void confirmDeletePhoto()}
        onCancel={() => setPendingDeletePhoto(null)}
      />

      <style>{`
        @keyframes fadeUp { from{opacity:0;transform:translateY(6px)} to{opacity:1;transform:translateY(0)} }
      `}</style>
    </>
  );
}

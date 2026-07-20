import {
  isVoiceAnswerStatus,
  parseVoiceLookupAnswer,
  type VoiceLookupAnswer,
} from '@ai-service-os/shared';
import type { ApiFetch } from '../lib/apiFetch';

// Mirrors web's VoiceBar constants.
export const VOICE_POLL_INTERVAL_MS = 1500;
export const VOICE_POLL_TIMEOUT_MS = 90000;
/**
 * U3 — bounded second poll phase: after `status='completed'` the server's
 * voice-action-router is still classifying (it enqueues AFTER completion),
 * so we keep polling the same route for the routed outcome
 * (`answerStatus`) on the same cadence, but only briefly — a slow router
 * degrades to today's "check approvals" behavior, never a hung mic screen.
 */
export const VOICE_ANSWER_POLL_TIMEOUT_MS = 12000;

/** A recorded clip: a local file URI + metadata. */
export interface AudioClip {
  fileUri: string;
  /** Base MIME type (no codec params), e.g. 'audio/mp4'. Must be API-whitelisted. */
  contentType: string;
  sizeBytes: number;
}

/** PUTs the local file to the signed URL. Injected so tests never touch the FS. */
export type FileUploader = (
  uploadUrl: string,
  fileUri: string,
  contentType: string,
) => Promise<{ ok: boolean; status: number }>;

export interface UploadAndTranscribeDeps {
  api: ApiFetch;
  uploadFile: FileUploader;
  makeIdempotencyKey: () => string;
  // Time controls — injected for fast, deterministic tests.
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  intervalMs?: number;
  timeoutMs?: number;
  /** Budget for the U3 second poll phase (routed outcome). */
  answerTimeoutMs?: number;
  /**
   * U12 offline resume — when set, skip createSignedAudioUpload + verify (the
   * audio is already uploaded) and go straight to POST /recordings. Persisted
   * on the queue item after a prior successful upload+verify.
   */
  checkpoint?: { fileId: string; audioUrl: string };
  /**
   * U12 — called after a successful upload+verify with the checkpoint, so the
   * offline queue can persist it BEFORE the POST /recordings attempt.
   */
  onCheckpoint?: (checkpoint: { fileId: string; audioUrl: string }) => Promise<void> | void;
}

/** An Error tagged with the failing HTTP status so callers can classify it. */
interface HttpStatusError extends Error {
  status?: number;
}

function httpError(message: string, status?: number): HttpStatusError {
  const err = new Error(message) as HttpStatusError;
  if (typeof status === 'number') err.status = status;
  return err;
}

/**
 * U3 — the memo's routed outcome, surfaced to the capture screen:
 *   answered      → render the AnswerCard from `answer`.
 *   proposal /
 *   clarification → today's behavior (route to approvals).
 *   skipped       → today's behavior (also the shape an older server
 *                   without answerStatus degrades to — no second poll).
 *   failed        → the lookup errored; offer retry.
 *   timeout       → second-poll budget exhausted; today's behavior.
 */
export type VoiceRoutedOutcome =
  | { kind: 'answered'; answer: VoiceLookupAnswer }
  | { kind: 'proposal' }
  | { kind: 'clarification' }
  | { kind: 'skipped' }
  | { kind: 'failed' }
  | { kind: 'timeout' };

export interface UploadAndTranscribeResult {
  transcript: string;
  outcome: VoiceRoutedOutcome;
}

async function createSignedAudioUpload(
  clip: AudioClip,
  deps: UploadAndTranscribeDeps,
): Promise<{ fileId: string; audioUrl: string }> {
  const ext = /mp4|m4a/.test(clip.contentType) ? 'm4a' : 'aac';
  const body = JSON.stringify({
    filename: `voice-${(deps.now ?? Date.now)()}.${ext}`,
    contentType: clip.contentType,
    sizeBytes: clip.sizeBytes,
    entityType: 'voice_recording',
  });
  const requestSigned = (path: string) =>
    deps.api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });

  let res = await requestSigned('/api/files/upload-url');
  if (!res.ok) res = await requestSigned('/api/files/upload');
  if (!res.ok) throw httpError('Unable to get a signed upload URL.', res.status);

  const payload = (await res.json()) as {
    fileId?: string;
    fileRecord?: { id?: string };
    uploadUrl?: string;
    downloadUrl?: string;
    audioUrl?: string;
    fileUrl?: string;
  };
  const fileId = payload.fileId ?? payload.fileRecord?.id;
  const uploadUrl = payload.uploadUrl;
  const downloadUrl = payload.downloadUrl ?? payload.audioUrl ?? payload.fileUrl;
  if (!fileId || !uploadUrl) throw new Error('Upload URL response is missing required fields.');

  const put = await deps.uploadFile(uploadUrl, clip.fileUri, clip.contentType);
  if (!put.ok) throw httpError('Audio upload failed. Please retry.', put.status);

  return { fileId, audioUrl: downloadUrl ?? uploadUrl.split('?')[0] };
}

/**
 * Upload + verify a clip, returning the durable `{fileId, audioUrl}`. When a
 * checkpoint is supplied (U12 resume) the upload is skipped entirely. On a
 * fresh upload the checkpoint is reported via `onCheckpoint` after verify, so
 * the caller can persist it before attempting POST /recordings.
 */
async function uploadAndVerify(
  clip: AudioClip,
  deps: UploadAndTranscribeDeps,
): Promise<{ fileId: string; audioUrl: string }> {
  if (deps.checkpoint) return deps.checkpoint;
  const signed = await createSignedAudioUpload(clip, deps);
  const verifyRes = await deps.api(`/api/files/${signed.fileId}/verify`, { method: 'POST' });
  if (!verifyRes.ok) throw httpError('Upload verification failed.', verifyRes.status);
  await deps.onCheckpoint?.(signed);
  return signed;
}

/**
 * Deliver a recording: (resume-aware) upload+verify → POST /api/voice/recordings,
 * returning the created recording id. Shared by the foreground pipeline
 * ({@link uploadAndTranscribe}) and the offline flush machine, which stops here
 * — once the recording is created + enqueued the offline job is delivered, and
 * a replay with the same idempotencyKey is safe server-side (U11).
 */
export async function deliverRecording(
  clip: AudioClip,
  deps: UploadAndTranscribeDeps,
  jobId?: string,
): Promise<{ recordingId: string; fileId: string; audioUrl: string }> {
  const { fileId, audioUrl } = await uploadAndVerify(clip, deps);

  const createRes = await deps.api('/api/voice/recordings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fileId,
      audioUrl,
      idempotencyKey: deps.makeIdempotencyKey(),
      ...(jobId ? { jobId } : {}),
    }),
  });
  if (!createRes.ok) throw httpError('Unable to start transcription.', createRes.status);

  const created = (await createRes.json()) as { recording?: { id?: string } };
  const recordingId = created.recording?.id;
  if (!recordingId) throw new Error('Missing recording id from API.');

  return { recordingId, fileId, audioUrl };
}

interface RecordingStatusBody {
  status?: string;
  transcript?: string;
  errorMessage?: string;
  answerStatus?: string;
  answer?: unknown;
}

async function pollRecordingUntilDone(
  recordingId: string,
  deps: UploadAndTranscribeDeps,
): Promise<RecordingStatusBody> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const interval = deps.intervalMs ?? VOICE_POLL_INTERVAL_MS;
  const timeout = deps.timeoutMs ?? VOICE_POLL_TIMEOUT_MS;

  const startedAt = now();
  while (now() - startedAt < timeout) {
    const res = await deps.api(`/api/voice/recordings/${recordingId}`);
    if (!res.ok) throw new Error('Could not fetch transcription status.');
    const status = (await res.json()) as RecordingStatusBody;
    if (status.status === 'completed') return status;
    if (status.status === 'failed') throw new Error(status.errorMessage || 'Transcription failed.');
    await sleep(interval);
  }
  throw new Error('Transcription timed out. Please retry.');
}

/** Map a terminal answerStatus (never 'pending') onto the client outcome. */
function outcomeFor(body: RecordingStatusBody): VoiceRoutedOutcome {
  switch (body.answerStatus) {
    case 'answered': {
      // Lenient parse: a malformed/missing payload degrades to today's
      // behavior instead of crashing the capture screen.
      const answer = parseVoiceLookupAnswer(body.answer);
      return answer ? { kind: 'answered', answer } : { kind: 'skipped' };
    }
    case 'proposal':
      return { kind: 'proposal' };
    case 'clarification':
      return { kind: 'clarification' };
    case 'failed':
      return { kind: 'failed' };
    case 'skipped':
    default:
      return { kind: 'skipped' };
  }
}

/**
 * U3 — second poll phase. `status='completed'` only proves transcription
 * finished; the router job that decides the outcome enqueues AFTER that
 * flip, so `answerStatus` starts at 'pending'. Poll the same route on the
 * same cadence under a much smaller budget; an older server that omits
 * the field (or a surface the router skips) short-circuits immediately.
 * Never throws — a poll error mid-phase degrades to 'timeout' (today's
 * behavior) because the transcript is already safely captured.
 */
async function pollRoutedOutcome(
  recordingId: string,
  completed: RecordingStatusBody,
  deps: UploadAndTranscribeDeps,
): Promise<VoiceRoutedOutcome> {
  if (!isVoiceAnswerStatus(completed.answerStatus)) return { kind: 'skipped' };
  if (completed.answerStatus !== 'pending') return outcomeFor(completed);

  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const interval = deps.intervalMs ?? VOICE_POLL_INTERVAL_MS;
  const timeout = deps.answerTimeoutMs ?? VOICE_ANSWER_POLL_TIMEOUT_MS;

  const startedAt = now();
  try {
    while (now() - startedAt < timeout) {
      await sleep(interval);
      const res = await deps.api(`/api/voice/recordings/${recordingId}`);
      if (!res.ok) return { kind: 'timeout' };
      const body = (await res.json()) as RecordingStatusBody;
      if (isVoiceAnswerStatus(body.answerStatus) && body.answerStatus !== 'pending') {
        return outcomeFor(body);
      }
    }
  } catch {
    return { kind: 'timeout' };
  }
  return { kind: 'timeout' };
}

/**
 * Owner-capture pipeline (RN port of web's VoiceBar): signed upload → verify →
 * create recording → poll until transcribed → bounded second poll for the
 * routed outcome. Proposals are still created automatically server-side (the
 * `voice_action_router` worker) and surface in GET /api/proposals/inbox; the
 * returned outcome tells the capture screen whether an E-lane ANSWER landed
 * instead (rendered inline as an AnswerCard, no approvals round-trip).
 */
export async function uploadAndTranscribe(
  clip: AudioClip,
  deps: UploadAndTranscribeDeps,
  jobId?: string,
): Promise<UploadAndTranscribeResult> {
  const { recordingId } = await deliverRecording(clip, deps, jobId);
  const completed = await pollRecordingUntilDone(recordingId, deps);
  const outcome = await pollRoutedOutcome(recordingId, completed, deps);
  return { transcript: (completed.transcript ?? '').trim(), outcome };
}

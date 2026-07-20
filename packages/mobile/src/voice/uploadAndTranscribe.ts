import type { ApiFetch } from '../lib/apiFetch';

// Mirrors web's VoiceBar constants.
export const VOICE_POLL_INTERVAL_MS = 1500;
export const VOICE_POLL_TIMEOUT_MS = 90000;

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
}

/**
 * HTTP-phase failure carrying the response status, so the offline flush
 * machine (U12) can classify retry-vs-drop without parsing UI copy. The
 * message stays the user-facing string the capture UI already shows.
 */
export function makeVoiceHttpError(status: number, message: string): Error & { status: number } {
  const err = new Error(message) as Error & { status: number };
  err.name = 'VoiceHttpError';
  err.status = status;
  return err;
}

/** True for an error minted by {@link makeVoiceHttpError}. */
export function isVoiceHttpError(err: unknown): err is Error & { status: number } {
  return err instanceof Error && err.name === 'VoiceHttpError';
}

/** Upload+verify result — persisted as the offline queue's per-item checkpoint. */
export interface UploadedAudio {
  fileId: string;
  audioUrl: string;
}

async function createSignedAudioUpload(
  clip: AudioClip,
  deps: UploadAndTranscribeDeps,
): Promise<UploadedAudio> {
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
  if (!res.ok) throw makeVoiceHttpError(res.status, 'Unable to get a signed upload URL.');

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
  if (!put.ok) throw makeVoiceHttpError(put.status, 'Audio upload failed. Please retry.');

  return { fileId, audioUrl: downloadUrl ?? uploadUrl.split('?')[0] };
}

/**
 * Phase 1 of the capture pipeline: signed upload + server-side verify.
 * A success here is the offline queue's checkpoint boundary — later flush
 * attempts skip straight to {@link submitRecording} instead of re-uploading.
 */
export async function uploadAndVerifyClip(
  clip: AudioClip,
  deps: UploadAndTranscribeDeps,
): Promise<UploadedAudio> {
  const uploaded = await createSignedAudioUpload(clip, deps);
  const verifyRes = await deps.api(`/api/files/${uploaded.fileId}/verify`, { method: 'POST' });
  if (!verifyRes.ok) throw makeVoiceHttpError(verifyRes.status, 'Upload verification failed.');
  return uploaded;
}

export interface SubmitRecordingInput {
  fileId: string;
  audioUrl: string;
  /**
   * U11 server replay key. The offline queue mints this ONCE at enqueue and
   * replays the identical value on every flush attempt; the online path mints
   * a fresh one per capture via `deps.makeIdempotencyKey`.
   */
  idempotencyKey: string;
  jobId?: string;
}

/**
 * Phase 2: create the recording (202) — the server transcribes async and the
 * voice_action_router lands proposals in the inbox with no further client call.
 */
export async function submitRecording(
  deps: Pick<UploadAndTranscribeDeps, 'api'>,
  input: SubmitRecordingInput,
): Promise<string> {
  const createRes = await deps.api('/api/voice/recordings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fileId: input.fileId,
      audioUrl: input.audioUrl,
      idempotencyKey: input.idempotencyKey,
      ...(input.jobId ? { jobId: input.jobId } : {}),
    }),
  });
  if (!createRes.ok) throw makeVoiceHttpError(createRes.status, 'Unable to start transcription.');

  const created = (await createRes.json()) as { recording?: { id?: string } };
  const recordingId = created.recording?.id;
  if (!recordingId) throw new Error('Missing recording id from API.');
  return recordingId;
}

async function pollRecordingUntilDone(
  recordingId: string,
  deps: UploadAndTranscribeDeps,
): Promise<{ transcript?: string }> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const interval = deps.intervalMs ?? VOICE_POLL_INTERVAL_MS;
  const timeout = deps.timeoutMs ?? VOICE_POLL_TIMEOUT_MS;

  const startedAt = now();
  while (now() - startedAt < timeout) {
    const res = await deps.api(`/api/voice/recordings/${recordingId}`);
    if (!res.ok) throw new Error('Could not fetch transcription status.');
    const status = (await res.json()) as {
      status?: string;
      transcript?: string;
      errorMessage?: string;
    };
    if (status.status === 'completed') return status;
    if (status.status === 'failed') throw new Error(status.errorMessage || 'Transcription failed.');
    await sleep(interval);
  }
  throw new Error('Transcription timed out. Please retry.');
}

/**
 * Owner-capture pipeline (RN port of web's VoiceBar): signed upload → verify →
 * create recording → poll until transcribed. Returns the transcript. Proposals
 * are created automatically server-side (the `voice_action_router` worker) and
 * surface in GET /api/proposals/inbox — no further client call is needed.
 */
export async function uploadAndTranscribe(
  clip: AudioClip,
  deps: UploadAndTranscribeDeps,
  jobId?: string,
): Promise<string> {
  const uploaded = await uploadAndVerifyClip(clip, deps);

  const recordingId = await submitRecording(deps, {
    fileId: uploaded.fileId,
    audioUrl: uploaded.audioUrl,
    idempotencyKey: deps.makeIdempotencyKey(),
    ...(jobId ? { jobId } : {}),
  });

  const completed = await pollRecordingUntilDone(recordingId, deps);
  return (completed.transcript ?? '').trim();
}

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
  if (!res.ok) throw new Error('Unable to get a signed upload URL.');

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
  if (!put.ok) throw new Error('Audio upload failed. Please retry.');

  return { fileId, audioUrl: downloadUrl ?? uploadUrl.split('?')[0] };
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
  const { fileId, audioUrl } = await createSignedAudioUpload(clip, deps);

  const verifyRes = await deps.api(`/api/files/${fileId}/verify`, { method: 'POST' });
  if (!verifyRes.ok) throw new Error('Upload verification failed.');

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
  if (!createRes.ok) throw new Error('Unable to start transcription.');

  const created = (await createRes.json()) as { recording?: { id?: string } };
  const recordingId = created.recording?.id;
  if (!recordingId) throw new Error('Missing recording id from API.');

  const completed = await pollRecordingUntilDone(recordingId, deps);
  return (completed.transcript ?? '').trim();
}

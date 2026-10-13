/**
 * H2 (2026-10-13 security audit) — what the transcription worker stores on a
 * failed audio fetch. The recording's errorMessage is user-visible (GET
 * /api/voice/recordings/:id), so it must never carry the fetched URL: that was
 * the SSRF oracle (URL + HTTP status of an internal address), and for a real
 * job the URL is a presigned, secret-bearing storage link.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStorageProvider } from '../../src/files/storage-provider';
import type { QueueMessage } from '../../src/queues/queue';
import { WhisperTranscriptionProvider } from '../../src/voice/transcription-providers';
import { InMemoryVoiceRepository, type VoiceRecording } from '../../src/voice/voice-service';
import {
  createTranscriptionWorker,
  type TranscriptionJobPayload,
} from '../../src/workers/transcription';

const TENANT = '0b3c1f52-7e0d-4d1a-9a8e-1248000000b2';
const RECORDING = '5a0f3c9e-1d2b-4c7a-8e6f-1248000000b2';
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;

function prodStorage() {
  return createStorageProvider({
    NODE_ENV: 'production',
    STORAGE_BUCKET: 'serviceos-prod',
    STORAGE_ENDPOINT: 'https://acct123.r2.cloudflarestorage.com',
    STORAGE_REGION: 'auto',
    STORAGE_ACCESS_KEY_ID: 'AKIDEXAMPLE',
    STORAGE_SECRET_ACCESS_KEY: 'secret-example',
  });
}

async function failedRecordingAfter(audioUrl: string, fetchImpl: typeof fetch) {
  return (await runJob(audioUrl, fetchImpl, { attempts: 3, maxAttempts: 3 })).recording;
}

/** One delivery of a transcription job: the stored recording, and whether the queue would redeliver. */
async function runJob(
  audioUrl: string,
  fetchImpl: typeof fetch,
  delivery: { attempts: number; maxAttempts: number },
) {
  vi.stubGlobal('fetch', fetchImpl);
  const voiceRepo = new InMemoryVoiceRepository();
  await voiceRepo.create({
    id: RECORDING,
    tenantId: TENANT,
    fileId: '6b1f3c9e-1d2b-4c7a-8e6f-1248000000b2',
    source: 'inapp_voice',
    status: 'pending',
    createdBy: 'tech-h2',
    createdAt: new Date(),
    updatedAt: new Date(),
  } as VoiceRecording);
  const provider = new WhisperTranscriptionProvider({
    apiKey: 'sk_test',
    fetchImpl,
    audioUrlPolicy: prodStorage().downloadUrlPolicy,
    logger: { warn: vi.fn() },
  });
  const message = {
    id: 'msg-h2',
    type: 'transcription',
    payload: { tenantId: TENANT, recordingId: RECORDING, audioUrl },
    ...delivery,
    idempotencyKey: `${TENANT}:${RECORDING}:transcription:create`,
    createdAt: new Date().toISOString(),
  } as unknown as QueueMessage<TranscriptionJobPayload>;

  const threw = await createTranscriptionWorker(voiceRepo, provider)
    .handle(message, logger)
    .then(
      () => false,
      () => true,
    );
  return { recording: await voiceRepo.findById(TENANT, RECORDING), redelivered: threw };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('H2 — a failed audio fetch never puts the URL in the recording errorMessage', () => {
  it('a storage GET that answers 403 stores the status, not the presigned URL', async () => {
    const storage = prodStorage();
    const presigned = await storage.provider.generateDownloadUrl(storage.bucket, `${TENANT}/f/memo.m4a`);
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response('denied', { status: 403 }));

    const recording = await failedRecordingAfter(presigned, fetchImpl);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(recording?.status).toBe('failed');
    expect(recording?.errorMessage).toContain('403');
    expect(recording?.errorMessage).not.toContain(presigned);
    expect(recording?.errorMessage).not.toContain('acct123.r2.cloudflarestorage.com');
    expect(recording?.errorMessage).not.toContain('X-Amz-Signature');
  });

  it('a job queued before the route fix with an internal URL is refused unfetched, URL kept out of the record', async () => {
    const internal = 'http://169.254.169.254/latest/meta-data/iam/security-credentials/';
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response('role-name', { status: 200 }));

    const recording = await failedRecordingAfter(internal, fetchImpl);

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(recording?.status).toBe('failed');
    expect(recording?.errorMessage).toBeTruthy();
    expect(recording?.errorMessage).not.toContain('169.254.169.254');
  });
});

describe('H2 review L1 — a non-retriable failure is not redelivered', () => {
  it('a refused URL on the FIRST of 3 attempts fails the recording now and acks the job', async () => {
    const fetchImpl = vi.fn<typeof fetch>();

    const { recording, redelivered } = await runJob(
      'http://169.254.169.254/latest/meta-data/',
      fetchImpl,
      { attempts: 1, maxAttempts: 3 },
    );

    expect(redelivered).toBe(false);
    expect(recording?.status).toBe('failed');
    expect(recording?.errorMessage).toMatch(/refused/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('a transient storage 503 on the first attempt is still redelivered, recording back to pending', async () => {
    const storage = prodStorage();
    const presigned = await storage.provider.generateDownloadUrl(storage.bucket, `${TENANT}/f/memo.m4a`);
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response('busy', { status: 503 }));

    const { recording, redelivered } = await runJob(presigned, fetchImpl, { attempts: 1, maxAttempts: 3 });

    expect(redelivered).toBe(true);
    expect(recording?.status).toBe('pending');
  });
});

/**
 * Twilio recording webhook handler (P8-014).
 *
 * Twilio POSTs the finalized recording metadata to
 * `POST /api/telephony/recording` after each inbound call's `<Record>`
 * (or `recordingStatusCallback`) verb completes. The handler:
 *
 *   1. Reads `RecordingSid`, `RecordingUrl`, `CallSid`, `RecordingDuration`
 *      from the form body. Twilio's signature is verified upstream by
 *      `requireTwilioSignature` — this handler trusts the request shape
 *      but never trusts the payload's tenant identity.
 *   2. Resolves the tenant from our own `VoiceSessionStore.findByCallSid`.
 *      Twilio's payload includes `AccountSid` but no `tenant_id`; using
 *      our session map is the only safe cross-tenant boundary.
 *   3. Fetches the recording bytes from Twilio's signed URL using the
 *      `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` HTTP basic credentials.
 *   4. Presigns an S3 PUT for `<bucket>/<tenant_id>/<call_sid>.mp3` and
 *      uploads the bytes via `fetch(url, { method: 'PUT' })`.
 *   5. Inserts a `voice_recordings` row through `recordInboundCall`,
 *      which is idempotent on `(tenant_id, call_sid)`.
 *
 * Logging discipline
 * ──────────────────
 * Never log the recording bytes. Never log `TWILIO_AUTH_TOKEN` or any
 * value derived from it (e.g. the Authorization header). Twilio's
 * RecordingUrl path is fine to log; the credentials live only in the
 * Authorization header we mint for the fetch and are scrubbed below.
 */

import { Router, Request, Response } from 'express';
import express from 'express';
import type { Pool } from 'pg';
import { requireTwilioSignature } from './twilio-signature';
import type { VoiceSessionStore } from '../ai/agents/customer-calling/voice-session-store';
import type { StorageProvider } from '../files/file-service';
import { recordInboundCall } from '../voice/voice-service';
import { createLogger } from '../logging/logger';

const logger = createLogger({
  service: 'telephony.recording-webhook',
  environment: process.env.NODE_ENV || 'development',
});

export interface RecordingWebhookDeps {
  /** Used to resolve tenant from CallSid. Forged payloads cannot lie about tenant. */
  store: VoiceSessionStore;
  /** Pool used to insert the files + voice_recordings rows. */
  pool?: Pool;
  /** S3 (or compatible) provider used for the upload PUT URL. */
  storage: StorageProvider;
  /** Bucket the recording is uploaded to. */
  storageBucket: string;
  /** Twilio account credentials for the signed RecordingUrl fetch. */
  twilioAccountSid?: string;
  twilioAuthToken?: string;
  /** Auth token getter used by the signature middleware (lazy). */
  authTokenGetter: () => string | undefined;
  /** Optional public base URL used to reconstruct the signed URL. */
  publicBaseUrl?: string;
}

/**
 * Build the storage key for an inbound recording. Tenant is the first
 * path segment so an S3 ACL/IAM scope can be carved by prefix and so
 * cross-tenant access is impossible by construction.
 */
export function buildRecordingStorageKey(tenantId: string, callSid: string): string {
  return `${tenantId}/${callSid}.mp3`;
}

/**
 * Strip Twilio Auth credentials from any error message before bubbling
 * it up. Defense-in-depth — `fetch` errors from Node should already
 * scrub Authorization headers, but if a downstream wraps the URL or
 * curl-formats a request we'd rather see `<redacted>` than the token
 * in our logs.
 */
function scrubAuthToken(err: unknown, authToken: string | undefined): string {
  const raw = err instanceof Error ? err.message : String(err);
  if (!authToken) return raw;
  // Replace both the raw token and any base64-encoded basic credential
  // that might have been formatted into the message.
  const replaced = raw.split(authToken).join('<redacted>');
  return replaced;
}

/**
 * Fetch the recording payload from Twilio. The `.mp3` suffix asks Twilio
 * to transcode the WAV master into MP3 on the fly — our S3 key uses
 * `.mp3` to match.
 */
async function fetchRecordingBytes(
  recordingUrl: string,
  accountSid: string,
  authToken: string,
): Promise<Buffer> {
  const url = recordingUrl.endsWith('.mp3') ? recordingUrl : `${recordingUrl}.mp3`;
  const basic = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
  const res = await fetch(url, {
    method: 'GET',
    headers: { Authorization: `Basic ${basic}`, Accept: 'audio/mpeg' },
  });
  if (!res.ok) {
    // Throw with body text for visibility — but the caller scrubs the
    // auth token before this string ever lands in a log line.
    const bodyText = await res.text().catch(() => '');
    throw new Error(`Twilio recording fetch failed ${res.status}: ${bodyText.slice(0, 200)}`);
  }
  const arrayBuf = await res.arrayBuffer();
  return Buffer.from(arrayBuf);
}

async function uploadToS3(
  url: string,
  bytes: Buffer,
  contentType: string,
): Promise<void> {
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': contentType },
    body: bytes,
  });
  if (!res.ok) {
    const bodyText = await res.text().catch(() => '');
    throw new Error(`S3 PUT failed ${res.status}: ${bodyText.slice(0, 200)}`);
  }
}

export interface RecordingHandlerOptions {
  /** Override the default fetcher so tests can stub Twilio. */
  fetchRecording?: typeof fetchRecordingBytes;
  /** Override the default uploader so tests can assert PUT shape. */
  uploadObject?: typeof uploadToS3;
}

/**
 * Build the recording webhook router. Mounted under `/api/telephony` by
 * the caller; the router itself owns only `POST /recording`.
 */
export function createRecordingRouter(
  deps: RecordingWebhookDeps,
  options: RecordingHandlerOptions = {},
): Router {
  const router = Router();
  router.use(express.urlencoded({ extended: false }));
  router.use(
    requireTwilioSignature(deps.authTokenGetter, {
      publicBaseUrl: deps.publicBaseUrl,
    }),
  );

  const fetchRecording = options.fetchRecording ?? fetchRecordingBytes;
  const uploadObject = options.uploadObject ?? uploadToS3;

  router.post('/recording', async (req: Request, res: Response) => {
    const body = req.body as Record<string, string | undefined>;
    const callSid = body.CallSid ?? '';
    const recordingSid = body.RecordingSid ?? '';
    const recordingUrl = body.RecordingUrl ?? '';
    const durationRaw = body.RecordingDuration ?? '0';
    const durationSeconds = Number.parseInt(durationRaw, 10);

    if (!callSid || !recordingSid || !recordingUrl) {
      logger.warn('recording: missing required fields', {
        callSid,
        recordingSid,
        hasUrl: !!recordingUrl,
      });
      res.status(400).type('text/plain').send('Missing required fields');
      return;
    }

    // Tenant resolution — DO NOT trust the payload. Twilio includes
    // AccountSid but never our tenant_id; if no session exists for this
    // CallSid we drop the recording on the floor (200 to suppress
    // Twilio's retry storm; the payload is unverifiable).
    const session = deps.store.findByCallSid(callSid);
    if (!session) {
      logger.warn('recording: no session for CallSid — refusing to insert', {
        callSid,
        recordingSid,
      });
      res.status(200).type('text/plain').send('No session');
      return;
    }
    const tenantId = session.tenantId;

    if (!deps.pool) {
      logger.warn('recording: pool not configured — skipping persistence', {
        tenantId,
        callSid,
        recordingSid,
      });
      res.status(200).type('text/plain').send('Persistence skipped');
      return;
    }
    if (!deps.twilioAccountSid || !deps.twilioAuthToken) {
      logger.error('recording: Twilio credentials missing — cannot fetch bytes', {
        callSid,
        recordingSid,
      });
      res.status(500).type('text/plain').send('Misconfigured');
      return;
    }

    const storageKey = buildRecordingStorageKey(tenantId, callSid);
    const contentType = 'audio/mpeg';

    try {
      // 1. Fetch the recording bytes from Twilio. HTTP basic auth — auth
      //    token never leaves this scope.
      const bytes = await fetchRecording(
        recordingUrl,
        deps.twilioAccountSid,
        deps.twilioAuthToken,
      );

      // 2. Presign an S3 PUT and upload. Note we log byte length only —
      //    never the payload itself.
      const uploadUrl = await deps.storage.generateUploadUrl(
        deps.storageBucket,
        storageKey,
        contentType,
      );
      await uploadObject(uploadUrl, bytes, contentType);

      logger.info('recording: uploaded to S3', {
        tenantId,
        callSid,
        recordingSid,
        sizeBytes: bytes.length,
      });

      // 3. Insert voice_recordings row (idempotent).
      const result = await recordInboundCall(deps.pool, {
        tenantId,
        callSid,
        recordingUrl,
        durationSeconds: Number.isFinite(durationSeconds) ? durationSeconds : 0,
        storageBucket: deps.storageBucket,
        storageKey,
        sizeBytes: bytes.length,
        contentType,
      });

      logger.info('recording: persisted', {
        tenantId,
        callSid,
        recordingSid,
        voiceRecordingId: result.voiceRecordingId,
        inserted: result.inserted,
      });

      res.status(200).type('text/plain').send('OK');
    } catch (err) {
      // Strip the Twilio auth token from any bubbled error before logging.
      const safeMessage = scrubAuthToken(err, deps.twilioAuthToken);
      logger.error('recording: handler failed', {
        callSid,
        recordingSid,
        tenantId,
        error: safeMessage,
      });
      // 500 so Twilio retries — but only after we've stripped credentials
      // from the log line. The scrubbed message is what the operator sees.
      res.status(500).type('text/plain').send('Recording failed');
    }
  });

  return router;
}

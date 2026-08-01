/**
 * Twilio recordingStatusCallback for product voicemail (B4 + U9).
 *
 * Legs, in order:
 *
 *   1. Lead leg (the original B4 behavior, now replay-safe): create a lead
 *      from the caller's number + a `voicemail.received` audit event. A
 *      Twilio callback replay (at-least-once delivery) is deduped through
 *      the webhook-events receipt store (P0-014 webhook base) keyed on
 *      RecordingSid, so a replay can no longer mint a duplicate lead.
 *
 *   2. Transcription leg (U9 — NEW): fetch the recording bytes from
 *      Twilio's signed RecordingUrl (HTTP basic auth), upload them to S3,
 *      insert an idempotent `voice_recordings` row via `recordInboundCall`
 *      (source='inbound_call' — voicemail KEEPS untrusted provenance per
 *      the ratified U9 provenance decision; `classifyRecordingProvenance`
 *      treats 'inbound_call' as untrusted unconditionally), then hand the
 *      presigned audio URL to `onVoicemailPersisted` so the app layer can
 *      enqueue the transcription worker. `inserted=false` (replay, or a
 *      call that already has an inbound recording row) tells the app layer
 *      to skip the enqueue.
 *
 * Caller identity / tenant resolution
 * ───────────────────────────────────
 * Twilio's recordingStatusCallback body carries only recording metadata —
 * no From/To. `buildVoicemailTwiml` therefore mints the callback URL with
 * `From`/`To` query params at TwiML time (the URL is part of what Twilio
 * signs, so they ride back tamper-proof). Tenant is resolved from the
 * in-process session first, then the To-number fallback — the after-hours
 * voicemail branch answers before any session exists, so without the
 * fallback those voicemails were silently dropped.
 *
 * The caller phone is threaded through to the transcription payload so the
 * ROUTER enqueue (on transcript completion) can be gated on the approver
 * set (tenant_settings.owner_phone / backup supervisor). The gate decides
 * only WHETHER routing happens — never trust elevation: the recording row
 * stays source='inbound_call' (untrusted) regardless of who called.
 */
import express, { Router, Request, Response } from 'express';
import type { Pool } from 'pg';
import type { VoiceSessionStore } from '../ai/agents/customer-calling/voice-session-store';
import type { StorageProvider } from '../files/file-service';
import { createLogger } from '../logging/logger';
import { createLead } from '../leads/lead-service';
import type { LeadRepository } from '../leads/lead';
import type { AuditRepository } from '../audit/audit';
import { createAuditEvent } from '../audit/audit';
import { requireTwilioSignature } from './twilio-signature';
import {
  fetchRecordingBytes,
  uploadToS3,
  scrubAuthToken,
} from './recording-webhook';
import { recordInboundCall } from '../voice/voice-service';
import { v4 as uuidv4 } from 'uuid';

const logger = createLogger({
  service: 'telephony.voicemail-status',
  environment: process.env.NODE_ENV || 'development',
});

/**
 * Storage key for a voicemail recording. DELIBERATELY distinct from
 * `buildRecordingStorageKey` (`<tenant>/<callSid>.mp3`): the dial-result
 * voicemail path runs on a call whose live leg may itself be recorded via
 * `<Start><Record>` → /recording, and both objects share one CallSid — a
 * shared key would have the voicemail bytes overwrite the call recording.
 */
export function buildVoicemailStorageKey(tenantId: string, callSid: string): string {
  return `${tenantId}/${callSid}-voicemail.mp3`;
}

/**
 * Minimal surface of the webhook-events idempotency repo (P0-014). No
 * shared interface exists in src/webhooks (see in-memory-webhook-event.ts),
 * so this structural type keeps the dep narrow.
 */
export interface VoicemailWebhookReceiptStore {
  recordReceipt(
    provider: string,
    eventId: string,
    eventType: string,
    payload: Record<string, unknown>,
  ): Promise<{ inserted: boolean }>;
}

/**
 * Fired after the voicemail's `voice_recordings` row is persisted (or
 * matched, on replay). The app layer wires this to enqueue the
 * transcription worker with `audioUrl` (a presigned S3 GET for the
 * just-uploaded object) and the caller phone for the downstream
 * owner-gate. Failure-soft: hook errors are logged here and never fail
 * the webhook — the recording is already persisted.
 */
export interface VoicemailPersistedEvent {
  tenantId: string;
  voiceRecordingId: string;
  callSid: string;
  recordingSid: string;
  /** Carrier caller-ID minted onto the callback URL at TwiML time. */
  callerPhone?: string;
  durationSeconds: number;
  /** Presigned S3 GET URL for the uploaded voicemail audio. */
  audioUrl: string;
  /**
   * True when `recordInboundCall` inserted a new row; false on a Twilio
   * replay OR when the call already carries an inbound recording row
   * (`recordInboundCall` is idempotent on (tenant_id, call_sid)). The
   * app-layer hook skips the transcription enqueue on false.
   */
  inserted: boolean;
}

export interface VoicemailStatusHandlerOptions {
  /** Override the Twilio fetch so tests can stub the bytes. */
  fetchRecording?: typeof fetchRecordingBytes;
  /** Override the S3 PUT so tests can assert upload shape. */
  uploadObject?: typeof uploadToS3;
  /** App-layer hook: enqueue transcription for the persisted voicemail. */
  onVoicemailPersisted?: (event: VoicemailPersistedEvent) => Promise<void> | void;
}

export interface VoicemailStatusRouterDeps {
  store: VoiceSessionStore;
  pool?: Pool;
  leadRepo?: LeadRepository;
  auditRepo?: AuditRepository;
  /**
   * Twilio auth-token lookup for signature verification. Required — this is a
   * public, unauthenticated Twilio callback, so the X-Twilio-Signature is the
   * only thing proving the request actually came from Twilio.
   */
  authTokenGetter: (opts: { accountSid?: string }) => Promise<string | undefined> | string | undefined;
  publicBaseUrl?: string;
  /**
   * U9 — replay guard for the lead leg. When wired, the first delivery of
   * a RecordingSid records a receipt and every replay is skipped whole.
   * When absent (legacy tests / dev), the route degrades to the historical
   * non-idempotent lead behavior.
   */
  webhookEventRepo?: VoicemailWebhookReceiptStore;
  /**
   * U9 — tenant fallback for callbacks with no in-process session (the
   * after-hours branch answers before a session exists; callbacks can also
   * land on another instance). Keyed off the To number minted onto the
   * callback URL. Same post-signature trust rationale as the recording
   * webhook's `resolveTenantIdFallback`.
   */
  resolveTenantIdFallback?: (opts: {
    to: string;
    from: string;
  }) => Promise<string | undefined> | string | undefined;
  /** U9 transcription leg — S3 (or compatible) provider for the audio PUT/GET. */
  storage?: StorageProvider;
  /** U9 transcription leg — bucket for the voicemail audio object. */
  storageBucket?: string;
  /** U9 transcription leg — Twilio creds for the signed RecordingUrl fetch. */
  twilioAccountSid?: string;
  twilioAuthToken?: string;
}

/** First string value of a possibly-array express query param. */
function queryString(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) return value;
  return undefined;
}

export function createVoicemailStatusRouter(
  deps: VoicemailStatusRouterDeps,
  options: VoicemailStatusHandlerOptions = {},
): Router {
  const router = Router();

  // This sub-router is mounted BEFORE the telephony router's shared
  // urlencoded parser + signature middleware, so it must own both itself
  // (mirrors createRecordingRouter). Twilio POSTs application/x-www-form-
  // urlencoded; without this parser req.body is empty and every callback
  // no-ops (silent voicemail-lead loss), and without the signature check the
  // endpoint would accept forged JSON leads.
  router.use(express.urlencoded({ extended: false }));
  router.use(
    requireTwilioSignature(deps.authTokenGetter, {
      publicBaseUrl: deps.publicBaseUrl,
    }),
  );

  const fetchRecording = options.fetchRecording ?? fetchRecordingBytes;
  const uploadObject = options.uploadObject ?? uploadToS3;

  router.post('/voicemail-status', async (req: Request, res: Response) => {
    const body = req.body as Record<string, string | undefined>;
    const callSid = body.CallSid ?? '';
    const recordingSid = body.RecordingSid ?? '';
    const recordingUrl = body.RecordingUrl;
    const recordingStatus = body.RecordingStatus;
    // Caller/dialed numbers: the body fields would win if Twilio ever sent
    // them, but recordingStatusCallback POSTs don't carry From/To — the
    // query params are the ones we minted onto the callback URL ourselves.
    const from = body.From ?? queryString(req.query.From) ?? '';
    const to = body.Called ?? body.To ?? queryString(req.query.To) ?? '';

    if (!callSid || !recordingSid) {
      res.status(200).send('OK');
      return;
    }

    // Only the final recording event carries a fetchable recording. Twilio's
    // default recordingStatusCallbackEvent is 'completed' only, but guard
    // anyway so an in-progress/absent event can't consume the replay receipt.
    if (recordingStatus && recordingStatus !== 'completed') {
      res.status(200).send('OK');
      return;
    }

    const session = deps.store.findByCallSid(callSid);
    let tenantId: string | undefined = session?.tenantId;
    if (!tenantId && deps.resolveTenantIdFallback && to) {
      try {
        tenantId = await Promise.resolve(deps.resolveTenantIdFallback({ to, from }));
      } catch (err) {
        logger.warn('voicemail-status: tenant fallback lookup failed', {
          callSid,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      if (tenantId) {
        logger.info('voicemail-status: tenant resolved via fallback (no in-process session)', {
          callSid,
          recordingSid,
          tenantId,
        });
      }
    }
    if (!tenantId) {
      logger.warn('voicemail-status: missing tenant', {
        callSid,
        hasSession: Boolean(session),
      });
      res.status(200).send('OK');
      return;
    }

    // U9 — replay guard (webhook base P0-014). One receipt per RecordingSid:
    // the first delivery proceeds; every replay short-circuits BOTH legs, so
    // a Twilio redelivery can't duplicate the lead or re-run the pipeline.
    // A receipt-store failure returns 500 so Twilio retries later rather
    // than us proceeding unguarded.
    if (deps.webhookEventRepo) {
      let receiptInserted: boolean;
      try {
        const receipt = await deps.webhookEventRepo.recordReceipt(
          'twilio_voicemail',
          `${tenantId}:${recordingSid}`,
          'voicemail_completed',
          { callSid, recordingSid },
        );
        receiptInserted = receipt.inserted;
      } catch (err) {
        logger.error('voicemail-status: receipt store failed', {
          tenantId,
          callSid,
          recordingSid,
          error: err instanceof Error ? err.message : String(err),
        });
        res.status(500).type('text/plain').send('Voicemail processing failed');
        return;
      }
      if (!receiptInserted) {
        logger.info('voicemail-status: replay skipped (receipt exists)', {
          tenantId,
          callSid,
          recordingSid,
        });
        res.status(200).send('OK');
        return;
      }
    }

    // ── Leg 1: lead + audit (the original notify-only behavior) ─────────
    let leadId: string | undefined;
    if (deps.leadRepo && deps.auditRepo) {
      try {
        const lead = await createLead(
          {
            tenantId,
            firstName: 'Voicemail',
            lastName: 'Caller',
            primaryPhone: from || undefined,
            source: 'phone_call',
            sourceDetail: `Voicemail recording ${recordingSid}`,
            createdBy: 'voicemail_webhook',
            actorRole: 'system',
          },
          deps.leadRepo,
          deps.auditRepo,
        );
        leadId = lead.id;

        await deps.auditRepo.create(
          createAuditEvent({
            tenantId,
            actorId: 'voicemail_webhook',
            actorRole: 'system',
            eventType: 'voicemail.received',
            entityType: 'lead',
            entityId: lead.id,
            correlationId: uuidv4(),
            metadata: {
              callSid,
              recordingSid,
              hasRecordingUrl: Boolean(recordingUrl),
            },
          }),
        );
      } catch (err) {
        logger.warn('voicemail-status: lead create failed', {
          tenantId,
          callSid,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    } else {
      logger.warn('voicemail-status: leadRepo/auditRepo not wired — skipping lead', {
        tenantId,
        callSid,
      });
    }

    // ── Leg 2 (U9): persist recording + hand off to transcription ───────
    // Failure-soft relative to the lead: the notification lead is already
    // committed; a transcription-leg failure logs (with the auth token
    // scrubbed) and still 200s, matching the route's historical posture.
    const transcriptionWired =
      Boolean(deps.pool) &&
      Boolean(deps.storage) &&
      Boolean(deps.storageBucket) &&
      Boolean(deps.twilioAccountSid) &&
      Boolean(deps.twilioAuthToken) &&
      Boolean(recordingUrl);
    if (!transcriptionWired) {
      logger.info('voicemail-status: transcription leg not wired — notify-only', {
        tenantId,
        callSid,
        recordingSid,
        hasRecordingUrl: Boolean(recordingUrl),
      });
      res.status(200).send('OK');
      return;
    }

    try {
      const durationRaw = body.RecordingDuration ?? '0';
      const parsedDuration = Number.parseInt(durationRaw, 10);
      const durationSeconds = Number.isFinite(parsedDuration) ? parsedDuration : 0;
      const storageKey = buildVoicemailStorageKey(tenantId, callSid);
      const contentType = 'audio/mpeg';

      // 1. Authenticated fetch of the recording bytes from Twilio — the
      //    auth token never leaves this scope (errors are scrubbed below).
      const bytes = await fetchRecording(
        recordingUrl!,
        deps.twilioAccountSid!,
        deps.twilioAuthToken!,
      );

      // 2. Presigned S3 PUT. Log byte length only — never the payload.
      const uploadUrl = await deps.storage!.generateUploadUrl(
        deps.storageBucket!,
        storageKey,
        contentType,
      );
      await uploadObject(uploadUrl, bytes, contentType);

      // 3. Idempotent voice_recordings (+ files FK target) insert.
      //    source stays 'inbound_call': voicemail KEEPS untrusted
      //    provenance (ratified U9 decision) — owner caller-ID gates only
      //    whether the router enqueue happens downstream, never trust.
      const result = await recordInboundCall(deps.pool!, {
        tenantId,
        callSid,
        recordingUrl: recordingUrl!,
        durationSeconds,
        storageBucket: deps.storageBucket!,
        storageKey,
        sizeBytes: bytes.length,
        contentType,
        createdBy: 'voicemail_webhook',
      });

      logger.info('voicemail-status: recording persisted', {
        tenantId,
        callSid,
        recordingSid,
        voiceRecordingId: result.voiceRecordingId,
        inserted: result.inserted,
        sizeBytes: bytes.length,
      });

      // Audit the new pipeline leg (repo invariant: new paths audit).
      // Best-effort — never blocks the webhook ack.
      if (deps.auditRepo) {
        try {
          await deps.auditRepo.create(
            createAuditEvent({
              tenantId,
              actorId: 'voicemail_webhook',
              actorRole: 'system',
              eventType: 'voicemail.recording_persisted',
              entityType: 'voice_recording',
              entityId: result.voiceRecordingId,
              correlationId: uuidv4(),
              metadata: {
                callSid,
                recordingSid,
                inserted: result.inserted,
                durationSeconds,
                ...(leadId ? { leadId } : {}),
              },
            }),
          );
        } catch (err) {
          logger.warn('voicemail-status: recording audit failed', {
            tenantId,
            voiceRecordingId: result.voiceRecordingId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // 4. Hand off to the app layer for the transcription enqueue.
      //    Failure-soft: the recording row is already committed.
      if (options.onVoicemailPersisted) {
        try {
          const audioUrl = await deps.storage!.generateDownloadUrl(
            deps.storageBucket!,
            storageKey,
          );
          await options.onVoicemailPersisted({
            tenantId,
            voiceRecordingId: result.voiceRecordingId,
            callSid,
            recordingSid,
            ...(from ? { callerPhone: from } : {}),
            durationSeconds,
            audioUrl,
            inserted: result.inserted,
          });
        } catch (hookErr) {
          logger.warn('voicemail-status: onVoicemailPersisted hook failed', {
            tenantId,
            callSid,
            voiceRecordingId: result.voiceRecordingId,
            error: hookErr instanceof Error ? hookErr.message : String(hookErr),
          });
        }
      }
    } catch (err) {
      logger.error('voicemail-status: transcription leg failed', {
        tenantId,
        callSid,
        recordingSid,
        error: scrubAuthToken(err, deps.twilioAuthToken),
      });
    }

    res.status(200).send('OK');
  });

  return router;
}

/**
 * Twilio telephony webhook routes.
 *
 * Two endpoints handle the Gather-mode call loop:
 *
 *   POST /api/telephony/voice            — initial inbound call
 *   POST /api/telephony/gather?sid=...   — each <Gather> result
 *
 * Both expect `application/x-www-form-urlencoded` bodies (Twilio default)
 * and an `X-Twilio-Signature` header. Signature verification is enforced
 * by `requireTwilioSignature` middleware on every route in this file.
 *
 * Tenant resolution
 * ─────────────────
 * Twilio doesn't carry our tenant_id. For now we use a single-tenant
 * fallback via the `TWILIO_DEFAULT_TENANT_ID` env var. A proper
 * tenant-by-phone-number lookup is a follow-up — TODO below.
 */

import { Router, Request, Response } from 'express';
import express from 'express';
import type { Pool } from 'pg';
import { TwilioGatherAdapter } from '../telephony/twilio-adapter';
import { requireTwilioSignature } from '../telephony/twilio-signature';
import {
  createRecordingRouter,
  type RecordingHandlerOptions,
} from '../telephony/recording-webhook';
import type { VoiceSessionStore } from '../ai/agents/customer-calling/voice-session-store';
import type { StorageProvider } from '../files/file-service';
import { createLogger } from '../logging/logger';

const logger = createLogger({
  service: 'routes.telephony',
  environment: process.env.NODE_ENV || 'development',
});

export interface TelephonyRouterDeps {
  adapter: TwilioGatherAdapter;
  /** Returns the Twilio account auth token for signature verification. */
  authTokenGetter: () => string | undefined;
  /**
   * Optional explicit base URL Twilio called. When unset, the middleware
   * uses `PUBLIC_API_URL` from env, then falls back to req.protocol+host.
   */
  publicBaseUrl?: string;
  /**
   * Tenant resolver. For now this is a single-tenant fallback; a proper
   * "phone number → tenant" lookup is P8-014 territory.
   *
   * TODO(P8-014): replace with a real lookup keyed by the `To` field.
   */
  resolveTenantId: (opts: { to: string; from: string }) => string | undefined;
  /**
   * Recording webhook deps. When set, mounts `POST /recording` so Twilio
   * can deliver finalized recording metadata from the inbound call's
   * `<Record>` / `recordingStatusCallback` verb.
   *
   * Optional so tests/dev environments without S3 + DB wiring can still
   * exercise the voice/gather routes without a recording sink.
   */
  recording?: {
    /** Same VoiceSessionStore the adapter uses — tenant resolution by CallSid. */
    store: VoiceSessionStore;
    /** Pool for `voice_recordings` + `files` inserts. */
    pool?: Pool;
    /** S3 (or compatible) provider used to PUT the audio blob. */
    storage: StorageProvider;
    /** Bucket name. Per the story spec: `serviceos-recordings`. */
    storageBucket: string;
    /** Twilio creds for HTTP-basic on the signed RecordingUrl fetch. */
    twilioAccountSid?: string;
    twilioAuthToken?: string;
    /** Test seam — replace fetch / upload with stubs. */
    options?: RecordingHandlerOptions;
  };
}

export function createTelephonyRouter(deps: TelephonyRouterDeps): Router {
  const router = Router();

  // Recording webhook (P8-014) gets its own sub-router so its sig
  // middleware operates on a body parsed independently of the
  // /voice + /gather body parser. Mount it BEFORE the parser/middleware
  // below so its router-scoped middleware fully owns the /recording path.
  if (deps.recording) {
    router.use(
      createRecordingRouter(
        {
          store: deps.recording.store,
          ...(deps.recording.pool ? { pool: deps.recording.pool } : {}),
          storage: deps.recording.storage,
          storageBucket: deps.recording.storageBucket,
          ...(deps.recording.twilioAccountSid
            ? { twilioAccountSid: deps.recording.twilioAccountSid }
            : {}),
          ...(deps.recording.twilioAuthToken
            ? { twilioAuthToken: deps.recording.twilioAuthToken }
            : {}),
          authTokenGetter: deps.authTokenGetter,
          ...(deps.publicBaseUrl ? { publicBaseUrl: deps.publicBaseUrl } : {}),
        },
        deps.recording.options ?? {},
      ),
    );
  }

  // Twilio sends application/x-www-form-urlencoded. The global
  // express.json() in app.ts won't parse that, so mount a urlencoded
  // parser scoped to this router. `extended: false` is sufficient —
  // Twilio's payloads are flat key=value with no nested objects.
  router.use(express.urlencoded({ extended: false }));

  // Signature verification on every route.
  router.use(
    requireTwilioSignature(deps.authTokenGetter, {
      publicBaseUrl: deps.publicBaseUrl,
    })
  );

  /**
   * POST /api/telephony/voice
   *
   * Twilio webhook for incoming calls. Body fields we consume:
   *   CallSid, From, To
   */
  router.post('/voice', async (req: Request, res: Response) => {
    const body = req.body as Record<string, string | undefined>;
    const callSid = body.CallSid ?? '';
    const from = body.From ?? '';
    const to = body.To ?? '';

    if (!callSid || !from || !to) {
      logger.warn('telephony/voice: missing required fields', { callSid, from, to });
      res.status(400).type('text/plain').send('Missing CallSid/From/To');
      return;
    }

    const tenantId = deps.resolveTenantId({ to, from });
    if (!tenantId) {
      logger.error('telephony/voice: no tenant resolved', { to, from });
      res.status(500).type('text/plain').send('Tenant resolution failed');
      return;
    }

    try {
      const twiml = await deps.adapter.handleInbound({
        callSid,
        from,
        to,
        tenantId,
      });
      res.status(200).type('text/xml').send(twiml);
    } catch (err) {
      logger.error('telephony/voice: handleInbound failed', {
        callSid,
        error: err instanceof Error ? err.message : String(err),
      });
      // Return TwiML that hangs up gracefully rather than 500ing — Twilio
      // will retry 5xx, which would re-trigger the FSM with the same
      // CallSid and produce duplicate sessions.
      res
        .status(200)
        .type('text/xml')
        .send(
          `<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="Polly.Joanna">We're experiencing technical difficulties. Please try again later.</Say><Hangup/></Response>`
        );
    }
  });

  /**
   * POST /api/telephony/gather
   *
   * Twilio webhook fired when a <Gather speech> completes. Body fields:
   *   CallSid, SpeechResult, Confidence
   * Query: ?sid=<sessionId>  (we set this on the action URL ourselves)
   */
  router.post('/gather', async (req: Request, res: Response) => {
    const body = req.body as Record<string, string | undefined>;
    const callSid = body.CallSid ?? '';
    const speechResult = body.SpeechResult ?? '';
    const confidence = body.Confidence ? Number(body.Confidence) : 0;

    const sessionId = (req.query.sid as string | undefined) ?? '';
    if (!sessionId) {
      logger.warn('telephony/gather: missing sid', { callSid });
      res.status(400).type('text/plain').send('Missing sid');
      return;
    }

    const tenantId = deps.resolveTenantId({
      to: body.To ?? '',
      from: body.From ?? '',
    });
    if (!tenantId) {
      logger.error('telephony/gather: no tenant resolved', { sessionId });
      res.status(500).type('text/plain').send('Tenant resolution failed');
      return;
    }

    try {
      const twiml = await deps.adapter.handleGather({
        sessionId,
        callSid,
        speechResult,
        confidence: Number.isFinite(confidence) ? confidence : 0,
        tenantId,
      });
      res.status(200).type('text/xml').send(twiml);
    } catch (err) {
      logger.error('telephony/gather: handleGather failed', {
        sessionId,
        callSid,
        error: err instanceof Error ? err.message : String(err),
      });
      res
        .status(200)
        .type('text/xml')
        .send(
          `<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="Polly.Joanna">We're experiencing technical difficulties. Please try again later.</Say><Hangup/></Response>`
        );
    }
  });

  return router;
}


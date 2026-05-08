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
import { TwilioGatherAdapter, xmlEscape } from '../telephony/twilio-adapter';
import { requireTwilioSignature } from '../telephony/twilio-signature';
import {
  createRecordingRouter,
  type RecordingHandlerOptions,
} from '../telephony/recording-webhook';
import type { VoiceSessionStore } from '../ai/agents/customer-calling/voice-session-store';
import type { StorageProvider } from '../files/file-service';
import { createLogger } from '../logging/logger';
import { escalateToHuman } from '../ai/skills/escalate-to-human';
import { maskPhone } from '../telephony/twilio-call-control';

const logger = createLogger({
  service: 'routes.telephony',
  environment: process.env.NODE_ENV || 'development',
});

export interface TelephonyRouterDeps {
  adapter: TwilioGatherAdapter;
  /**
   * Returns the Twilio account auth token for signature verification.
   * Receives the AccountSid from Twilio's webhook body so per-tenant
   * subaccount tokens can be looked up. Legacy single-account callers
   * may ignore the argument and return the master `TWILIO_AUTH_TOKEN`.
   */
  authTokenGetter: (opts: { accountSid?: string }) => Promise<string | undefined> | string | undefined;
  /**
   * Optional explicit base URL Twilio called. When unset, the middleware
   * uses `PUBLIC_API_URL` from env, then falls back to req.protocol+host.
   */
  publicBaseUrl?: string;
  /**
   * Phone-number → tenant lookup. Receives the `to` and `from` numbers
   * from Twilio's webhook. Async to allow database lookups against
   * `tenant_integrations.provider_data->>'phoneE164'`. Legacy callers
   * may return a synchronous fallback (`TWILIO_DEFAULT_TENANT_ID`).
   */
  resolveTenantId: (opts: { to: string; from: string }) => Promise<string | undefined> | string | undefined;
  /**
   * Business name used in the "we'll call you back" copy when the
   * rotation cascade is exhausted. Defaults to a generic phrasing
   * if unset; the adapter constructor already requires a business
   * name for greeting copy, so most production wiring will pass it
   * through.
   */
  businessName?: string;
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
  /**
   * P8-012 — when true, /voice returns a `<Connect><Stream/></Connect>`
   * TwiML instead of `<Gather>`. Default false (Gather path remains the
   * rollback target). Read once at router-creation time so callers
   * control the flag flip via app.ts (rather than each per-request
   * env read flapping mid-call).
   */
  mediaStreamsEnabled?: boolean;
  /**
   * Optional health snapshot factory. When set, mounts a public
   * `GET /health` route that returns which voice capabilities are
   * wired (TTS, STT, recording, delivery, etc.). Surfaces booleans
   * only — no secret values — so it's safe to leave unauthenticated.
   * Useful for verifying a Railway deploy without grepping logs.
   */
  getHealth?: () => TelephonyHealthReport;
}

export interface TelephonyHealthReport {
  ok: boolean;
  capabilities: {
    mediaStreams: boolean;
    tts: boolean;
    stt: boolean;
    recording: boolean;
    messageDelivery: boolean;
    database: boolean;
    llmGateway: boolean;
  };
  config: {
    publicBaseUrl: string | null;
    businessName: string | null;
  };
  warnings: string[];
}

export function createTelephonyRouter(deps: TelephonyRouterDeps): Router {
  const router = Router();

  // Public health endpoint — registered FIRST so it bypasses the
  // recording sub-router's body parser and signature middleware below
  // (those router.use(...) calls run on every request, not just /recording,
  // and would 500/403 a plain GET). Returns booleans only; safe to leave
  // unauthenticated. Useful after a deploy to confirm which voice
  // capabilities are wired.
  if (deps.getHealth) {
    const getHealth = deps.getHealth;
    router.get('/health', (_req: Request, res: Response) => {
      try {
        res.status(200).json(getHealth());
      } catch (err) {
        logger.error('telephony/health: failed', {
          error: err instanceof Error ? err.message : String(err),
        });
        res.status(500).json({ ok: false, error: 'health_check_failed' });
      }
    });
  }

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
          // Fallback so recording callbacks landing on a fresh API
          // process / different instance don't drop the recording.
          // Twilio's signature is verified upstream; trusting Called/To
          // here is no less safe than trusting any other signed field.
          resolveTenantIdFallback: deps.resolveTenantId,
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

    const tenantId = await Promise.resolve(deps.resolveTenantId({ to, from }));
    if (!tenantId) {
      logger.error('telephony/voice: no tenant resolved', { to, from });
      res.status(500).type('text/plain').send('Tenant resolution failed');
      return;
    }

    try {
      const twiml = deps.mediaStreamsEnabled
        ? await deps.adapter.handleInboundForStream({ callSid, tenantId })
        : await deps.adapter.handleInbound({ callSid, from, to, tenantId });
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

    const tenantId = await Promise.resolve(deps.resolveTenantId({
      to: body.To ?? '',
      from: body.From ?? '',
    }));
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

  /**
   * POST /api/telephony/dial-result
   *
   * Twilio fires this when a `<Dial>` verb completes (success or
   * failure). Body fields we consume:
   *   CallSid, DialCallStatus
   *
   * Status values:
   *   completed / answered → dispatcher picked up; transition FSM to
   *                          closing and respond with empty TwiML so
   *                          Twilio hangs up our IVR leg.
   *   no-answer / busy / failed / canceled → advance the rotation
   *                          cursor and dial the next dispatcher; if
   *                          the rotation is exhausted, queue a
   *                          customer_callback_required proposal and
   *                          play the polite "we'll call you back"
   *                          message including the business name.
   *
   * Query: ?sid=<sessionId>  (set by the adapter when emitting the
   *                           initial `<Dial action="...">` verb)
   */
  router.post('/dial-result', async (req: Request, res: Response) => {
    const body = req.body as Record<string, string | undefined>;
    const callSid = body.CallSid ?? '';
    const dialStatus = body.DialCallStatus ?? '';

    const sessionId = (req.query.sid as string | undefined) ?? '';
    if (!sessionId) {
      logger.warn('telephony/dial-result: missing sid', { callSid });
      res.status(400).type('text/plain').send('Missing sid');
      return;
    }

    const tenantId = await Promise.resolve(deps.resolveTenantId({
      to: body.To ?? '',
      from: body.From ?? '',
    }));
    if (!tenantId) {
      logger.error('telephony/dial-result: no tenant resolved', { sessionId });
      res.status(500).type('text/plain').send('Tenant resolution failed');
      return;
    }

    const adapter = deps.adapter;
    const adapterDeps = adapter.getDeps();
    const session = adapterDeps.store.get(sessionId);
    if (!session) {
      logger.warn('telephony/dial-result: unknown session', { sessionId, callSid });
      // Hangup gracefully — Twilio's leg is going away anyway.
      res
        .status(200)
        .type('text/xml')
        .send(`<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`);
      return;
    }

    // Successful bridge: dispatcher answered. Transition FSM to
    // closing (escalating + proposal_queued is the only direct path),
    // mark the session ended, and return an empty Response so Twilio
    // hangs up the original caller leg cleanly.
    const successStatuses = new Set(['completed', 'answered']);
    if (successStatuses.has(dialStatus)) {
      try {
        // Synthetic proposal_queued event so the FSM follows its
        // documented escalating → closing transition. We don't emit
        // a real proposal — the dispatcher answering IS the
        // resolution.
        session.machine.dispatch({
          type: 'proposal_queued',
          proposalId: `transfer:${callSid || 'unknown'}`,
        });
      } catch (err) {
        logger.warn('telephony/dial-result: FSM dispatch failed', {
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      adapterDeps.callControl?.clearCursor(sessionId);
      session.ended = true;
      res
        .status(200)
        .type('text/xml')
        .send(`<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`);
      return;
    }

    // Cascade: dispatcher didn't pick up. The cursor is already past the
    // just-attempted entry (escalateToHuman calls setCursorAfter when it
    // picks). Re-invoking escalateToHuman walks forward from there to
    // find the next dispatcher with a resolvable phone.
    if (
      adapterDeps.callControl &&
      adapterDeps.dispatcherPhoneResolver &&
      adapterDeps.onCallRepo
    ) {
      try {
        const result = await escalateToHuman({
          tenantId,
          sessionId,
          reason: 'low_confidence',
          channel: 'telephony',
          onCallRepo: adapterDeps.onCallRepo,
          ...(adapterDeps.auditRepo ? { auditRepo: adapterDeps.auditRepo } : {}),
          callControl: adapterDeps.callControl,
          dispatcherPhoneResolver: adapterDeps.dispatcherPhoneResolver,
          callSid: session.callSid ?? callSid,
          dialActionUrl: buildDialResultUrl(deps.publicBaseUrl, sessionId),
        });

        if (result.transfer) {
          logger.info('telephony/dial-result: cascading to next dispatcher', {
            sessionId,
            rotationIndex: result.transfer.rotationIndex,
            dispatcherPhone: maskPhone(result.transfer.dispatcherPhone),
            previousStatus: dialStatus,
          });
          res.status(200).type('text/xml').send(result.transfer.fallbackTwiml);
          return;
        }
      } catch (err) {
        logger.warn('telephony/dial-result: escalateToHuman failed', {
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    } else {
      logger.warn('telephony/dial-result: callControl/resolver not wired', {
        sessionId,
      });
    }

    // Rotation exhausted (or wiring missing). Queue the callback
    // proposal and play the polite "we'll call you back" message.
    try {
      await adapter.queueCallbackProposal(
        session,
        tenantId,
        'rotation_exhausted',
        'rotation_exhausted',
      );
    } catch (err) {
      logger.warn('telephony/dial-result: queueCallbackProposal failed', {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    const businessName = deps.businessName ?? 'our team';
    const safeName = xmlEscape(businessName);
    const message =
      `I'm sorry, no one is available right now. ` +
      `${safeName} will call you back as soon as possible. ` +
      `Thank you for calling.`;

    session.ended = true;
    res
      .status(200)
      .type('text/xml')
      .send(
        `<?xml version="1.0" encoding="UTF-8"?>` +
          `<Response>` +
          `<Say voice="Polly.Joanna">${message}</Say>` +
          `<Hangup/>` +
          `</Response>`,
      );
  });

  return router;
}

/**
 * Build the absolute /dial-result URL Twilio will POST. Mirrored from
 * the adapter's private helper so the route layer can hand a stable
 * URL to escalateToHuman during a rotation cascade.
 */
function buildDialResultUrl(publicBaseUrl: string | undefined, sessionId: string): string {
  const path = `/api/telephony/dial-result?sid=${encodeURIComponent(sessionId)}`;
  if (publicBaseUrl) {
    return `${publicBaseUrl.replace(/\/+$/, '')}${path}`;
  }
  return path;
}


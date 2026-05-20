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
 * Tenant resolution (D2-3)
 * ────────────────────────
 * Twilio doesn't carry our tenant_id. We resolve it by looking the dialed
 * "To" number up in `tenant_integrations` (via PhoneNumberRepository).
 *
 *   • Found  → use that tenant for the rest of the call.
 *   • Missed in prod/staging → emit a Sentry `error` event, log
 *     `telephony.tenant_lookup_miss`, and return 200 + "this number
 *     is not in service" TwiML so Twilio doesn't 5xx-retry.
 *   • Missed in dev → if `TWILIO_DEFAULT_TENANT_ID` is set we use it but
 *     log a loud WARN; if unset we return the same decline TwiML.
 *
 * The legacy `TWILIO_DEFAULT_TENANT_ID` env var is now ONLY a dev seam
 * and is explicitly disabled in prod/staging.
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
import {
  normalizeE164,
  type PhoneNumberRepository,
} from '../integrations/twilio/phone-number-repository';
import { getSentryClient, type SentryClient } from '../monitoring/sentry';
import { buildVoicemailTwiml } from '../telephony/voicemail-fallback';
import { isTenantAfterHours } from '../telephony/business-hours-loader';
import { createVoicemailStatusRouter } from '../telephony/voicemail-status-route';
import type { SettingsRepository } from '../settings/settings';
import { resolveEscalationSettings } from '../settings/settings';
import type { LeadRepository } from '../leads/lead';

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
   * D2-3 — primary phone-number → tenant lookup. Inbound Twilio webhooks
   * carry only the dialed "To" number; we resolve that to a tenant via
   * the `tenant_integrations.provider_data->>'phoneE164'` mapping.
   *
   * When omitted, falls back to the legacy `resolveTenantId` callback
   * (existing tests and the dispatched recording/dial-result paths
   * still use that path). New wiring SHOULD provide the repo so unknown
   * numbers can be rejected with a polite TwiML instead of silently
   * routing to `TWILIO_DEFAULT_TENANT_ID`.
   */
  phoneNumberRepo?: PhoneNumberRepository;
  /**
   * Legacy phone-number → tenant lookup callback. Kept for the
   * `/gather` and `/dial-result` endpoints (which already have a
   * tenant from /voice) and for callers that pre-date `phoneNumberRepo`.
   * For `/voice`, `phoneNumberRepo` is consulted first.
   */
  resolveTenantId: (opts: { to: string; from: string }) => Promise<string | undefined> | string | undefined;
  /**
   * D2-3 — test seam for the Sentry client used to capture
   * `telephony.tenant_lookup_miss` events. Defaults to
   * `getSentryClient()`, which falls back to a no-op when Sentry isn't
   * configured for the environment.
   */
  sentry?: SentryClient;
  /**
   * D2-3 — `process.env.NODE_ENV` override. Pure test seam; production
   * code never needs to set this. When `'production' | 'prod' | 'staging'`,
   * the `TWILIO_DEFAULT_TENANT_ID` fallback is refused even if the env
   * var is set.
   */
  nodeEnv?: string;
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
   * §10 onboarding — optional pre-flight gate run after tenant
   * resolution and before AI routing. Composes the subscription
   * status check (Gate A) and trial usage caps (Gate B). When
   * `allowed=false`, the /voice route returns voicemail TwiML
   * instead of invoking the adapter.
   *
   * When unset, no gate runs (legacy behavior).
   */
  voiceGate?: (input: { tenantId: string; callSid: string }) => Promise<{
    allowed: boolean;
    reason?: 'no_billing' | 'trial_cap_daily' | 'trial_cap_total' | 'trial_cap_concurrent';
  }>;
  /**
   * Optional health snapshot factory. When set, mounts a public
   * `GET /health` route that returns which voice capabilities are
   * wired (TTS, STT, recording, delivery, etc.). Surfaces booleans
   * only — no secret values — so it's safe to leave unauthenticated.
   * Useful for verifying a Railway deploy without grepping logs.
   */
  getHealth?: () => TelephonyHealthReport;
  pool?: Pool;
  settingsRepo?: SettingsRepository;
  leadRepo?: LeadRepository;
  auditRepo?: import('../audit/audit').AuditRepository;
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
  if (deps.recording?.store) {
    router.use(
      createVoicemailStatusRouter({
        store: deps.recording.store,
        pool: deps.pool,
        leadRepo: deps.leadRepo,
        auditRepo: deps.auditRepo,
      }),
    );
  }

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

    let tenantId: string | undefined;
    try {
      tenantId = await resolveInboundTenantId({
        to,
        from,
        callSid,
        deps,
      });
    } catch (err) {
      // Codex P1 (PR #384) — transient infra failures (DB outage during
      // phone-number lookup) propagate as throws from
      // resolveInboundTenantId in prod. Respond 5xx so Twilio retries
      // the webhook; do NOT 200-decline (which would falsely tell the
      // caller a real number is unassigned).
      logger.error('telephony/voice: tenant lookup failed', {
        callSid,
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(503).type('text/plain').send('Service temporarily unavailable');
      return;
    }

    if (!tenantId) {
      // D2-3 — unknown DID. Sentry event + structured log already emitted
      // inside resolveInboundTenantId. Reply 200 + decline TwiML so Twilio
      // doesn't retry the webhook and so the caller hears a graceful
      // "not in service" rather than dead air.
      res
        .status(200)
        .type('text/xml')
        .send(numberNotInServiceTwiml());
      return;
    }

    // §10 voice gates — subscription status + trial usage caps. Logged
    // via voiceBlocksTotal counter inside the gate; emits an audit event
    // per block. Returns voicemail TwiML on block so leads can still leave
    // a message (Twilio still bills the minute, but AI/OpenAI cost is zero).
    if (deps.voiceGate) {
      try {
        const gate = await deps.voiceGate({ tenantId, callSid });
        if (!gate.allowed) {
          res
            .status(200)
            .type('text/xml')
            .send(
              `<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="Polly.Joanna">This number is being set up. Please leave a message after the tone.</Say><Record maxLength="120" playBeep="true"/><Hangup/></Response>`,
            );
          return;
        }
      } catch (err) {
        // Gate failures must not block real calls — log and fall through.
        logger.error('telephony/voice: voiceGate failed open', {
          callSid,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const shopName = deps.businessName ?? 'our team';
    if (deps.pool && deps.settingsRepo) {
      try {
        const afterHours = await isTenantAfterHours(deps.pool, tenantId);
        if (afterHours) {
          const settings = await deps.settingsRepo.findByTenant(tenantId);
          const esc = resolveEscalationSettings(settings);
          if (esc.after_hours_voice_mode !== 'ai_answering') {
            const base = (deps.publicBaseUrl ?? '').replace(/\/+$/, '');
            const callback = base
              ? `${base}/api/telephony/voicemail-status`
              : '/api/telephony/voicemail-status';
            res.status(200).type('text/xml').send(
              buildVoicemailTwiml({ shopName, recordingStatusCallback: callback }),
            );
            return;
          }
        }
      } catch (err) {
        logger.warn('telephony/voice: after-hours check failed open', {
          callSid,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    try {
      const twiml = deps.mediaStreamsEnabled
        ? await deps.adapter.handleInboundForStream({ callSid, from, tenantId })
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
      // B2 — stamp voice_sessions.outcome before Twilio hangs up. The
      // synthetic proposal_queued dispatched above moved the FSM to
      // `closing` but no real proposal id is on session.proposalIds, so
      // we pass the explicit `transferred` reason that the mapper resolves
      // to 'completed' regardless of the heuristics. Without this, the
      // dial-success branch would leave voice_sessions.ended_at NULL.
      adapter.finalizeTerminatedSession(session, [], 'transferred');
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
    session.ended = true;
    adapter.finalizeTerminatedSession(session, [], 'normal_close');

    const base = (deps.publicBaseUrl ?? '').replace(/\/+$/, '');
    const callback = base
      ? `${base}/api/telephony/voicemail-status`
      : '/api/telephony/voicemail-status';
    res
      .status(200)
      .type('text/xml')
      .send(buildVoicemailTwiml({ shopName: businessName, recordingStatusCallback: callback }));
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

/**
 * D2-3 — TwiML returned when the dialed number is not provisioned for any
 * tenant. We respond 200 (not 5xx) so Twilio doesn't retry the webhook
 * and so the caller hears the message instead of dead air. The hangup
 * after the Say verb ensures the call leg terminates promptly.
 */
function numberNotInServiceTwiml(): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Response>` +
    `<Say voice="Polly.Joanna">This number is not in service. Goodbye.</Say>` +
    `<Hangup/>` +
    `</Response>`
  );
}

/**
 * D2-3 — inbound `/voice` tenant resolution path.
 *
 * Precedence:
 *   1. `phoneNumberRepo.findByNumber(To)` — the real lookup.
 *   2. (dev only) legacy `resolveTenantId({to, from})` callback, which
 *      historically wrapped a SQL query plus `TWILIO_DEFAULT_TENANT_ID`
 *      fallback. We accept whatever it returns but log a loud WARN
 *      whenever the dev fallback resolves a tenant the repo could not.
 *   3. (dev only) `process.env.TWILIO_DEFAULT_TENANT_ID` as a last-ditch
 *      seam for local development without a populated `tenant_integrations`
 *      row.
 *
 * In production / staging, only (1) is accepted. A miss returns
 * `undefined`, emits a Sentry `error` event, and the caller responds
 * with the "not in service" TwiML.
 */
async function resolveInboundTenantId(opts: {
  to: string;
  from: string;
  callSid: string;
  deps: TelephonyRouterDeps;
}): Promise<string | undefined> {
  const { to, from, callSid, deps } = opts;
  const normalizedTo = normalizeE164(to);

  // 1) Primary path — phone-numbers repo lookup.
  if (deps.phoneNumberRepo) {
    try {
      const lookup = await deps.phoneNumberRepo.findByNumber(normalizedTo);
      if (lookup) {
        return lookup.tenantId;
      }
    } catch (err) {
      // Codex P1 (PR #384) — distinguish "tenant not found" (terminal,
      // 200 decline) from "DB outage" (transient, 5xx so Twilio
      // retries). Previously the catch silently fell through to the
      // dev-fallback logic which then 200-declined in prod, turning
      // every transient DB blip into permanent "number not in service"
      // misroutes and suppressing Twilio's retry behavior.
      logger.error('telephony.tenant_lookup_error', {
        to: normalizedTo,
        callSid,
        error: err instanceof Error ? err.message : String(err),
      });
      const sentry = deps.sentry ?? getSentryClient();
      sentry.captureMessage('telephony.tenant_lookup_error', 'error');

      // In prod / staging, re-throw so the route returns 5xx. In dev,
      // continue to the legacy/env fallback so local development against
      // a broken Pg doesn't lock out test calls.
      const nodeEnv = deps.nodeEnv ?? process.env.NODE_ENV ?? 'development';
      const isProdLike =
        nodeEnv === 'production' || nodeEnv === 'prod' || nodeEnv === 'staging';
      if (isProdLike) {
        throw err;
      }
    }
  }

  // 2) Dev-only fallback. Refuse outright in prod/staging.
  const nodeEnv = deps.nodeEnv ?? process.env.NODE_ENV ?? 'development';
  const isProdLike = nodeEnv === 'production' || nodeEnv === 'prod' || nodeEnv === 'staging';

  if (isProdLike) {
    logger.error('telephony.tenant_lookup_miss', {
      to: normalizedTo,
      callSid,
      env: nodeEnv,
    });
    const sentry = deps.sentry ?? getSentryClient();
    sentry.captureMessage('telephony.tenant_lookup_miss', 'error');
    return undefined;
  }

  // Dev path — try the legacy resolver, then the env var.
  try {
    const legacy = await Promise.resolve(deps.resolveTenantId({ to: normalizedTo, from }));
    if (legacy) {
      logger.warn('telephony.tenant_lookup_dev_fallback', {
        to: normalizedTo,
        callSid,
        source: 'resolveTenantId',
        env: nodeEnv,
      });
      return legacy;
    }
  } catch (err) {
    logger.warn('telephony.tenant_lookup_legacy_resolver_failed', {
      to: normalizedTo,
      callSid,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const envFallback = process.env.TWILIO_DEFAULT_TENANT_ID;
  if (envFallback) {
    logger.warn('telephony.tenant_lookup_dev_fallback', {
      to: normalizedTo,
      callSid,
      source: 'TWILIO_DEFAULT_TENANT_ID',
      env: nodeEnv,
    });
    return envFallback;
  }

  // Dev miss with nothing configured — still log + Sentry so dev surfaces
  // misconfigured webhooks early instead of hearing dead air.
  logger.error('telephony.tenant_lookup_miss', {
    to: normalizedTo,
    callSid,
    env: nodeEnv,
  });
  const sentry = deps.sentry ?? getSentryClient();
  sentry.captureMessage('telephony.tenant_lookup_miss', 'error');
  return undefined;
}


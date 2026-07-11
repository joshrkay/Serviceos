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
import type { GateReason } from '../voice/trial-limits';
import { t, type Language } from '../ai/i18n/i18n';
import type { CallMeBackRepository } from '../voice/call-me-back/call-me-back';
import { createAuditEvent } from '../audit/audit';
import { isValidTenantId } from '../db/schema';

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
   * WS3 (voice ingestion resilience) — per-tenant staged rollout of the
   * realtime (media-streams) path. When `mediaStreamsEnabled` (the global
   * master switch) is on, the /voice branch additionally consults the
   * `voice_realtime` tenant flag via `isEnabledForTenantWithDefault(tenantId,
   * 'voice_realtime', true)`. Default-ON means an unconfigured tenant still
   * gets the realtime path (the global env is the true master switch); a
   * per-tenant override of `enabled=false` is a kill switch that pins that
   * tenant to Gather. A flag-read failure falls toward Gather (the proven
   * path), never toward Stream.
   *
   * When unwired (in-memory dev without a tenant_feature_flags table), the
   * per-tenant gate is skipped and the global flag alone decides.
   */
  tenantFeatureFlags?: {
    isEnabledForTenantWithDefault(
      tenantId: string,
      flagKey: string,
      defaultEnabled: boolean,
    ): Promise<boolean>;
  };
  /**
   * WS3 — pre-connect health circuit for the realtime path. When present and
   * `isOpen()` returns true (the realtime transport has failed repeatedly),
   * the /voice branch returns Gather TwiML even if the flag + prereqs pass.
   * The mediastream adapter feeds this same instance via recordFailure/
   * recordSuccess. Unwired → treated as always-closed (no extra gating).
   */
  realtimeCircuit?: { isOpen(): boolean };
  /**
   * WS3 — realtime prerequisites probe. Returns false when the realtime path
   * can't physically work (STT/TTS not configured), so the /voice branch
   * degrades to Gather rather than emitting a Stream that hangs on connect.
   * Wired in app.ts from the SAME capability computation the /health canary
   * uses (deepgram + TTS configured). Unwired → treated as met (legacy
   * behavior: the global flag alone decides).
   */
  realtimePrerequisitesMet?: () => boolean;
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
    reason?: GateReason;
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
  /**
   * Voice-parity (Feature 7) — when a warm transfer to `tenant.transfer_number`
   * fails (no-answer/busy), the AI takes a callback message and creates a
   * `call_me_back` task here. When unwired, the route falls back to the legacy
   * rotation-cascade + voicemail behavior.
   */
  callMeBackRepo?: CallMeBackRepository;
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
        // Public Twilio callback — mounts its own urlencoded parser +
        // signature check (it sits before the shared middleware below).
        authTokenGetter: deps.authTokenGetter,
        ...(deps.publicBaseUrl ? { publicBaseUrl: deps.publicBaseUrl } : {}),
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

    // §10 voice gates — subscription, go-live, trial caps. Voicemail on block.
    if (deps.voiceGate) {
      try {
        const gate = await deps.voiceGate({ tenantId, callSid });
        if (!gate.allowed) {
          res.status(200).type('text/xml').send(voicemailTwimlForGateReason(gate.reason));
          return;
        }
      } catch (err) {
        logger.error('telephony/voice: voiceGate failed closed', {
          callSid,
          error: err instanceof Error ? err.message : String(err),
        });
        res.status(200).type('text/xml').send(voicemailTwimlForGateReason('not_live'));
        return;
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
      // WS3 — the realtime (media-streams) path is only chosen when the global
      // master switch is on AND the per-tenant flag, prerequisites, and health
      // circuit all pass. Any failure (including a flag-read throw) degrades to
      // the proven Gather path — never dead air, never a silent hangup.
      const useStream =
        !!deps.mediaStreamsEnabled &&
        (await shouldUseRealtimeStream({ tenantId, callSid, deps }));
      const twiml = useStream
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

    let tenantId: string | undefined;
    try {
      tenantId = await Promise.resolve(deps.resolveTenantId({
        to: body.To ?? '',
        from: body.From ?? '',
      }));
    } catch (err) {
      // Transient infra failure (e.g. DB outage during tenant lookup).
      // Respond 503 so Twilio retries the webhook rather than the caller
      // losing their turn. Mirrors the /voice route's transient handling.
      logger.error('telephony/gather: tenant lookup failed', {
        sessionId,
        callSid,
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(503).type('text/plain').send('Service temporarily unavailable');
      return;
    }
    if (!tenantId) {
      // Terminal miss. Return 200 + graceful hangup TwiML so the caller
      // hears an apology instead of dead air, and Twilio doesn't retry-storm
      // a 5xx. (Previously returned a raw 500.)
      logger.error('telephony/gather: no tenant resolved', { sessionId, callSid });
      res.status(200).type('text/xml').send(technicalDifficultiesTwiml());
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

    let tenantId: string | undefined;
    try {
      tenantId = await Promise.resolve(deps.resolveTenantId({
        to: body.To ?? '',
        from: body.From ?? '',
      }));
    } catch (err) {
      // Transient infra failure — 503 so Twilio retries rather than
      // dropping the dial leg. Mirrors /voice + /gather handling.
      logger.error('telephony/dial-result: tenant lookup failed', {
        sessionId,
        callSid,
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(503).type('text/plain').send('Service temporarily unavailable');
      return;
    }
    if (!tenantId) {
      // Terminal miss. 200 + graceful hangup TwiML instead of a raw 500
      // (which would make Twilio retry and leave the caller in dead air).
      logger.error('telephony/dial-result: no tenant resolved', { sessionId, callSid });
      res.status(200).type('text/xml').send(technicalDifficultiesTwiml());
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

    // Voice-parity (Feature 7) — single-line transfer model. When the tenant
    // configured a `transfer_number`, the transfer dialed that one line; a
    // no-answer/busy does NOT cascade a rotation. Instead the AI returns to the
    // caller, takes a callback message, and schedules a `call_me_back` task.
    let transferNumber: string | undefined;
    if (deps.settingsRepo) {
      try {
        const s = await deps.settingsRepo.findByTenant(tenantId);
        transferNumber = s?.transferNumber ?? undefined;
      } catch {
        // Best-effort — fall through to the legacy rotation path on lookup error.
      }
    }
    if (transferNumber) {
      const lang: Language = session.language === 'es' ? 'es' : 'en';
      const base = (deps.publicBaseUrl ?? '').replace(/\/+$/, '');
      const action = `${base}/api/telephony/callback-message?sid=${encodeURIComponent(sessionId)}`;
      logger.info('telephony/dial-result: transfer_number unreachable — taking callback message', {
        sessionId,
        previousStatus: dialStatus,
      });
      res
        .status(200)
        .type('text/xml')
        .send(buildCallbackGatherTwiml({ promptText: t('callback.prompt', lang), actionUrl: action, lang }));
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
          // Deliberately NOT forwarding businessPhoneFallbackResolver here: this
          // is the /dial-result CASCADE (the previous dial got no answer). The
          // business-line fallback is an INITIAL-attempt-only last resort —
          // re-applying it on every cascade re-invocation would redial the
          // shared line forever (the fallback never advances the rotation
          // cursor). Omitting it lets an exhausted/numberless rotation return
          // escalated:false here, so the cascade falls through to voicemail /
          // call_me_back (the pre-per-user-number termination behavior).
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

  /**
   * POST /api/telephony/callback-message
   *
   * Voice-parity (Feature 7). The caller leaves a callback message after a
   * failed warm transfer (see /dial-result transfer_number branch). We capture
   * `SpeechResult` as the callback message, create a `call_me_back` task, emit
   * a `call_me_back.scheduled` audit event, acknowledge the caller, and hang up.
   *
   * Query: ?sid=<sessionId>
   */
  router.post('/callback-message', async (req: Request, res: Response) => {
    const body = req.body as Record<string, string | undefined>;
    const sessionId = (req.query.sid as string | undefined) ?? '';
    if (!sessionId) {
      logger.warn('telephony/callback-message: missing sid');
      res.status(400).type('text/plain').send('Missing sid');
      return;
    }

    let tenantId: string | undefined;
    try {
      tenantId = await Promise.resolve(
        deps.resolveTenantId({ to: body.To ?? '', from: body.From ?? '' }),
      );
    } catch (err) {
      logger.error('telephony/callback-message: tenant lookup failed', {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(503).type('text/plain').send('Service temporarily unavailable');
      return;
    }
    // Validate the resolved tenant id is a well-formed UUID before any
    // tenant-scoped DB work (setTenantContext throws on a malformed id, and we
    // don't want to acquire a pool client for a junk request). 200 + graceful
    // hangup so Twilio doesn't 5xx-retry a permanently-bad request.
    if (!tenantId || !isValidTenantId(tenantId)) {
      logger.error('telephony/callback-message: no/invalid tenant resolved', { sessionId });
      res.status(200).type('text/xml').send(technicalDifficultiesTwiml());
      return;
    }

    const adapterDeps = deps.adapter.getDeps();
    const session = adapterDeps.store.get(sessionId);
    const lang: Language = session?.language === 'es' ? 'es' : 'en';
    // Empty string (not a synthetic 'unknown') when the carrier didn't send a
    // From — keeps the stored value honest; caller_phone is TEXT NOT NULL.
    const callerPhone = (body.From ?? '').trim();
    const message = (body.SpeechResult ?? '').trim();

    if (deps.callMeBackRepo) {
      let taskId: string;
      try {
        const task = await deps.callMeBackRepo.create({
          tenantId,
          sessionId,
          ...(session?.callSid ?? body.CallSid
            ? { callSid: session?.callSid ?? body.CallSid }
            : {}),
          callerPhone,
          ...(message ? { callbackMessage: message } : {}),
          reason: 'transfer_failed',
        });
        taskId = task.id;
      } catch (err) {
        // The callback is the whole point of this turn. If we can't persist it
        // (e.g. transient DB outage), DON'T finalize + tell the caller we'll
        // ring back — that would silently drop the request. Return 503 so
        // Twilio retries the webhook.
        logger.error('telephony/callback-message: failed to schedule call_me_back', {
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
        res.status(503).type('text/plain').send('Service temporarily unavailable');
        return;
      }
      // Audit is best-effort — never block the ack on it.
      if (deps.auditRepo) {
        try {
          await deps.auditRepo.create(
            createAuditEvent({
              tenantId,
              actorId: 'calling-agent',
              actorRole: 'system',
              eventType: 'call_me_back.scheduled',
              entityType: 'call_me_back_task',
              entityId: taskId,
              correlationId: sessionId,
              metadata: {
                callSid: session?.callSid ?? body.CallSid ?? null,
                hasMessage: message.length > 0,
                reason: 'transfer_failed',
              },
            }),
          );
        } catch (err) {
          logger.warn('telephony/callback-message: audit persist failed', {
            sessionId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      logger.info('telephony/callback-message: call_me_back task scheduled', {
        sessionId,
        taskId,
        hasMessage: message.length > 0,
      });
    } else {
      logger.warn('telephony/callback-message: callMeBackRepo not wired', { sessionId });
    }

    if (session) {
      session.ended = true;
      deps.adapter.finalizeTerminatedSession(session, [], 'callback_required');
    }

    const businessName = deps.businessName ?? 'our team';
    res
      .status(200)
      .type('text/xml')
      .send(
        `<?xml version="1.0" encoding="UTF-8"?><Response><Say>${xmlEscape(
          t('callback.ack', lang, { business: businessName }),
        )}</Say><Hangup/></Response>`,
      );
  });

  return router;
}

/**
 * Voice-parity (Feature 7) — TwiML that prompts the caller for a callback
 * message and gathers their speech to /callback-message. A trailing
 * `<Redirect>` re-POSTs to the same action on silence so a `call_me_back` task
 * is still scheduled (with an empty message) rather than dropping the caller.
 */
function buildCallbackGatherTwiml(opts: {
  promptText: string;
  actionUrl: string;
  lang: Language;
}): string {
  const locale = opts.lang === 'es' ? 'es-MX' : 'en-US';
  const action = xmlEscape(opts.actionUrl);
  const prompt = xmlEscape(opts.promptText);
  return (
    `<?xml version="1.0" encoding="UTF-8"?><Response>` +
    `<Gather input="speech" action="${action}" method="POST" speechTimeout="auto" language="${locale}">` +
    `<Say>${prompt}</Say>` +
    `</Gather>` +
    `<Redirect method="POST">${action}</Redirect>` +
    `</Response>`
  );
}

/**
 * WS3 — decide whether an inbound call should take the realtime
 * (media-streams) path. Called only when the global `mediaStreamsEnabled`
 * master switch is on. Returns true only when EVERY gate passes:
 *
 *   (a) realtime prerequisites present (STT + TTS configured), AND
 *   (b) the pre-connect health circuit is not open, AND
 *   (c) the per-tenant `voice_realtime` flag is enabled (default ON).
 *
 * Any gate failing — including a flag-read throw — returns false so the caller
 * falls back to Gather (the proven path). The cheap synchronous checks run
 * first so a fallback decision avoids the flag DB read entirely.
 */
async function shouldUseRealtimeStream(opts: {
  tenantId: string;
  callSid: string;
  deps: TelephonyRouterDeps;
}): Promise<boolean> {
  const { tenantId, callSid, deps } = opts;

  // (a) prerequisites — STT/TTS must be configured or the Stream would connect
  // to a socket that can't transcribe/speak. Unwired probe → treat as met.
  if (deps.realtimePrerequisitesMet && !deps.realtimePrerequisitesMet()) {
    logger.warn('telephony/voice: realtime prerequisites missing → Gather fallback', {
      callSid,
    });
    return false;
  }

  // (b) health circuit — recent realtime session failures pin new calls to Gather.
  if (deps.realtimeCircuit?.isOpen()) {
    logger.warn('telephony/voice: realtime circuit open → Gather fallback', { callSid });
    return false;
  }

  // (c) per-tenant flag (default ON). Fail toward Gather on a read error.
  if (deps.tenantFeatureFlags) {
    try {
      const enabled = await deps.tenantFeatureFlags.isEnabledForTenantWithDefault(
        tenantId,
        'voice_realtime',
        true,
      );
      if (!enabled) {
        logger.info('telephony/voice: voice_realtime tenant flag off → Gather fallback', {
          callSid,
        });
        return false;
      }
    } catch (err) {
      logger.warn('telephony/voice: voice_realtime flag read failed → Gather fallback', {
        callSid,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  return true;
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
 * Graceful "technical difficulties" TwiML used when a mid-call webhook
 * (/gather, /dial-result) can't resolve the tenant for a terminal reason.
 * Returned with HTTP 200 so the caller hears an apology + clean hangup
 * instead of dead air, and Twilio doesn't 5xx-retry-storm the webhook.
 * Matches the inline copy the /voice + /gather catch blocks already emit.
 */
function technicalDifficultiesTwiml(): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Response>` +
    `<Say voice="Polly.Joanna">We're experiencing technical difficulties. Please try again later.</Say>` +
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

/** Voicemail TwiML when inbound voice gates block AI routing. */
export function voicemailTwimlForGateReason(reason: GateReason | undefined): string {
  const say =
    reason === 'not_live'
      ? "This line isn't using our AI assistant yet. Please leave a message after the tone."
      : reason === 'no_billing'
        ? "We're finishing account setup. Please leave a message after the tone."
        : 'This number is being set up. Please leave a message after the tone.';
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="Polly.Joanna">${xmlEscape(say)}</Say><Record maxLength="120" playBeep="true"/><Hangup/></Response>`;
}

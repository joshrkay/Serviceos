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
import {
  requireTwilioSignature,
  sessionBelongsToAnotherTenant,
  actingTenantMismatchesCredential,
  getVerifiedTwilioTenantId,
  type TwilioAuthTokenGetter,
} from '../telephony/twilio-signature';
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
import {
  createVoicemailStatusRouter,
  type VoicemailStatusHandlerOptions,
  type VoicemailWebhookReceiptStore,
} from '../telephony/voicemail-status-route';
import type { VoicemailRedelivery } from '../telephony/voicemail-redelivery';
import type { SettingsRepository } from '../settings/settings';
import { resolveEscalationSettings } from '../settings/settings';
import type { LeadRepository } from '../leads/lead';
import type { GateReason } from '../voice/trial-limits';
import type { ForwardingCheckService } from '../onboarding/forwarding-check';
import { t, type Language } from '../ai/i18n/i18n';
import { discloseAiIdentity } from '../ai/skills/disclose-ai-identity';
import type { CallMeBackRepository } from '../voice/call-me-back/call-me-back';
import { createAuditEvent } from '../audit/audit';
import { isValidTenantId } from '../db/schema';
import { recordVoiceError } from '../analytics/posthog';
import { isCredentialFailure, type TtsHealthCheck, type TtsHealthState } from '../ai/tts/tts-health';
import {
  DEFAULT_REGISTRY_CONFIG,
  TWILIO_MEDIA_STREAMS_SURFACE,
  type ConnectionRegistry,
} from '../ws/connection-registry';

const logger = createLogger({
  service: 'routes.telephony',
  environment: process.env.NODE_ENV || 'development',
});

export interface TelephonyRouterDeps {
  adapter: TwilioGatherAdapter;
  /**
   * Resolves the credential an inbound webhook's signature is verified
   * against. #1072: it receives the DIALLED NUMBER as well as the AccountSid,
   * because the credential that may sign for a number is the one belonging to
   * the tenant that owns it — and it may answer `refuse`, which the middleware
   * turns into a 403 before any handler runs. Legacy single-account callers
   * may ignore the argument and return the master `TWILIO_AUTH_TOKEN`.
   */
  authTokenGetter: TwilioAuthTokenGetter;
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
   * #1061 — `/voice`, `/voice/gather-fallback`, `/gather`, `/dial-result`
   * and `/callback-message` all resolve through this repo. When omitted,
   * those handlers fall straight to the dev-only legacy/env seam (refused
   * in production/staging). Production wiring MUST provide it.
   */
  phoneNumberRepo?: PhoneNumberRepository;
  /**
   * Payload-alias phone-number → tenant callback. Consulted (a) by the
   * session-scoped handlers only as the dev-only fallback inside
   * `resolveInboundTenantId`, never in production/staging, and (b) by the
   * `/recording` + `/voicemail-status` no-session fallbacks. app.ts wires
   * `createDidTenantResolver`, which goes through the same repository.
   */
  resolveTenantId: (opts: { to: string; from: string }) => Promise<string | undefined> | string | undefined;
  /**
   * D-044 / #1766 — recognises the owner's call-forwarding check coming back
   * through their carrier. Consulted for every resolved inbound call BEFORE
   * the voice gate or any AI work; a recognised call is hung up on.
   */
  forwardingCheck?: Pick<ForwardingCheckService, 'recognizeInbound'>;
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
   * U9 (voicemail → action) — extra wiring for the voicemail-status
   * callback's transcription leg. The storage/Twilio-cred deps are shared
   * with `recording` above; this block carries only what is voicemail-
   * specific: the replay-receipt store (lead-leg idempotency) and the
   * app-layer hook that enqueues the transcription worker. Optional so
   * legacy tests/dev keep the historical notify-only behavior.
   */
  voicemail?: {
    webhookEventRepo?: VoicemailWebhookReceiptStore;
    options?: VoicemailStatusHandlerOptions;
    /** LCR-04 — redelivers voicemail callbacks taken during a database outage. */
    redelivery?: VoicemailRedelivery;
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
   * LCR-06 — the per-tenant connection registry the media-streams adapter
   * acquires its slot from (app.ts passes the SAME instance to both). A tenant
   * already at the cap gets Gather instead of a `<Stream>` whose socket the
   * adapter would refuse. Unwired → no cap gate (the adapter still enforces
   * the cap and degrades the overflow leg to Gather itself).
   */
  connectionRegistry?: Pick<ConnectionRegistry, 'count'>;
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
  voiceGate?: (input: {
    tenantId: string;
    callSid: string;
    from?: string | null;
    stirVerstat?: string | null;
  }) => Promise<{
    allowed: boolean;
    reason?: GateReason;
    /** Usage caps: ring this owner phone (null → voicemail). */
    forwardTo?: string | null;
  }>;
  /**
   * Optional health snapshot factory. When set, mounts a public
   * `GET /health` route that returns which voice capabilities are
   * wired (TTS, STT, recording, delivery, etc.). Surfaces booleans
   * only — no secret values — so it's safe to leave unauthenticated.
   * Useful for verifying a Railway deploy without grepping logs.
   */
  getHealth?: () => TelephonyHealthReport;
  /**
   * #1536 — cached liveness probe of the configured TTS provider. When
   * wired, `/health` folds its verdict into `capabilities.tts` (a key that
   * cannot synthesize reports false) and adds `ttsCheck`. When unwired the
   * report stays config-only.
   */
  ttsHealth?: TtsHealthCheck;
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
  /**
   * WS7 — session store consulted by `POST /voice/gather-fallback` to continue
   * the SAME session on Gather after a mid-call realtime degrade. Looked up by
   * CallSid. When unwired, the fallback route treats every CallSid as unknown
   * and starts a fresh inbound Gather session.
   */
  voiceSessionStore?: VoiceSessionStore;
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
  /** #1536 — the TTS provider probe verdict (present when `ttsHealth` is wired). */
  ttsCheck?: TtsHealthState;
  /**
   * #1536 — true when a capability is lost but calls are still served by a
   * fallback (a rejected TTS key → Gather). Independent of `ok`, which stays
   * the "can the line serve calls" verdict the deploy smoke asserts.
   */
  degraded?: boolean;
}

/**
 * #1536 — folds the TTS probe verdict into the config-only report. Only a
 * definite `failed` flips `tts` to false; `unknown` (probe still running)
 * and `config_only` leave the configuration answer standing.
 */
function withTtsCheck(report: TelephonyHealthReport, ttsCheck: TtsHealthState): TelephonyHealthReport {
  if (!report.capabilities.tts) return { ...report, ttsCheck };
  if (ttsCheck.status !== 'failed') return { ...report, ttsCheck };
  if (isCredentialFailure(ttsCheck)) {
    // /voice routes calls to Gather (Twilio <Say>) on a credential failure
    // (shouldUseRealtimeStream gate a2), so calls are still served: degraded,
    // not down. `ok` keeps every OTHER gate's answer (database, LLM, STT).
    return {
      ...report,
      degraded: true,
      capabilities: { ...report.capabilities, tts: false },
      ttsCheck,
      warnings: [
        ...report.warnings,
        `TTS key rejected (${ttsCheck.reason}) — calls fall back to Gather (Twilio <Say>)`,
      ],
    };
  }
  return {
    ...report,
    ok: report.capabilities.mediaStreams ? false : report.ok,
    capabilities: { ...report.capabilities, tts: false },
    ttsCheck,
    warnings: [
      ...report.warnings,
      `TTS provider rejected the probe (${ttsCheck.reason ?? 'unknown'}) — voice replies will fail`,
    ],
  };
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
    const ttsHealth = deps.ttsHealth;
    router.get('/health', async (_req: Request, res: Response) => {
      try {
        const report = getHealth();
        res.status(200).json(ttsHealth ? withTtsCheck(report, await ttsHealth.check()) : report);
      } catch (err) {
        logger.error('telephony/health: failed', {
          error: err instanceof Error ? err.message : String(err),
        });
        res.status(500).json({ ok: false, error: 'health_check_failed' });
      }
    });
  }

  /**
   * LCR-04 — POST /api/telephony/voice/fallback, every number's
   * `VoiceFallbackUrl`. Twilio fetches it when the primary /voice webhook (or
   * an action URL) fails: a 5xx, a timeout, a credential-lookup 500 during a
   * database brownout. It must therefore need NOTHING that can be down: no
   * database, no tenant lookup and no signature check (a subaccount tenant's
   * signing token lives in that same database). It is registered before every
   * signature middleware in this router for that reason.
   *
   * Unsigned is safe here: the response is fixed voicemail TwiML with no side
   * effect. The `<Record>` callback it names is /voicemail-status, which IS
   * signature-verified, and its tenant comes from the dialled number carried
   * on the callback URL — so the voicemail is attached once the database is
   * back, and a forged request can only ever be handed a recording prompt.
   */
  router.post(
    '/voice/fallback',
    express.urlencoded({ extended: false }),
    (req: Request, res: Response) => {
      const body = (req.body ?? {}) as Record<string, string | undefined>;
      logger.warn('telephony/voice-fallback: primary webhook failed — taking a voicemail', {
        callSid: body.CallSid,
      });
      res.status(200).type('text/xml').send(
        outageVoicemailTwiml(deps, { from: body.From ?? '', to: body.To ?? '', ...stirOf(body) }),
      );
    },
  );

  // Recording webhook (P8-014) gets its own sub-router so its sig
  // middleware operates on a body parsed independently of the
  // /voice + /gather body parser. Mount it BEFORE the parser/middleware
  // below so its router-scoped middleware fully owns the /recording path.
  if (deps.recording?.store) {
    router.use(
      createVoicemailStatusRouter(
        {
          store: deps.recording.store,
          pool: deps.pool,
          leadRepo: deps.leadRepo,
          auditRepo: deps.auditRepo,
          // Public Twilio callback — mounts its own urlencoded parser +
          // signature check (it sits before the shared middleware below).
          authTokenGetter: deps.authTokenGetter,
          ...(deps.publicBaseUrl ? { publicBaseUrl: deps.publicBaseUrl } : {}),
          // U9 — transcription leg reuses the recording sink's storage +
          // Twilio creds; the To-number fallback covers after-hours
          // voicemails, which have no in-process session by construction.
          resolveTenantIdFallback: deps.resolveTenantId,
          storage: deps.recording.storage,
          storageBucket: deps.recording.storageBucket,
          ...(deps.recording.twilioAccountSid
            ? { twilioAccountSid: deps.recording.twilioAccountSid }
            : {}),
          ...(deps.recording.twilioAuthToken
            ? { twilioAuthToken: deps.recording.twilioAuthToken }
            : {}),
          ...(deps.voicemail?.webhookEventRepo
            ? { webhookEventRepo: deps.voicemail.webhookEventRepo }
            : {}),
          ...(deps.voicemail?.redelivery ? { redelivery: deps.voicemail.redelivery } : {}),
        },
        deps.voicemail?.options ?? {},
      ),
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
      // LCR-04 — a live call's mid-call callbacks are verified against the
      // credential of the tenant its in-process session belongs to (cached
      // through a database brownout), not re-derived from the payload.
      trustedTenantId: (req) => {
        if (req.path !== '/gather' && req.path !== '/dial-result' && req.path !== '/callback-message') {
          return undefined;
        }
        const sid = typeof req.query.sid === 'string' ? req.query.sid : '';
        return sid ? sessionStoreFor(deps)?.get(sid)?.tenantId : undefined;
      },
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
        req,
      });
    } catch (err) {
      // Codex P1 (PR #384) — a transient infra failure (DB outage during the
      // phone-number lookup) must NOT 200-decline: that would falsely tell the
      // caller a real number is unassigned. LCR-04 — nor may it 5xx: Twilio
      // does not retry a 5xx voice webhook, it plays its generic error and
      // drops the call. Take a voicemail instead; it needs no database.
      logger.error('telephony/voice: tenant lookup failed — taking a voicemail', {
        callSid,
        error: err instanceof Error ? err.message : String(err),
      });
      res
        .status(200)
        .type('text/xml')
        .send(outageVoicemailTwiml(deps, { from, to, ...stirOf(body) }));
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

    // D-044 / #1766 — the owner's forwarding check coming back. Hang up: the
    // call must never reach the gate, a session or the AI. A lookup failure
    // is not a pass; the call carries on as an ordinary call.
    if (deps.forwardingCheck) {
      try {
        if (await deps.forwardingCheck.recognizeInbound({ tenantId, from, callSid })) {
          res.status(200).type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>');
          return;
        }
      } catch (err) {
        logger.warn('telephony/voice: forwarding check lookup failed — treating as a normal call', {
          callSid,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // §10 voice gates — subscription, go-live, usage caps. Voicemail on a
    // setup block; usage caps ring the owner first (forwardToOwnerTwiml).
    if (deps.voiceGate) {
      // Point at /recording, NOT /voicemail-status. Only /recording actually
      // persists: it downloads RecordingUrl, uploads to storage and inserts
      // the files + voice_recordings rows, which is what makes the audio
      // visible to the audit trail and reachable by deprovision's key harvest.
      // /voicemail-status only mints a lead — and it resolves the tenant from
      // store.findByCallSid, which finds nothing here because this gate
      // returns before any voice session is created, so it would log "missing
      // tenant" and drop the callback. /recording has a To/From tenant
      // fallback for exactly this no-session case.
      const gateBase = (deps.publicBaseUrl ?? '').replace(/\/+$/, '');
      const gateCallback = gateBase
        ? `${gateBase}/api/telephony/recording`
        : '/api/telephony/recording';
      try {
        const gate = await deps.voiceGate({ tenantId, callSid, from, stirVerstat: body.StirVerstat });
        if (!gate.allowed) {
          res
            .status(200)
            .type('text/xml')
            .send(
              gate.forwardTo
                ? forwardToOwnerTwiml(gate.forwardTo, gateCallback)
                : voicemailTwimlForGateReason(gate.reason, gateCallback),
            );
          return;
        }
      } catch (err) {
        logger.error('telephony/voice: voiceGate failed closed', {
          callSid,
          error: err instanceof Error ? err.message : String(err),
        });
        res
          .status(200)
          .type('text/xml')
          .send(voicemailTwimlForGateReason('not_live', gateCallback));
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
              // U9 — caller/dialed numbers ride the callback URL: the
              // recordingStatusCallback POST has no From/To of its own, and
              // this branch answers BEFORE any session exists, so they are
              // the handler's only route to caller identity + tenant.
              buildVoicemailTwiml({
                shopName,
                recordingStatusCallback: callback,
                callerPhone: from,
                dialedNumber: to,
                // #1223 — the STIR/SHAKEN verdict gates voicemail → action.
                ...(body.StirVerstat ? { stirVerstat: body.StirVerstat } : {}),
              }),
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
      // #1223 — Twilio's STIR/SHAKEN verdict gates owner-line authority.
      const stir = body.StirVerstat ? { stirVerstat: body.StirVerstat } : {};
      const twiml = useStream
        ? await deps.adapter.handleInboundForStream({ callSid, from, tenantId, accountSid: body.AccountSid, ...stir })
        : await deps.adapter.handleInbound({ callSid, from, to, tenantId, ...stir });
      res.status(200).type('text/xml').send(twiml);
    } catch (err) {
      logger.error('telephony/voice: handleInbound failed', {
        callSid,
        error: err instanceof Error ? err.message : String(err),
      });
      // Never a 5xx (Twilio would play its generic error and drop the call)
      // and, LCR-04, never "try again later" + hang-up either: the caller
      // leaves a voicemail, which reaches the tenant once the fault clears.
      res
        .status(200)
        .type('text/xml')
        .send(outageVoicemailTwiml(deps, { from, to, ...stirOf(body) }));
      // OBS — this handler never 5xxs by design (see comment above), so it's
      // otherwise invisible to recordApiError. Fired after the voicemail
      // TwiML is already queued; never alters the response.
      recordVoiceError({
        errorKind: 'inbound_handler_failed',
        channel: 'gather',
        callSid,
        tenantId,
      });
    }
  });

  /**
   * WS7 — POST /api/telephony/voice/gather-fallback
   *
   * Target of the mid-call REST redirect (`telephony/twilio-call-redirect.ts`).
   * Twilio re-requests TwiML here after the realtime transport degraded on a
   * live call. A KNOWN CallSid continues the SAME session on Gather (tenant +
   * FSM state preserved) via `action=/api/telephony/gather?sid=<sessionId>`; an
   * UNKNOWN CallSid starts a fresh inbound Gather session. This endpoint NEVER
   * emits `<Stream>` — it can't loop back into the realtime path by construction.
   * Signature verification is inherited from the router-level middleware above.
   */
  router.post('/voice/gather-fallback', async (req: Request, res: Response) => {
    const body = req.body as Record<string, string | undefined>;
    const callSid = body.CallSid ?? '';
    const session = callSid ? deps.voiceSessionStore?.findByCallSid(callSid) : undefined;

    // #1072 — this route hands back the session's own id in the <Gather>
    // action URL, so letting a foreign tenant reach it would give away the
    // `?sid=` the session-scoped routes are keyed on. No tenant is resolved on
    // this branch, so the verifying credential's tenant is the only authority
    // available; passing the session's own tenant as the fallback makes the
    // check a no-op under the deployment token, where no tenant is implied.
    if (sessionBelongsToAnotherTenant(req, session, session?.tenantId ?? '')) {
      logger.warn('telephony/gather-fallback: session belongs to another tenant — refusing', {
        callSid,
      });
      res.status(403).end();
      return;
    }

    if (session) {
      // Realtime hand-off — the stream leg degraded with a human hand-off
      // still undelivered (Twilio refused the inline-TwiML update, or the
      // stream failed while the hand-off line was playing). The session's FSM
      // is `escalating`, which ignores every further utterance, so continuing
      // on a bare Gather would strand the caller: bridge them instead, exactly
      // as the Gather transport's own next webhook response would have.
      const transferTwiml = deps.adapter.takePendingTransferTwiml(session.id);
      if (transferTwiml) {
        logger.info('telephony/gather-fallback: delivering undelivered realtime hand-off', {
          callSid,
          sessionId: session.id,
        });
        res.status(200).type('text/xml').send(transferTwiml);
        return;
      }
      const base = (deps.publicBaseUrl ?? '').replace(/\/+$/, '');
      const action = `${base}/api/telephony/gather?sid=${encodeURIComponent(session.id)}`;
      const lang: Language = session.language === 'es' ? 'es' : 'en';
      if (!session.recordingDisclosed) {
        logger.info('telephony/gather-fallback: disclosure spoken on undisclosed degrade', {
          callSid,
          sessionId: session.id,
        });
      }
      // PRIV-4 — a degrade before the caller heard the greeting (the STT
      // socket never opened, or the stream dropped mid-greeting) must still
      // tell them they are talking to a virtual assistant.
      const speaksNotice = !session.assistantNoticeHeard;
      const assistantNotice = discloseAiIdentity({
        tenantId: session.tenantId,
        businessName: deps.businessName ?? 'our team',
        language: lang,
        ...(deps.auditRepo ? { auditRepo: deps.auditRepo } : {}),
        voiceSessionId: session.id,
        actorId: 'system:inbound-call',
        channel: session.channel,
      });
      res
        .status(200)
        .type('text/xml')
        .send(buildDegradeFallbackTwiml(session, action, lang, assistantNotice.disclosureText));
      // Gather's point of evidence: the notice is a <Say> ahead of the
      // <Gather> in the document just sent (as handleInbound commits).
      if (speaksNotice) void assistantNotice.commitDisclosureLedger();
      return;
    }

    // Unknown CallSid — no live session to continue. Start a fresh inbound
    // Gather session (never Stream). Mirrors /voice's tenant resolution.
    // LCR-05 — this is where a realtime call lands when the process that held
    // it handed it off at shutdown (a deploy): the call starts over here.
    logger.warn('telephony/gather-fallback: unknown call — starting it over (deploy_induced_restart)', {
      event: 'deploy_induced_restart',
      callSid,
    });
    const from = body.From ?? '';
    const to = body.To ?? '';
    if (!from || !to) {
      logger.warn('telephony/gather-fallback: missing From/To for fresh session', { callSid });
      res.status(200).type('text/xml').send(technicalDifficultiesTwiml());
      return;
    }
    let tenantId: string | undefined;
    try {
      tenantId = await resolveInboundTenantId({ to, from, callSid, deps, req });
    } catch (err) {
      // LCR-04 — a 5xx here drops the call; take a voicemail instead.
      logger.error('telephony/gather-fallback: tenant lookup failed — taking a voicemail', {
        callSid,
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(200).type('text/xml').send(outageVoicemailTwiml(deps, { from, to, ...stirOf(body) }));
      return;
    }
    if (!tenantId) {
      res.status(200).type('text/xml').send(numberNotInServiceTwiml());
      return;
    }
    try {
      const twiml = await deps.adapter.handleInbound({
        callSid,
        from,
        to,
        tenantId,
        ...(body.StirVerstat ? { stirVerstat: body.StirVerstat } : {}),
      });
      res.status(200).type('text/xml').send(twiml);
    } catch (err) {
      logger.error('telephony/gather-fallback: handleInbound failed — taking a voicemail', {
        callSid,
        error: err instanceof Error ? err.message : String(err),
      });
      // LCR-04 — a voicemail, not "try again later" + hang-up.
      res.status(200).type('text/xml').send(outageVoicemailTwiml(deps, { from, to, ...stirOf(body) }));
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
    // A3 — Twilio omits `Confidence` when it has no opinion (e.g. very
    // short/silent utterances); that must read as "no signal", NOT as a
    // confidently-zero score — a `0` here fed into the low-confidence gate
    // would reprompt every such turn. `undefined` flows through as HIGH
    // confidence (never blocks a turn on absent data) per handleGather's
    // acoustic-confidence gate.
    const confidence = body.Confidence ? Number(body.Confidence) : undefined;

    const sessionId = (req.query.sid as string | undefined) ?? '';
    if (!sessionId) {
      logger.warn('telephony/gather: missing sid', { callSid });
      res.status(400).type('text/plain').send('Missing sid');
      return;
    }

    // LCR-04 — a live session whose tenant the signature already proved
    // needs no lookup. Otherwise #1061 — same DID → tenant path as /voice
    // (phoneNumberRepo, dev-only env fallback), never the legacy callback
    // directly: that callback answered TWILIO_DEFAULT_TENANT_ID on a miss in
    // every environment.
    let tenantId: string | undefined = verifiedLiveSessionTenant(deps, req, sessionId);
    if (!tenantId) {
      try {
        tenantId = await resolveInboundTenantId({
          to: body.To ?? '',
          from: body.From ?? '',
          callSid,
          deps,
          req,
        });
      } catch (err) {
        // LCR-04 — transient infra failure (e.g. DB outage during the tenant
        // lookup). Twilio does not retry a 5xx action URL, so a 503 here dropped
        // the call mid-conversation. The live session already knows its tenant:
        // carry the turn on it (the cross-tenant guard below still runs against
        // the verifying credential). With no live session, take a voicemail.
        tenantId = sessionStoreFor(deps)?.get(sessionId)?.tenantId;
        logger.error('telephony/gather: tenant lookup failed', {
          sessionId,
          callSid,
          continuingOnSession: Boolean(tenantId),
          error: err instanceof Error ? err.message : String(err),
        });
        if (!tenantId) {
          res
            .status(200)
            .type('text/xml')
            .send(outageVoicemailTwiml(deps, { from: body.From ?? '', to: body.To ?? '' }));
          return;
        }
      }
    }
    if (!tenantId) {
      // Terminal miss. Return 200 + graceful hangup TwiML so the caller
      // hears an apology instead of dead air, and Twilio doesn't retry-storm
      // a 5xx. (Previously returned a raw 500.)
      logger.error('telephony/gather: no tenant resolved', { sessionId, callSid });
      res.status(200).type('text/xml').send(technicalDifficultiesTwiml());
      return;
    }

    // #1072 — the signature proves the caller owns a number, not this call.
    if (sessionBelongsToAnotherTenant(req, sessionStoreFor(deps)?.get(sessionId), tenantId)) {
      logger.warn('telephony/gather: session belongs to another tenant — refusing', {
        sessionId,
        callSid,
      });
      res.status(403).end();
      return;
    }

    try {
      const twiml = await deps.adapter.handleGather({
        sessionId,
        callSid,
        speechResult,
        confidence: confidence !== undefined && Number.isFinite(confidence) ? confidence : undefined,
        tenantId,
        // LCR-05 — what a session this process never held (a deploy cut-over)
        // is started over from, instead of hanging up.
        ...(body.From ? { from: body.From } : {}),
        ...(body.To ? { to: body.To } : {}),
        ...(body.StirVerstat ? { stirVerstat: body.StirVerstat } : {}),
      });
      res.status(200).type('text/xml').send(twiml);
    } catch (err) {
      logger.error('telephony/gather: handleGather failed — taking a voicemail', {
        sessionId,
        callSid,
        error: err instanceof Error ? err.message : String(err),
      });
      // LCR-04 — a voicemail, not "try again later" + hang-up.
      res
        .status(200)
        .type('text/xml')
        .send(outageVoicemailTwiml(deps, { from: body.From ?? '', to: body.To ?? '' }));
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

    // LCR-04 — a live session whose tenant the signature already proved needs
    // no lookup; otherwise #1061 — same DID → tenant path as /voice; see /gather.
    let tenantId: string | undefined = verifiedLiveSessionTenant(deps, req, sessionId);
    if (!tenantId) {
      try {
        tenantId = await resolveInboundTenantId({
          to: body.To ?? '',
          from: body.From ?? '',
          callSid,
          deps,
          req,
        });
      } catch (err) {
        // LCR-04 — transient infra failure. Twilio does not retry a 5xx action
        // URL, so a 503 dropped the dial leg. Carry on with the live session's
        // tenant (the cross-tenant guard below still runs); with none, take a
        // voicemail. Mirrors /gather.
        tenantId = sessionStoreFor(deps)?.get(sessionId)?.tenantId;
        logger.error('telephony/dial-result: tenant lookup failed', {
          sessionId,
          callSid,
          continuingOnSession: Boolean(tenantId),
          error: err instanceof Error ? err.message : String(err),
        });
        if (!tenantId) {
          res
            .status(200)
            .type('text/xml')
            .send(outageVoicemailTwiml(deps, { from: body.From ?? '', to: body.To ?? '' }));
          return;
        }
      }
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

    // #1072 — the signature proves the caller owns a number, not this call.
    if (sessionBelongsToAnotherTenant(req, session, tenantId)) {
      logger.warn('telephony/dial-result: session belongs to another tenant — refusing', {
        sessionId,
        callSid,
      });
      res.status(403).end();
      return;
    }

    if (!session) {
      // LCR-05 — the transfer was ringing on a process that has since gone
      // (a deploy cut over mid-<Dial>), so this one never held the session.
      // An unanswered transfer leaves the caller on the line: take a callback
      // message (/callback-message tolerates an unknown session), exactly as a
      // known single-line transfer does, instead of hanging up on them.
      if (dialStatus !== 'completed' && dialStatus !== 'answered') {
        logger.warn('telephony/dial-result: unknown session — taking a callback message (deploy_induced_restart)', {
          event: 'deploy_induced_restart',
          sessionId,
          callSid,
          dialStatus,
        });
        const base = (deps.publicBaseUrl ?? '').replace(/\/+$/, '');
        res
          .status(200)
          .type('text/xml')
          .send(
            buildCallbackGatherTwiml({
              promptText: t('callback.prompt', 'en'),
              actionUrl: `${base}/api/telephony/callback-message?sid=${encodeURIComponent(sessionId)}`,
              lang: 'en',
            }),
          );
        return;
      }
      logger.warn('telephony/dial-result: unknown session', { sessionId, callSid });
      // The transfer was answered: the call is over on this leg.
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
    // H1 / H1-R, scoped (round-3 review of #1676) — an EMERGENCY-CLASS leg is
    // press-1 screened and its action carries `screen=1` (set by the producer,
    // see DialDispatcherOptions.screen). For such a leg only a person's
    // keypress proves the hand-off was answered: a carrier voicemail picking
    // up is `completed` too, as is a leg whose screen fetch failed — stamping
    // either `transferred` would silence the emergency page ladder for a real
    // unanswered emergency. Every other leg keeps the long-standing rule:
    // `completed`/`answered` IS the transfer.
    const screenedLeg = req.query.screen === '1';
    const accepted = !screenedLeg || session.transferAnsweredAt !== undefined;
    if (!accepted && successStatuses.has(dialStatus)) {
      logger.info('telephony/dial-result: screened leg never accepted by a person — not a transfer', {
        sessionId,
        dialStatus,
      });
    }
    if (successStatuses.has(dialStatus) && accepted) {
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
    // A screened cascade's next leg must earn its own acceptance.
    if (screenedLeg) session.transferAnsweredAt = undefined;

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
          // The cascade of an emergency-class (screened) leg stays screened.
          ...(screenedLeg ? { screenHandoff: true } : {}),
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
      // U9 — same caller/dialed threading as the after-hours branch; the
      // dial-result webhook carries the call's From/To as standard params.
      .send(
        buildVoicemailTwiml({
          shopName: businessName,
          recordingStatusCallback: callback,
          ...(body.From ? { callerPhone: body.From } : {}),
          ...(body.To ? { dialedNumber: body.To } : {}),
          // #1223 — the verdict captured at /voice for this call.
          ...(session.stirVerstat ? { stirVerstat: session.stirVerstat } : {}),
        }),
      );
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
      // #1061 — same DID → tenant path as /voice; see /gather.
      tenantId = await resolveInboundTenantId({
        to: body.To ?? '',
        from: body.From ?? '',
        callSid: body.CallSid ?? '',
        deps,
        req,
      });
    } catch (err) {
      // LCR-04 — Twilio does not retry a 5xx action URL; a 503 here hung up
      // on a caller mid-message. Take the message as a voicemail instead.
      logger.error('telephony/callback-message: tenant lookup failed — taking a voicemail', {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
      res
        .status(200)
        .type('text/xml')
        .send(outageVoicemailTwiml(deps, { from: body.From ?? '', to: body.To ?? '' }));
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

    // #1072 — the signature proves the caller owns a number, not this call.
    if (sessionBelongsToAnotherTenant(req, sessionStoreFor(deps)?.get(sessionId), tenantId)) {
      logger.warn('telephony/callback-message: session belongs to another tenant — refusing', {
        sessionId,
      });
      res.status(403).end();
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
        // ring back — that would silently drop the request. LCR-04 — and not
        // a 503 either (Twilio does not retry it; the call just drops): the
        // caller records the message as a voicemail, which reaches the tenant
        // once the database is back.
        logger.error('telephony/callback-message: failed to schedule call_me_back — taking a voicemail', {
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
        res
          .status(200)
          .type('text/xml')
          .send(outageVoicemailTwiml(deps, { from: body.From ?? '', to: body.To ?? '' }));
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
/**
 * TwiML that resumes a degraded realtime call on the Gather transport.
 *
 * The realtime transport can degrade BEFORE call establishment ever ran — the
 * STT socket failing to open is exactly that case, and `<Connect><Stream>`
 * speaks nothing, so the caller has heard silence up to this point. This
 * document arms speech recognition, which makes it an audio-capture entry
 * point in its own right: it must carry the recording disclosure itself
 * whenever the session has never been disclosed, rather than assume an
 * earlier turn covered it.
 *
 * Uses the two-party copy, matching the unknown-caller-state default in
 * disclose-recording.ts (no caller state is available here). Latches
 * `recordingDisclosed` so a caller who degrades more than once is not
 * re-read the notice every turn.
 *
 * PRIV-4 — the same holds for the virtual-assistant notice: when the caller
 * never heard the greeting that carries it (`assistantNoticeHeard` unset),
 * `assistantNotice` is spoken first, then latched.
 */
export function buildDegradeFallbackTwiml(
  session: { recordingDisclosed?: boolean; assistantNoticeHeard?: boolean },
  actionUrl: string,
  lang: Language,
  assistantNotice: string,
): string {
  // The disclosure must be a standalone <Say> BEFORE the <Gather>, not the
  // Gather's nested prompt: `<Gather input="speech">` starts recognizing at
  // the first millisecond, so a notice nested inside it plays while capture
  // is already armed — the exact ordering this gate exists to prevent.
  const preambleParts = [
    ...(session.assistantNoticeHeard ? [] : [assistantNotice]),
    ...(session.recordingDisclosed ? [] : [t('disclose.two_party', lang)]),
  ];
  const preambleText = preambleParts.length > 0 ? preambleParts.join(' ') : undefined;
  session.recordingDisclosed = true;
  session.assistantNoticeHeard = true;
  return buildCallbackGatherTwiml({
    promptText: t('realtime.degraded_repair', lang),
    actionUrl,
    lang,
    ...(preambleText ? { preambleText } : {}),
  });
}

function buildCallbackGatherTwiml(opts: {
  promptText: string;
  actionUrl: string;
  lang: Language;
  /**
   * Spoken BEFORE the `<Gather>` opens, for copy that must finish playing
   * while nothing is listening (the recording disclosure). Copy nested in the
   * Gather's own `<Say>` plays with speech recognition already armed.
   */
  preambleText?: string;
}): string {
  const locale = opts.lang === 'es' ? 'es-MX' : 'en-US';
  const action = xmlEscape(opts.actionUrl);
  const prompt = xmlEscape(opts.promptText);
  const preamble = opts.preambleText ? `<Say>${xmlEscape(opts.preambleText)}</Say>` : '';
  return (
    `<?xml version="1.0" encoding="UTF-8"?><Response>` +
    preamble +
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
 *   (b2) the tenant is below its realtime connection cap (LCR-06), AND
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

  // (a2) #1536 — the cached TTS probe verdict. Only a CREDENTIAL failure
  // (missing_permissions / unauthorized) diverts: it is deterministic until
  // the key is fixed, and a Stream would connect but speak no reply, while
  // Gather's <Say> is voiced by Twilio and works. unknown / probe_pending /
  // unreachable keep the Stream (no flapping on a transient vendor blip; live
  // session failures already trip the realtime circuit below). Read without
  // waiting — a live call never blocks on the provider.
  const ttsVerdict = deps.ttsHealth?.latest() ?? null;
  if (isCredentialFailure(ttsVerdict)) {
    logger.warn('telephony/voice: TTS key rejected by provider → Gather fallback', {
      callSid,
      reason: ttsVerdict?.reason,
    });
    return false;
  }

  // (b) health circuit — recent realtime session failures pin new calls to Gather.
  if (deps.realtimeCircuit?.isOpen()) {
    logger.warn('telephony/voice: realtime circuit open → Gather fallback', { callSid });
    // OBS — fired after the Gather-fallback decision is already made; never
    // alters it.
    recordVoiceError({
      errorKind: 'realtime_circuit_open',
      channel: 'gather',
      callSid,
      tenantId,
    });
    return false;
  }

  // (b2) LCR-06 — per-tenant realtime connection cap. The adapter refuses a
  // socket over the cap, so a tenant already at it gets Gather here. This is
  // a pre-check (count-then-acquire races between concurrent /voice requests
  // are caught by the adapter, which degrades that leg to Gather). Runs before
  // the flag read; a count error fails toward Gather like every other gate.
  if (deps.connectionRegistry) {
    let open: number;
    try {
      open = await deps.connectionRegistry.count(TWILIO_MEDIA_STREAMS_SURFACE, tenantId);
    } catch (err) {
      logger.warn('telephony/voice: connection count failed → Gather fallback', {
        callSid,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
    if (open >= DEFAULT_REGISTRY_CONFIG.perTenantMax) {
      logger.warn('telephony/voice: tenant at realtime connection cap → Gather fallback', {
        callSid,
        open,
      });
      recordVoiceError({
        errorKind: 'tenant_connection_cap',
        channel: 'gather',
        callSid,
        tenantId,
      });
      return false;
    }
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

/** The STIR/SHAKEN verdict of a call webhook, when Twilio sent one (#1223). */
function stirOf(body: Record<string, string | undefined>): { stirVerstat?: string } {
  return body.StirVerstat ? { stirVerstat: body.StirVerstat } : {};
}

/**
 * LCR-04 — the voicemail every webhook falls back to when the database (or
 * anything else the turn needs) is down. Built from the request alone: the
 * caller and the dialled number ride the recording callback URL (Twilio signs
 * it), which is how /voicemail-status finds the tenant when no session exists.
 * Same shape as the after-hours branch on /voice.
 */
function outageVoicemailTwiml(
  deps: Pick<TelephonyRouterDeps, 'publicBaseUrl' | 'businessName'>,
  call: { from: string; to: string; stirVerstat?: string },
): string {
  const base = (deps.publicBaseUrl ?? '').replace(/\/+$/, '');
  return buildVoicemailTwiml({
    shopName: deps.businessName ?? 'our team',
    recordingStatusCallback: base
      ? `${base}/api/telephony/voicemail-status`
      : '/api/telephony/voicemail-status',
    ...(call.from ? { callerPhone: call.from } : {}),
    ...(call.to ? { dialedNumber: call.to } : {}),
    ...(call.stirVerstat ? { stirVerstat: call.stirVerstat } : {}),
  });
}

/**
 * Graceful "technical difficulties" TwiML used when a mid-call webhook
 * (/gather, /dial-result) can't resolve the tenant for a TERMINAL reason (no
 * tenant owns the number). Returned with HTTP 200 so the caller hears an
 * apology + clean hangup instead of dead air. A transient failure never
 * comes here: LCR-04 — it takes a voicemail (`outageVoicemailTwiml`).
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
 * The session store to check a `?sid=` against. `voiceSessionStore` is the
 * router's own declared dep and is what app.ts wires (the SAME instance the
 * adapter holds — there is one shared store per process); the adapter's own
 * store is the fallback for callers that pre-date that dep. `getDeps` is
 * accessed defensively because tests mount hand-rolled adapter fakes that do
 * not implement it, and a guard must never be the thing that throws inside a
 * webhook handler.
 */
function sessionStoreFor(
  deps: TelephonyRouterDeps,
): { get(id: string): { tenantId: string } | undefined } | undefined {
  if (deps.voiceSessionStore) return deps.voiceSessionStore;
  const getDeps = (deps.adapter as Partial<TwilioGatherAdapter>).getDeps;
  return typeof getDeps === 'function' ? deps.adapter.getDeps().store : undefined;
}

/**
 * LCR-04 — the tenant of a mid-call callback's live session, when the request
 * was verified with that tenant's own credential (the shared middleware binds
 * these callbacks to the session's tenant). The signature then already proves
 * the tenant, so the route needs no DID lookup: under pool exhaustion that
 * lookup waited out a database checkout before its outage path could answer,
 * pushing a live turn past Twilio's ~15 s action timeout. Undefined (no
 * session, or a credential that names no tenant or another one) keeps the
 * DID lookup and the cross-tenant guard after it.
 */
function verifiedLiveSessionTenant(deps: TelephonyRouterDeps, req: Request, sessionId: string): string | undefined {
  const session = sessionStoreFor(deps)?.get(sessionId);
  if (!session) return undefined;
  return getVerifiedTwilioTenantId(req) === session.tenantId ? session.tenantId : undefined;
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
  req: Request;
}): Promise<string | undefined> {
  const { to, from, callSid, deps } = opts;
  const normalizedTo = normalizeE164(to);

  // 1) Primary path — phone-numbers repo lookup. A payload with no `To` has
  // no DID to look up: it is a miss, never a query for the empty string.
  if (deps.phoneNumberRepo && normalizedTo) {
    try {
      const lookup = await deps.phoneNumberRepo.findByNumber(normalizedTo);
      if (lookup) {
        return lookup.tenantId;
      }
    } catch (err) {
      // Codex P1 (PR #384) — distinguish "tenant not found" (terminal,
      // 200 decline) from "DB outage" (transient — the caller must not be
      // told the number is out of service). Previously the catch silently fell through to the
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

      // In prod / staging, re-throw so the route takes its outage path
      // (LCR-04: a voicemail, or the live session's tenant). In dev,
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

  // #1084 — the dev seam must not accept a call whose verifying credential
  // belongs to a specific, DIFFERENT tenant. After #1082 an unowned (or
  // absent) dialled number verifies on the AccountSid path, so without this
  // tenant A's own credential could run a call as the env default tenant. The
  // deployment-wide token implies no tenant and still reaches the seam.
  const refuseForeignCredential = (candidate: string, source: string): boolean => {
    if (!actingTenantMismatchesCredential(opts.req, candidate)) return false;
    logger.warn('telephony.tenant_lookup_dev_fallback_refused', {
      to: normalizedTo,
      callSid,
      source,
      reason: 'verifying_credential_belongs_to_another_tenant',
      env: nodeEnv,
    });
    return true;
  };

  // Dev path — try the legacy resolver, then the env var.
  try {
    const legacy = await Promise.resolve(deps.resolveTenantId({ to: normalizedTo, from }));
    if (legacy && refuseForeignCredential(legacy, 'resolveTenantId')) return undefined;
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
  if (envFallback && refuseForeignCredential(envFallback, 'TWILIO_DEFAULT_TENANT_ID')) {
    return undefined;
  }
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

function isProdLikeEnv(nodeEnv: string): boolean {
  return nodeEnv === 'production' || nodeEnv === 'prod' || nodeEnv === 'staging';
}

/**
 * #1061 — the payload-alias `{to, from} → tenant` callback app.ts wires as
 * `resolveTenantId` (and, through it, the `/recording` + `/voicemail-status`
 * no-session fallbacks). It resolves through the SAME `PhoneNumberRepository`
 * `/voice` uses — there is no second copy of the DID SQL — and applies the
 * same env rule as `resolveInboundTenantId`: `TWILIO_DEFAULT_TENANT_ID` is a
 * dev-only seam, answered with a loud WARN, and never outside dev.
 *
 * LCR-04 — in production a lookup error THROWS rather than answering
 * `undefined`: the status-callback fallbacks would otherwise treat a database
 * outage as "no tenant", log a skip and 200 the callback, losing the
 * recording. Thrown, they answer 500 and the callback is delivered again. In
 * dev a lookup error stays failure-soft (the env seam below). The
 * session-scoped handlers do not call this (they use `resolveInboundTenantId`).
 */
export function createDidTenantResolver(opts: {
  phoneNumberRepo?: PhoneNumberRepository;
  /** `process.env.NODE_ENV` override — test seam. */
  nodeEnv?: string;
}): (args: { to: string; from: string }) => Promise<string | undefined> {
  return async ({ to }) => {
    const normalizedTo = normalizeE164(to ?? '');
    if (opts.phoneNumberRepo && normalizedTo) {
      try {
        const lookup = await opts.phoneNumberRepo.findByNumber(normalizedTo);
        if (lookup) return lookup.tenantId;
      } catch (err) {
        logger.warn('telephony.tenant_lookup_error', {
          to: normalizedTo,
          error: err instanceof Error ? err.message : String(err),
        });
        // LCR-04 — in production an outage is NOT a "no tenant" miss: the
        // status-callback handlers would log a skip and 200 the callback,
        // dropping the voicemail a caller left during the brownout. Rethrow
        // so they answer 500 and the callback is delivered again. Dev keeps
        // the failure-soft seam below.
        if (isProdLikeEnv(opts.nodeEnv ?? process.env.NODE_ENV ?? 'development')) throw err;
      }
    }
    const nodeEnv = opts.nodeEnv ?? process.env.NODE_ENV ?? 'development';
    if (isProdLikeEnv(nodeEnv)) return undefined;
    const envFallback = process.env.TWILIO_DEFAULT_TENANT_ID;
    if (envFallback) {
      logger.warn('telephony.tenant_lookup_dev_fallback', {
        to: normalizedTo,
        source: 'TWILIO_DEFAULT_TENANT_ID',
        env: nodeEnv,
      });
    }
    return envFallback || undefined;
  };
}

/** Voicemail TwiML when inbound voice gates block AI routing. */
/**
 * A usage cap (trial minutes, trial concurrency, paid overage cap) rings the
 * owner instead of the AI answering. If the Dial ends unanswered Twilio runs
 * the next verbs, so the caller still reaches voicemail — never a dead line.
 */
export function forwardToOwnerTwiml(ownerPhone: string, recordingStatusCallback?: string): string {
  const callbackAttr = recordingStatusCallback
    ? ` recordingStatusCallback="${xmlEscape(recordingStatusCallback)}" recordingStatusCallbackMethod="POST"`
    : '';
  return (
    `<?xml version="1.0" encoding="UTF-8"?><Response>` +
    `<Dial timeout="20">${xmlEscape(ownerPhone)}</Dial>` +
    `<Say voice="Polly.Joanna">${xmlEscape("Sorry we couldn't take your call. Please leave a message after the tone.")}</Say>` +
    `<Record maxLength="120" playBeep="true"${callbackAttr}/><Hangup/></Response>`
  );
}

export function voicemailTwimlForGateReason(
  reason: GateReason | undefined,
  recordingStatusCallback?: string,
): string {
  const say =
    reason === 'not_live'
      ? "This line isn't using our AI assistant yet. Please leave a message after the tone."
      : reason === 'no_billing'
        ? "We're finishing account setup. Please leave a message after the tone."
        : 'This number is being set up. Please leave a message after the tone.';
  // The callback is what makes the recording EXIST for us: without it nothing
  // reaches recording-webhook, so no files/voice_recordings row is created —
  // and an object with no row is invisible to the audit trail and survives
  // tenant deprovisioning, which harvests keys from `files`. Every sibling
  // voicemail path passes one; this branch used to be the exception.
  const callbackAttr = recordingStatusCallback
    ? ` recordingStatusCallback="${xmlEscape(recordingStatusCallback)}" recordingStatusCallbackMethod="POST"`
    : '';
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="Polly.Joanna">${xmlEscape(say)}</Say><Record maxLength="120" playBeep="true"${callbackAttr}/><Hangup/></Response>`;
}

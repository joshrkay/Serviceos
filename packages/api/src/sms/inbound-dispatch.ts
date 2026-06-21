/**
 * P2-034 — Inbound SMS keyword dispatcher.
 *
 * The Twilio inbound-SMS webhook verifies the signature and dedups the
 * receipt; this module owns what happens AFTER that. Downstream features
 * (P6-028 tech-status keywords first, future stories second) register a
 * `KeywordHandler` and the webhook route delegates routing to
 * `dispatchInboundSms`.
 *
 * Design notes:
 *
 *   • The registry is a module-level Map mutated only at module-init time
 *     (when each feature's bootstrap calls `registerKeywordHandler`). After
 *     init the map is read-only in practice — there are no runtime writes
 *     — so a plain Map is concurrency-safe for the webhook fan-out. The
 *     `__resetKeywordRegistryForTests` helper is the one exception and
 *     exists solely so vitest specs can isolate registrations.
 *
 *   • The dispatcher MUST NOT throw. The Twilio webhook handler returns
 *     200 on every non-signature failure path; a 5xx here would tell
 *     Twilio to retry an already-acknowledged delivery, which would
 *     re-fire any side-effects a handler did manage to complete.
 *
 *   • Audit + handler-level logging is the caller's responsibility — the
 *     dispatcher returns a structured `HandlerResult` so the webhook
 *     route (which already wires the AuditRepository) can write the
 *     `sms.inbound.dispatched` / `sms.inbound.unhandled` events.
 */
import { createLogger } from '../logging/logger';

const logger = createLogger({
  service: 'sms-inbound-dispatch',
  environment: process.env.NODE_ENV || 'dev',
});

/** RV-050 — one inbound MMS media item (Twilio MediaUrlN / MediaContentTypeN). */
export interface InboundSmsMedia {
  url: string;
  contentType?: string;
}

export interface InboundSmsContext {
  tenantId: string;
  fromE164: string;
  body: string;
  messageSid: string;
  /** RV-050 — MMS media attached to the inbound message, when any. */
  media?: InboundSmsMedia[];
}

export interface HandlerResult {
  handled: boolean;
  handler?: string;
  reason?: string;
}

export interface KeywordHandler {
  readonly keywords: readonly string[];
  handle(ctx: InboundSmsContext): Promise<HandlerResult>;
}

/**
 * P2-034 — fallback for messages no keyword claims. The proposal-reply
 * feature needs to see free-text from the owner ("make it $200 instead")
 * during an edit session, and to send the one-time "Reply Y/N/EDIT"
 * clarification — neither starts with a registered keyword. Exactly one
 * fallback may be registered; it runs only after keyword routing declines
 * (no match, or the matched handler returned `handled: false`).
 */
export interface FallbackHandler {
  readonly name: string;
  handle(ctx: InboundSmsContext): Promise<HandlerResult>;
}

/**
 * RV-116 — dropped-call recovery resume. A reply on a recovery thread is
 * free text from a CUSTOMER phone (not the owner), so neither keyword
 * routing nor the owner-edit fallback claims it. Exactly one resume handler
 * may be registered; it runs LAST — only after keyword routing and the
 * fallback have both declined — so every existing dispatch path is
 * untouched. Same `FallbackHandler` shape (name + handle).
 */
export type RecoveryResumeHandler = FallbackHandler;

/**
 * RV-050 — media side-channel. Exactly one media handler may register; it
 * runs for every inbound message that carries media, INDEPENDENTLY of
 * keyword/fallback routing (a photo with no body still ingests; a photo
 * accompanying "OUT" ingests AND the keyword still routes). Its failures
 * are swallowed and logged — media ingestion must never break normal SMS
 * handling or turn an acknowledged Twilio delivery into a retry.
 */
export interface MediaHandler {
  readonly name: string;
  handle(ctx: InboundSmsContext): Promise<unknown>;
}

interface RegistryEntry {
  keyword: string;
  handler: KeywordHandler;
}

const registry = new Map<string, RegistryEntry>();
let fallback: FallbackHandler | undefined;
let recoveryResume: RecoveryResumeHandler | undefined;
let mediaHandler: MediaHandler | undefined;
/**
 * N-003 (P2-036) — content-based negotiation guardrail. Runs LAST (after
 * keyword routing, the owner-edit fallback, and dropped-call recovery all
 * decline), so it only ever inspects genuinely unclaimed customer free-text.
 * Same single-slot `FallbackHandler` shape (name + handle).
 */
let negotiationHandler: FallbackHandler | undefined;
/**
 * U4 (CRM Jobber parity, Phase 2) — capture-all. The absolute last resort:
 * an inbound customer text that NO keyword, no owner-edit fallback, no
 * dropped-call recovery, and no negotiation guardrail claimed. Instead of
 * dropping it on the floor, this handler threads it onto the sender's
 * conversation so the owner sees it in the unified inbox. It runs AFTER
 * `negotiationHandler` so it never pre-empts a real feature, and STOP/START
 * (keyword handlers) short-circuit far upstream, so opt-outs never reach it.
 * Same single-slot `FallbackHandler` shape (name + handle).
 */
let captureHandler: FallbackHandler | undefined;

function normalize(keyword: string): string {
  return keyword.trim().toLowerCase();
}

export interface RegisterKeywordHandlerOptions {
  /**
   * When true, replaces any existing registration for the same keyword
   * instead of throwing. Use when bootstrapping handlers from a function
   * (like createApp) that may legitimately run multiple times in the same
   * process — e.g. across test files. Defaults to false to preserve the
   * "feature bootstraps register exactly once at init" production guarantee.
   */
  overwrite?: boolean;
}

export function registerKeywordHandler(
  handler: KeywordHandler,
  options: RegisterKeywordHandlerOptions = {},
): void {
  for (const raw of handler.keywords) {
    const key = normalize(raw);
    if (!key) {
      throw new Error('Cannot register an empty keyword');
    }
    if (registry.has(key) && !options.overwrite) {
      throw new Error(
        `duplicate keyword registration: '${key}' is already registered`,
      );
    }
    registry.set(key, { keyword: key, handler });
  }
}

export function registerFallbackHandler(
  handler: FallbackHandler,
  options: RegisterKeywordHandlerOptions = {},
): void {
  if (fallback && !options.overwrite) {
    throw new Error(
      `duplicate fallback registration: '${fallback.name}' is already registered`,
    );
  }
  fallback = handler;
}

export function registerRecoveryResumeHandler(
  handler: RecoveryResumeHandler,
  options: RegisterKeywordHandlerOptions = {},
): void {
  if (recoveryResume && !options.overwrite) {
    throw new Error(
      `duplicate recovery-resume registration: '${recoveryResume.name}' is already registered`,
    );
  }
  recoveryResume = handler;
}

async function runRecoveryResume(
  ctx: InboundSmsContext,
): Promise<HandlerResult | null> {
  if (!recoveryResume) return null;
  try {
    return await recoveryResume.handle({ ...ctx });
  } catch (err) {
    logger.error('Inbound SMS recovery-resume handler threw', {
      tenantId: ctx.tenantId,
      messageSid: ctx.messageSid,
      handler: recoveryResume.name,
      error: err instanceof Error ? err.message : String(err),
    });
    return { handled: false, handler: recoveryResume.name, reason: 'handler_error' };
  }
}

/** N-003 — register the (single) content-based negotiation guardrail. */
export function registerNegotiationHandler(
  handler: FallbackHandler,
  options: RegisterKeywordHandlerOptions = {},
): void {
  if (negotiationHandler && !options.overwrite) {
    throw new Error(
      `duplicate negotiation-handler registration: '${negotiationHandler.name}' is already registered`,
    );
  }
  negotiationHandler = handler;
}

async function runNegotiation(ctx: InboundSmsContext): Promise<HandlerResult | null> {
  if (!negotiationHandler) return null;
  try {
    return await negotiationHandler.handle({ ...ctx });
  } catch (err) {
    logger.error('Inbound SMS negotiation handler threw', {
      tenantId: ctx.tenantId,
      messageSid: ctx.messageSid,
      handler: negotiationHandler.name,
      error: err instanceof Error ? err.message : String(err),
    });
    return { handled: false, handler: negotiationHandler.name, reason: 'handler_error' };
  }
}

/** U4 — register the (single) capture-all handler. */
export function registerCaptureHandler(
  handler: FallbackHandler,
  options: RegisterKeywordHandlerOptions = {},
): void {
  if (captureHandler && !options.overwrite) {
    throw new Error(
      `duplicate capture-handler registration: '${captureHandler.name}' is already registered`,
    );
  }
  captureHandler = handler;
}

async function runCapture(ctx: InboundSmsContext): Promise<HandlerResult | null> {
  if (!captureHandler) return null;
  try {
    return await captureHandler.handle({ ...ctx });
  } catch (err) {
    logger.error('Inbound SMS capture handler threw', {
      tenantId: ctx.tenantId,
      messageSid: ctx.messageSid,
      handler: captureHandler.name,
      error: err instanceof Error ? err.message : String(err),
    });
    return { handled: false, handler: captureHandler.name, reason: 'handler_error' };
  }
}

/** RV-050 — register the (single) inbound-media handler. */
export function registerMediaHandler(
  handler: MediaHandler,
  options: RegisterKeywordHandlerOptions = {},
): void {
  if (mediaHandler && !options.overwrite) {
    throw new Error(
      `duplicate media-handler registration: '${mediaHandler.name}' is already registered`,
    );
  }
  mediaHandler = handler;
}

/**
 * RV-050 — failure-isolated media ingestion. Awaited so the webhook's
 * side-effects complete before the 200 is returned, but ANY error is logged
 * and swallowed: media failures never break normal SMS handling.
 */
async function runMediaHandler(ctx: InboundSmsContext): Promise<void> {
  if (!mediaHandler || !ctx.media || ctx.media.length === 0) return;
  try {
    await mediaHandler.handle({ ...ctx, media: ctx.media.map((m) => ({ ...m })) });
  } catch (err) {
    logger.error('Inbound SMS media handler threw', {
      tenantId: ctx.tenantId,
      messageSid: ctx.messageSid,
      mediaHandler: mediaHandler.name,
      mediaCount: ctx.media.length,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function runFallback(ctx: InboundSmsContext): Promise<HandlerResult | null> {
  if (!fallback) return null;
  try {
    return await fallback.handle({ ...ctx });
  } catch (err) {
    logger.error('Inbound SMS fallback handler threw', {
      tenantId: ctx.tenantId,
      messageSid: ctx.messageSid,
      fallback: fallback.name,
      error: err instanceof Error ? err.message : String(err),
    });
    return { handled: false, handler: fallback.name, reason: 'handler_error' };
  }
}

export async function dispatchInboundSms(
  ctx: InboundSmsContext,
): Promise<HandlerResult> {
  // RV-050 — media ingestion runs FIRST and independently: a photo-only
  // message (empty body) must still ingest even though keyword routing
  // below has nothing to match. Failure-isolated inside runMediaHandler.
  await runMediaHandler(ctx);

  const firstToken = ctx.body.trim().split(/\s+/, 1)[0] ?? '';
  if (!firstToken) {
    return { handled: false, reason: 'no_matching_handler' };
  }

  // Strip surrounding punctuation so "Yes!", "OK.", '"approve"' route to
  // their keyword like the bare word does — handlers' own parsers are
  // punctuation-tolerant, but they never run if the lookup misses here.
  const token = firstToken.toLowerCase().replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '');
  const entry = token ? registry.get(token) : undefined;
  if (!entry) {
    const viaFallback = await runFallback(ctx);
    if (viaFallback?.handled) return viaFallback;
    // RV-116 — last chance: a reply on a dropped-call recovery thread.
    const viaResume = await runRecoveryResume(ctx);
    if (viaResume?.handled) return viaResume;
    // N-003 — last resort: a customer negotiation ask on an unclaimed message.
    const viaNegotiation = await runNegotiation(ctx);
    if (viaNegotiation?.handled) return viaNegotiation;
    // U4 — absolute last resort: capture the unclaimed text onto the sender's
    // conversation so it surfaces in the unified inbox instead of vanishing.
    const viaCapture = await runCapture(ctx);
    if (viaCapture?.handled) return viaCapture;
    return { handled: false, reason: 'no_matching_handler' };
  }

  let keywordResult: HandlerResult;
  try {
    keywordResult = await entry.handler.handle({ ...ctx });
  } catch (err) {
    logger.error('Inbound SMS handler threw', {
      tenantId: ctx.tenantId,
      messageSid: ctx.messageSid,
      keyword: entry.keyword,
      error: err instanceof Error ? err.message : String(err),
    });
    keywordResult = {
      handled: false,
      handler: entry.keyword,
      reason: 'handler_error',
    };
  }
  if (keywordResult.handled) return keywordResult;

  // The keyword's feature declined (e.g. 'out' from a non-technician
  // mobile). Give the fallback a look — during an owner edit session the
  // whole message is free-text and any first token is plausible.
  const viaFallback = await runFallback(ctx);
  if (viaFallback?.handled) return viaFallback;
  // RV-116 — last chance: a reply on a dropped-call recovery thread (e.g.
  // a customer replying "yes" — a keyword another feature owns but whose
  // handler declined a non-matching phone).
  const viaResume = await runRecoveryResume(ctx);
  if (viaResume?.handled) return viaResume;
  // N-003 — last resort: a customer negotiation ask the keyword handler declined.
  const viaNegotiation = await runNegotiation(ctx);
  if (viaNegotiation?.handled) return viaNegotiation;
  // U4 — absolute last resort: capture the unclaimed text onto the sender's
  // conversation (e.g. a customer replying free-text a keyword handler declined).
  const viaCapture = await runCapture(ctx);
  if (viaCapture?.handled) return viaCapture;
  return keywordResult;
}

/**
 * Test-only helper. Production code never calls this — feature bootstraps
 * register handlers exactly once at module-init time.
 */
export function __resetKeywordRegistryForTests(): void {
  registry.clear();
  fallback = undefined;
  recoveryResume = undefined;
  mediaHandler = undefined;
  negotiationHandler = undefined;
  captureHandler = undefined;
}

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

export interface InboundSmsContext {
  tenantId: string;
  fromE164: string;
  body: string;
  messageSid: string;
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

interface RegistryEntry {
  keyword: string;
  handler: KeywordHandler;
}

const registry = new Map<string, RegistryEntry>();

function normalize(keyword: string): string {
  return keyword.trim().toLowerCase();
}

export function registerKeywordHandler(handler: KeywordHandler): void {
  for (const raw of handler.keywords) {
    const key = normalize(raw);
    if (!key) {
      throw new Error('Cannot register an empty keyword');
    }
    if (registry.has(key)) {
      throw new Error(
        `duplicate keyword registration: '${key}' is already registered`,
      );
    }
    registry.set(key, { keyword: key, handler });
  }
}

export async function dispatchInboundSms(
  ctx: InboundSmsContext,
): Promise<HandlerResult> {
  const firstToken = ctx.body.trim().split(/\s+/, 1)[0] ?? '';
  if (!firstToken) {
    return { handled: false, reason: 'no_matching_handler' };
  }

  const entry = registry.get(firstToken.toLowerCase());
  if (!entry) {
    return { handled: false, reason: 'no_matching_handler' };
  }

  try {
    const result = await entry.handler.handle({ ...ctx });
    return result;
  } catch (err) {
    logger.error('Inbound SMS handler threw', {
      tenantId: ctx.tenantId,
      messageSid: ctx.messageSid,
      keyword: entry.keyword,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      handled: false,
      handler: entry.keyword,
      reason: 'handler_error',
    };
  }
}

/**
 * Test-only helper. Production code never calls this — feature bootstraps
 * register handlers exactly once at module-init time.
 */
export function __resetKeywordRegistryForTests(): void {
  registry.clear();
}

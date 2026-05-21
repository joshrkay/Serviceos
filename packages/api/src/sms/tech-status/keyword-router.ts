import {
  KeywordHandler,
  InboundSmsContext,
  HandlerResult,
} from '../inbound-dispatch';
import { TECH_STATUS_KEYWORDS } from '@ai-service-os/shared';
import {
  handleTechStatusSms,
  TechStatusHandlerDeps,
} from './handler';

/**
 * P6-028 — the P2-034 `KeywordHandler` for the tech "I'm out today" SMS.
 * Registers OUT|SICK|UNAVAILABLE and delegates to `handleTechStatusSms`.
 *
 * The handler NEVER throws — it always resolves a structured `HandlerResult`
 * (the dispatcher must never surface a 5xx to Twilio, which would re-fire an
 * already-acknowledged delivery).
 */
export class TechStatusKeywordHandler implements KeywordHandler {
  readonly keywords: readonly string[] = TECH_STATUS_KEYWORDS;

  constructor(private readonly deps: TechStatusHandlerDeps) {}

  async handle(ctx: InboundSmsContext): Promise<HandlerResult> {
    return handleTechStatusSms(ctx, this.deps);
  }
}

import {
  registerKeywordHandler,
  RegisterKeywordHandlerOptions,
} from '../inbound-dispatch';
import { TechStatusKeywordHandler } from './keyword-router';
import { TechStatusHandlerDeps } from './handler';

export { TechStatusKeywordHandler } from './keyword-router';
export {
  handleTechStatusSms,
  tenantLocalDate,
  type TechStatusHandlerDeps,
} from './handler';
export {
  InMemoryTechStatusTodayRepository,
  PgTechStatusTodayRepository,
  type TechStatusTodayRepository,
} from './idempotency';

/**
 * P6-028 — module init. Called once at app bootstrap to register the
 * OUT|SICK|UNAVAILABLE keyword handler with the P2-034 dispatcher. Returns the
 * registered handler so the caller can hold a reference if needed.
 *
 * `overwrite` is forwarded so a bootstrap that legitimately runs more than
 * once in the same process (e.g. across test files / multiple createApp calls)
 * can re-register without tripping the duplicate-keyword guard.
 */
export function registerTechStatusKeywords(
  deps: TechStatusHandlerDeps,
  options: RegisterKeywordHandlerOptions = {},
): TechStatusKeywordHandler {
  const handler = new TechStatusKeywordHandler(deps);
  registerKeywordHandler(handler, options);
  return handler;
}

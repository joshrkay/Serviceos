import {
  registerKeywordHandler,
  RegisterKeywordHandlerOptions,
} from '../inbound-dispatch';
import { TechStatusKeywordHandler } from './keyword-router';
import { TechStatusHandlerDeps } from './handler';
import { EnRouteSmsKeywordHandler, EnRouteSmsHandlerDeps } from './en-route-keyword';

export { TechStatusKeywordHandler } from './keyword-router';
export {
  handleTechStatusSms,
  tenantLocalDate,
  type TechStatusHandlerDeps,
} from './handler';
// B5.5 — the en-route ('omw' / 'on my way') SMS keyword leg.
export {
  handleEnRouteSms,
  EnRouteSmsKeywordHandler,
  type EnRouteSmsHandlerDeps,
} from './en-route-keyword';
export {
  InMemoryTechStatusTodayRepository,
  PgTechStatusTodayRepository,
  type TechStatusTodayRepository,
} from './idempotency';
// RV-050 — inbound MMS photo ingestion from registered tech phones.
// P0-009: the registered media handler ENQUEUES; the pipeline runs in
// src/workers/mms-ingest-worker.ts.
export {
  ingestInboundMms,
  registerMmsIngestHandler,
  createTwilioMediaFetcher,
  mmsIngestIdempotencyKey,
  MMS_CLOCK_IN_FIRST_REPLY,
  MMS_INGEST_QUEUE_TYPE,
  type MmsIngestDeps,
  type MmsIngestEnqueueDeps,
  type MmsIngestQueuePayload,
  type MmsIngestResult,
  type MediaFetcher,
} from './mms-ingest';

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

/**
 * B5.5 — module init for the en-route SMS keyword(s) ('omw' / 'on my way').
 * Separate registration from `registerTechStatusKeywords` above: different
 * keyword set, different handler, routes to the SAME audited direct
 * status act the app en-route button and the voice leg use.
 */
export function registerEnRouteSmsKeyword(
  deps: EnRouteSmsHandlerDeps,
  options: RegisterKeywordHandlerOptions = {},
): EnRouteSmsKeywordHandler {
  const handler = new EnRouteSmsKeywordHandler(deps);
  registerKeywordHandler(handler, options);
  return handler;
}

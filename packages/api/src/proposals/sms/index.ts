/**
 * P2-034 — SMS approval transport bootstrap.
 *
 * `registerProposalReplySms` is called once at app init to register the
 * APPROVE/Y, REJECT/N, EDIT keyword handler plus the free-text fallback
 * (edit-session capture + clarify-once) with the inbound-SMS dispatcher.
 */
import {
  registerKeywordHandler,
  registerFallbackHandler,
  type RegisterKeywordHandlerOptions,
} from '../../sms/inbound-dispatch';
import {
  ProposalReplyKeywordHandler,
  ProposalReplyFallbackHandler,
  type ProposalSmsReplyDeps,
} from './reply-handler';
import { buildStartOrApproveKeywordHandler } from './start-keyword';
import type { DncRepository } from '../../compliance/dnc';

export { type ProposalSmsReplyDeps } from './reply-handler';
export {
  createProposalSmsEvent,
  encodeDigestApproveAllBody,
  parseDigestApproveAllIds,
  InMemoryProposalSmsEventRepository,
  PgProposalSmsEventRepository,
  type OutboundAnchorKind,
} from './sms-event';
export { createLlmEditInterpreter } from './interpret-edit';

export function registerProposalReplySms(
  deps: ProposalSmsReplyDeps,
  options: RegisterKeywordHandlerOptions = {},
  compliance?: { dncRepo: DncRepository },
): void {
  const replyHandler = new ProposalReplyKeywordHandler(deps);
  registerKeywordHandler(replyHandler, options);
  registerFallbackHandler(new ProposalReplyFallbackHandler(deps), options);
  // `YES` belongs to the compliance opt-in keywords — replace the plain
  // START handler with the composite (opt-in first, then owner approval)
  // instead of stealing the keyword. See start-keyword.ts.
  if (compliance) {
    registerKeywordHandler(
      buildStartOrApproveKeywordHandler({
        dncRepo: compliance.dncRepo,
        proposalReplyHandler: replyHandler,
      }),
      { overwrite: true },
    );
  }
}

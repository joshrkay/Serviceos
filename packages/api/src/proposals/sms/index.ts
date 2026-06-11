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

export { type ProposalSmsReplyDeps } from './reply-handler';
export {
  createProposalSmsEvent,
  InMemoryProposalSmsEventRepository,
  PgProposalSmsEventRepository,
} from './sms-event';
export { createLlmEditInterpreter } from './interpret-edit';

export function registerProposalReplySms(
  deps: ProposalSmsReplyDeps,
  options: RegisterKeywordHandlerOptions = {},
): void {
  registerKeywordHandler(new ProposalReplyKeywordHandler(deps), options);
  registerFallbackHandler(new ProposalReplyFallbackHandler(deps), options);
}

import {
  registerKeywordHandler,
  registerFallbackHandler,
  RegisterKeywordHandlerOptions,
} from '../inbound-dispatch';
import { ProposalApprovalKeywordHandler } from './keyword-router';
import { ProposalApprovalHandlerDeps, handleProposalApprovalSms } from './handler';

export { ProposalApprovalKeywordHandler } from './keyword-router';
export {
  handleProposalApprovalSms,
  recordOutboundProposalSms,
  type ProposalApprovalHandlerDeps,
} from './handler';
export {
  InMemoryProposalSmsEventRepository,
  PgProposalSmsEventRepository,
  type ProposalSmsEventRepository,
} from './repository';

export function registerProposalApprovalKeywords(
  deps: ProposalApprovalHandlerDeps,
  options: RegisterKeywordHandlerOptions = {},
): ProposalApprovalKeywordHandler {
  const handler = new ProposalApprovalKeywordHandler(deps);
  registerKeywordHandler(handler, options);
  // After an owner replies EDIT, their next message is free text ("make it
  // $500") with no registered keyword, so the dispatcher routes it to the
  // fallback. Without one, the edit session opened by the keyword handler
  // could never be resumed and the edit would be silently dropped.
  // handleProposalApprovalSms checks for an active edit session up front and
  // declines (handled:false) for non-owner phones, so dropped-call
  // recovery-resume still sees customer replies.
  registerFallbackHandler(
    {
      name: 'proposal-approval',
      handle: (ctx) => handleProposalApprovalSms(ctx, deps),
    },
    options,
  );
  return handler;
}

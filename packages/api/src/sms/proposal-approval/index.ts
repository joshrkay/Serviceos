import {
  registerKeywordHandler,
  RegisterKeywordHandlerOptions,
} from '../inbound-dispatch';
import { ProposalApprovalKeywordHandler } from './keyword-router';
import { ProposalApprovalHandlerDeps } from './handler';

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
  return handler;
}

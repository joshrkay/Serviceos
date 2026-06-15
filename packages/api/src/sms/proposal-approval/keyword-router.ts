import {
  KeywordHandler,
  InboundSmsContext,
  HandlerResult,
} from '../inbound-dispatch';
import { ALL_PROPOSAL_SMS_KEYWORDS } from '@ai-service-os/shared';
import {
  handleProposalApprovalSms,
  ProposalApprovalHandlerDeps,
} from './handler';

/**
 * P2-034 — keyword handler for owner proposal APPROVE/EDIT/REJECT SMS.
 */
export class ProposalApprovalKeywordHandler implements KeywordHandler {
  readonly keywords: readonly string[] = ALL_PROPOSAL_SMS_KEYWORDS;

  constructor(private readonly deps: ProposalApprovalHandlerDeps) {}

  async handle(ctx: InboundSmsContext): Promise<HandlerResult> {
    return handleProposalApprovalSms(ctx, this.deps);
  }
}

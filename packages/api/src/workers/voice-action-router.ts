import { WorkerHandler, QueueMessage } from '../queues/queue';
import { Logger } from '../logging/logger';
import { LLMGateway } from '../ai/gateway/gateway';
import { ProposalRepository, createProposal, CreateProposalInput } from '../proposals/proposal';
import { classifyIntent, IntentType } from '../ai/orchestration/intent-classifier';
import { InvoiceTaskHandler } from '../ai/tasks/invoice-task';
import { EstimateTaskHandler } from '../ai/tasks/estimate-task';
import { CreateAppointmentAITaskHandler } from '../ai/tasks/create-appointment-task';
import { InvoiceEditTaskHandler } from '../ai/tasks/invoice-edit-task';
import { EstimateEditTaskHandler } from '../ai/tasks/estimate-edit-task';
import { TaskHandler, TaskContext, TaskResult } from '../ai/tasks/task-handlers';
import { ProposalType } from '../proposals/proposal';

/**
 * voice-action-router — the bridge between "Whisper gave us a
 * transcript" and "a proposal landed in the operator's review queue".
 *
 * Routed intents today:
 *   create_invoice      → draft_invoice proposal   (Phase 1)
 *   draft_estimate      → draft_estimate proposal  (Phase 1)
 *   create_appointment  → create_appointment       (Phase 1)
 *   update_invoice      → update_invoice           (Phase 2 — add/remove line item)
 *   update_estimate     → update_estimate          (Phase 2b — add/remove line item)
 *
 * Anything classified as `unknown` or below the confidence threshold
 * is dropped with an info log. The operator sees nothing in their
 * inbox — future phases will turn these into clarification prompts
 * instead of silent drops.
 */

export interface VoiceActionRouterPayload {
  tenantId: string;
  userId: string;
  transcript: string;
  conversationId?: string;
  recordingId?: string;
}

export interface VoiceActionRouterDeps {
  gateway: LLMGateway;
  proposalRepo: ProposalRepository;
}

const INTENT_TO_PROPOSAL_TYPE: Record<Exclude<IntentType, 'unknown'>, ProposalType> = {
  create_invoice: 'draft_invoice',
  draft_estimate: 'draft_estimate',
  create_appointment: 'create_appointment',
  update_invoice: 'update_invoice',
  update_estimate: 'update_estimate',
  issue_invoice: 'issue_invoice',
};

/**
 * Handles "send/issue invoice" voice commands. No LLM call needed —
 * the payload is just { invoiceId }. The invoice ID is resolved from:
 *   1. extractedEntities.jobReference (explicit mention like "invoice 1024")
 *   2. The most recent draft_invoice proposal in the same conversation
 *      (handles "the one we just drafted")
 * If neither resolves, the proposal is created with an empty invoiceId
 * so the execution handler can return a clear validation failure.
 */
class IssueInvoiceTaskHandler implements TaskHandler {
  readonly taskType: ProposalType = 'issue_invoice';

  constructor(private readonly proposalRepo: ProposalRepository) {}

  async handle(context: TaskContext): Promise<TaskResult> {
    let invoiceId: string | undefined;

    if (
      context.existingEntities?.jobReference &&
      typeof context.existingEntities.jobReference === 'string'
    ) {
      invoiceId = context.existingEntities.jobReference;
    }

    if (!invoiceId && context.conversationId) {
      const all = await this.proposalRepo.findByTenant(context.tenantId);
      const recentDraft = all
        .filter(
          (p) =>
            p.proposalType === 'draft_invoice' &&
            p.sourceContext?.conversationId === context.conversationId &&
            p.resultEntityId
        )
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
      if (recentDraft?.resultEntityId) {
        invoiceId = recentDraft.resultEntityId;
      }
    }

    const input: CreateProposalInput = {
      tenantId: context.tenantId,
      proposalType: 'issue_invoice',
      payload: invoiceId ? { invoiceId } : {},
      summary: invoiceId
        ? `Issue invoice ${invoiceId}`
        : context.message,
      sourceContext: context.conversationId ? { conversationId: context.conversationId } : undefined,
      createdBy: context.userId,
    };

    const proposal = createProposal(input);
    return { proposal, taskType: 'issue_invoice' };
  }
}

function buildHandlers(deps: VoiceActionRouterDeps): Map<ProposalType, TaskHandler> {
  const handlers = new Map<ProposalType, TaskHandler>();
  handlers.set('draft_invoice', new InvoiceTaskHandler(deps.gateway));
  handlers.set('draft_estimate', new EstimateTaskHandler(deps.gateway));
  handlers.set('create_appointment', new CreateAppointmentAITaskHandler(deps.gateway));
  handlers.set('update_invoice', new InvoiceEditTaskHandler(deps.gateway));
  handlers.set('update_estimate', new EstimateEditTaskHandler(deps.gateway));
  handlers.set('issue_invoice', new IssueInvoiceTaskHandler(deps.proposalRepo));
  return handlers;
}

export function createVoiceActionRouterWorker(
  deps: VoiceActionRouterDeps
): WorkerHandler<VoiceActionRouterPayload> {
  const handlers = buildHandlers(deps);

  return {
    type: 'voice_action_router',
    async handle(
      message: QueueMessage<VoiceActionRouterPayload>,
      logger: Logger
    ): Promise<void> {
      const { tenantId, userId, transcript, conversationId, recordingId } = message.payload;

      const log = logger.child({ tenantId, recordingId, transcriptLen: transcript.length });
      log.info('voice-action-router: classifying transcript');

      if (!transcript || transcript.trim().length === 0) {
        log.info('voice-action-router: empty transcript, skipping');
        return;
      }

      const classification = await classifyIntent(transcript, { tenantId }, deps.gateway);

      if (classification.intentType === 'unknown') {
        log.info('voice-action-router: classified as unknown, dropping', {
          confidence: classification.confidence,
          reasoning: classification.reasoning,
        });
        return;
      }

      const proposalType = INTENT_TO_PROPOSAL_TYPE[classification.intentType];
      const handler = handlers.get(proposalType);
      if (!handler) {
        // Defensive — every non-unknown intent maps to a handler above.
        log.warn('voice-action-router: no handler for intent', { proposalType });
        return;
      }

      const context: TaskContext = {
        tenantId,
        userId,
        message: transcript,
        conversationId,
        existingEntities: classification.extractedEntities as Record<string, unknown> | undefined,
      };

      const { proposal } = await handler.handle(context);
      await deps.proposalRepo.create(proposal);

      log.info('voice-action-router: proposal created from voice', {
        proposalId: proposal.id,
        proposalType: proposal.proposalType,
        classifierConfidence: classification.confidence,
        proposalConfidence: proposal.confidenceScore,
      });
    },
  };
}

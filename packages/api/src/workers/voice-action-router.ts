import { WorkerHandler, QueueMessage } from '../queues/queue';
import { Logger } from '../logging/logger';
import { LLMGateway } from '../ai/gateway/gateway';
import { ProposalRepository } from '../proposals/proposal';
import { classifyIntent, IntentType } from '../ai/orchestration/intent-classifier';
import { InvoiceTaskHandler } from '../ai/tasks/invoice-task';
import { EstimateTaskHandler } from '../ai/tasks/estimate-task';
import { CreateAppointmentAITaskHandler } from '../ai/tasks/create-appointment-task';
import { InvoiceEditTaskHandler } from '../ai/tasks/invoice-edit-task';
import { EstimateEditTaskHandler } from '../ai/tasks/estimate-edit-task';
import { TaskHandler, TaskContext } from '../ai/tasks/task-handlers';
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
};

function buildHandlers(gateway: LLMGateway): Map<ProposalType, TaskHandler> {
  const handlers = new Map<ProposalType, TaskHandler>();
  handlers.set('draft_invoice', new InvoiceTaskHandler(gateway));
  handlers.set('draft_estimate', new EstimateTaskHandler(gateway));
  handlers.set('create_appointment', new CreateAppointmentAITaskHandler(gateway));
  handlers.set('update_invoice', new InvoiceEditTaskHandler(gateway));
  handlers.set('update_estimate', new EstimateEditTaskHandler(gateway));
  return handlers;
}

export function createVoiceActionRouterWorker(
  deps: VoiceActionRouterDeps
): WorkerHandler<VoiceActionRouterPayload> {
  const handlers = buildHandlers(deps.gateway);

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

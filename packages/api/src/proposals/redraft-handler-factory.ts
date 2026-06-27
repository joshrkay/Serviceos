/**
 * U1 (E9) — re-draft handler factory for entity-resolution.
 *
 * When the owner picks "which Bob?" on a voice_clarification, resolveProposalEntity
 * must re-run the ORIGINAL task handler (draft_invoice / draft_estimate /
 * create_customer / …) with the chosen id injected — so the resolved proposal
 * carries the grounded, executable payload instead of a non-executable
 * voice_clarification (the E9 dead-end: approving a clarification was a no-op).
 *
 * This factory is the seam: it builds ONLY the handlers an entity-ambiguity
 * clarification can re-draft to, keyed by IntentType. resolveProposalEntity
 * takes it as an injected dependency (a plain function) so it stays unit-
 * testable with a mocked handler and never has to eagerly import the whole
 * voice-action-router graph.
 *
 * The set is intentionally narrow: entity ambiguity only ever arises on the
 * `customer` / `job` reference resolution path (annotateResolvedEntities), so
 * the re-draftable intents are exactly the action intents that carry a
 * customerName / jobReference — invoice, estimate, appointment, customer, job,
 * and the update/scheduling variants that take a resolved id. Lookup/approval/
 * unknown intents never reach a clarification with candidates.
 */
import { LLMGateway } from '../ai/gateway/gateway';
import { CatalogItemRepository } from '../catalog/catalog-item';
import { IntentType } from '../ai/orchestration/intent-classifier';
import { TaskHandler } from '../ai/tasks/task-handlers';
import { ProposalType } from './proposal';
import { INTENT_TO_PROPOSAL_TYPE } from '../workers/voice-action-router';
import { InvoiceTaskHandler } from '../ai/tasks/invoice-task';
import { EstimateTaskHandler } from '../ai/tasks/estimate-task';
import { CreateCustomerTaskHandler } from '../ai/tasks/task-handlers';
import { CreateJobVoiceTaskHandler } from '../ai/tasks/voice-extended-tasks';

/**
 * Resolve the re-draft TaskHandler for a recovered original intent, or
 * undefined when the intent has no re-draftable handler. Pure lookup — the
 * handlers are built once when the factory is constructed.
 */
export type RedraftHandlerFactory = (intentType: IntentType) => TaskHandler | undefined;

export interface RedraftHandlerFactoryDeps {
  gateway: LLMGateway;
  /**
   * P22 catalog grounding for the invoice/estimate re-draft handlers. When
   * present, re-drafted line items are resolved against the tenant catalog and
   * matched prices override the LLM's numbers — the same grounding the
   * non-ambiguous voice path applies. Optional so tests without a catalog keep
   * the pre-P22 behavior.
   */
  catalogRepo?: CatalogItemRepository;
}

/**
 * Build the entity-resolution re-draft handler factory. Constructs the handler
 * set ONCE (mirroring buildHandlers in voice-action-router for the same types)
 * and returns a lookup keyed by IntentType via INTENT_TO_PROPOSAL_TYPE.
 */
export function createRedraftHandlerFactory(
  deps: RedraftHandlerFactoryDeps,
): RedraftHandlerFactory {
  const byProposalType = new Map<ProposalType, TaskHandler>();
  // Catalog-grounded drafting handlers (the common ambiguity case: "invoice
  // Bob" / "estimate for the Rodriguez job").
  byProposalType.set('draft_invoice', new InvoiceTaskHandler(deps.gateway, deps.catalogRepo));
  byProposalType.set('draft_estimate', new EstimateTaskHandler(deps.gateway, deps.catalogRepo));
  // Passthrough capture handlers — the resolved id is stamped onto the payload
  // by resolveProposalEntity via existingEntities, exactly like the
  // non-ambiguous voice path.
  byProposalType.set('create_customer', new CreateCustomerTaskHandler());
  byProposalType.set('create_job', new CreateJobVoiceTaskHandler());

  return (intentType: IntentType): TaskHandler | undefined => {
    if (intentType === 'unknown') return undefined;
    const proposalType = INTENT_TO_PROPOSAL_TYPE[intentType];
    if (!proposalType) return undefined;
    return byProposalType.get(proposalType);
  };
}

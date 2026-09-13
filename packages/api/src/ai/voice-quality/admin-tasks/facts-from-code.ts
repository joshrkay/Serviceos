/**
 * Build SpeakableCatalogFacts from live production modules.
 * Isolated so the coverage pure functions stay free of side effects.
 */
import { INTENT_TO_PROPOSAL_TYPE } from '../../../proposals/voice-intent-map';
import { createExecutionHandlerRegistry } from '../../../proposals/execution/handlers';
import { isLookupIntent, SUPPORTED_INTENTS } from '../../orchestration/intent-classifier';
import {
  DEFAULT_SPECIAL_INTENTS,
  type SpeakableCatalogFacts,
} from './coverage';

export function buildSpeakableCatalogFactsFromCode(): SpeakableCatalogFacts {
  const intentToProposal: Record<string, string> = {};
  for (const [intent, pt] of Object.entries(INTENT_TO_PROPOSAL_TYPE)) {
    if (pt) intentToProposal[intent] = pt;
  }

  const registry = createExecutionHandlerRegistry({
    invoiceRepo: {} as never,
    estimateRepo: {} as never,
    jobRepo: {} as never,
  });
  const handlerProposalTypes = new Set<string>([...registry.keys()]);

  const lookupIntents = new Set<string>();
  for (const intent of SUPPORTED_INTENTS) {
    if (isLookupIntent(intent)) lookupIntents.add(intent);
  }

  return {
    intentToProposal,
    handlerProposalTypes,
    lookupIntents,
    specialIntents: new Set(DEFAULT_SPECIAL_INTENTS),
  };
}

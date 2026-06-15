/**
 * U1 — Voice action catalog ↔ code contract.
 *
 * `docs/reference/voice-action-catalog.md` is the human-readable answer to
 * "what can a tradesperson do by speaking?". This test pins the catalog's
 * machine-readable block to the actual code so the doc cannot silently rot
 * the way `docs/remaining-features.md` did. If an intent, proposal type,
 * action class, or execution handler changes without updating the catalog,
 * one of these assertions fails.
 *
 * The four sources of truth it checks against:
 *   - INTENT_TO_PROPOSAL_TYPE       (workers/voice-action-router.ts)   — what's speakable
 *   - createExecutionHandlerRegistry (proposals/execution/handlers.ts) — what can execute
 *   - actionClassForProposalType    (proposals/proposal.ts)           — the safety class
 *   - SUPPORTED_INTENTS / isVoice*  (ai/orchestration/intent-classifier.ts)
 */
import { promises as fs } from 'fs';
import path from 'path';

import {
  SUPPORTED_INTENTS,
  isVoiceApprovalIntent,
  isVoiceEditIntent,
  type IntentType,
} from '../../src/ai/orchestration/intent-classifier';
import { INTENT_TO_PROPOSAL_TYPE } from '../../src/workers/voice-action-router';
import { createExecutionHandlerRegistry } from '../../src/proposals/execution/handlers';
import { ProposalType, actionClassForProposalType } from '../../src/proposals/proposal';

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const CATALOG_PATH = path.resolve(REPO_ROOT, 'docs/reference/voice-action-catalog.md');

interface CatalogRow {
  intent: string;
  proposalType: string;
  actionClass: string;
}
interface Catalog {
  speakable: CatalogRow[];
  handlerNoOnramp: string[];
  gated: string[];
}

async function loadCatalog(): Promise<Catalog> {
  const md = await fs.readFile(CATALOG_PATH, 'utf8');
  const begin = md.indexOf('<!-- BEGIN machine-readable: voice-action-catalog -->');
  const end = md.indexOf('<!-- END machine-readable: voice-action-catalog -->');
  if (begin < 0 || end < 0) {
    throw new Error('voice-action-catalog machine-readable markers not found');
  }
  const between = md.slice(begin, end);
  const jsonStart = between.indexOf('{');
  const jsonEnd = between.lastIndexOf('}');
  return JSON.parse(between.slice(jsonStart, jsonEnd + 1)) as Catalog;
}

/**
 * Every proposal type that has an execution handler. The two conditional
 * blocks in createExecutionHandlerRegistry register update_invoice /
 * issue_invoice / apply_late_fee (needs invoiceRepo) and update_estimate
 * (needs estimateRepo), so pass truthy stubs to capture the full set. We
 * only read each handler's `proposalType`, never call it.
 */
function allHandlerTypes(): Set<ProposalType> {
  const registry = createExecutionHandlerRegistry({
    invoiceRepo: {} as any,
    estimateRepo: {} as any,
  });
  return new Set(registry.keys());
}

describe('U1: voice action catalog ↔ code contract', () => {
  it('speakable list exactly matches INTENT_TO_PROPOSAL_TYPE (intent + proposal type + action class)', async () => {
    const catalog = await loadCatalog();
    const codeMap = INTENT_TO_PROPOSAL_TYPE as Record<string, ProposalType>;

    const codeIntents = Object.keys(codeMap).sort();
    const docIntents = catalog.speakable.map((r) => r.intent).sort();
    expect(docIntents).toEqual(codeIntents);

    for (const row of catalog.speakable) {
      expect(codeMap[row.intent]).toBe(row.proposalType);
      expect(actionClassForProposalType(row.proposalType as ProposalType)).toBe(row.actionClass);
    }
  });

  it('every speakable proposal type has an execution handler', async () => {
    const catalog = await loadCatalog();
    const handlerTypes = allHandlerTypes();
    for (const row of catalog.speakable) {
      expect(handlerTypes.has(row.proposalType as ProposalType)).toBe(true);
    }
  });

  it('every execution handler is classified in the catalog exactly once (no undocumented handler)', async () => {
    const catalog = await loadCatalog();
    const handlerTypes = allHandlerTypes();
    const documented = new Set<string>([
      ...catalog.speakable.map((r) => r.proposalType),
      ...catalog.handlerNoOnramp,
    ]);
    // If this fails after adding a handler, classify the new proposal type
    // into section A (speakable) or section B (handler, no on-ramp).
    expect([...handlerTypes].sort()).toEqual([...documented].sort());
  });

  it('"handler, no on-ramp" actions have a handler but are NOT reachable by voice', async () => {
    const catalog = await loadCatalog();
    const handlerTypes = allHandlerTypes();
    const mappedTypes = new Set(Object.values(INTENT_TO_PROPOSAL_TYPE));
    for (const t of catalog.handlerNoOnramp) {
      expect(handlerTypes.has(t as ProposalType)).toBe(true);
      expect(mappedTypes.has(t as ProposalType)).toBe(false);
    }
  });

  it('gated approval/edit intents are recognised by code and never mapped to a proposal', async () => {
    const catalog = await loadCatalog();
    const codeMap = INTENT_TO_PROPOSAL_TYPE as Record<string, ProposalType | undefined>;
    for (const intent of catalog.gated) {
      expect(SUPPORTED_INTENTS).toContain(intent as IntentType);
      expect(codeMap[intent]).toBeUndefined();
      expect(isVoiceApprovalIntent(intent) || isVoiceEditIntent(intent)).toBe(true);
    }
  });
});

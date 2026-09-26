/**
 * #842 — regenerate the checkable blocks of docs/reference/voice-action-catalog.md
 * from the capability declarations.
 *
 *   npm run catalog:generate   # rewrite the doc in place
 *   npm run catalog:check      # exit 1 if the committed doc differs from a regenerate
 *
 * CI does not need the check script: the same comparison runs in the unit
 * suite (test/ai/voice-action-catalog.contract.test.ts).
 */
import * as fs from 'fs';
import * as path from 'path';

import { CAPABILITIES } from '../src/capabilities/capabilities';
import { applyGeneratedBlocks, renderCatalogBlocks } from '../src/capabilities/catalog';
import { KNOWN_PROOF_GAPS, scanExecutionProofs } from '../src/capabilities/proven-bar';
import { createExecutionHandlerRegistry } from '../src/proposals/execution/handlers';
import { actionClassForProposalType, type ProposalType } from '../src/proposals/proposal';

const API_ROOT = path.resolve(__dirname, '..');
export const CATALOG_PATH = path.resolve(API_ROOT, '../../docs/reference/voice-action-catalog.md');
const INTEGRATION_DIR = path.resolve(API_ROOT, 'test/integration');

/**
 * Every proposal type the execution registry can execute. The conditional
 * blocks register some handlers only when their repo is wired, so truthy
 * stubs capture the full set; only the keys are read, no handler is called.
 */
function allHandlerTypes(): string[] {
  const registry = createExecutionHandlerRegistry({
    invoiceRepo: {} as never,
    estimateRepo: {} as never,
    jobRepo: {} as never,
  });
  return [...registry.keys()];
}

/** Return `doc` with every generated block replaced by a fresh render. */
export function regenerateVoiceActionCatalog(doc: string): string {
  const scan = scanExecutionProofs(INTEGRATION_DIR);
  const blocks = renderCatalogBlocks({
    capabilities: CAPABILITIES,
    actionClassOf: (t) => actionClassForProposalType(t as ProposalType),
    handlerTypes: allHandlerTypes(),
    proofs: scan.proofs,
    grandfathered: KNOWN_PROOF_GAPS,
  });
  return applyGeneratedBlocks(doc, blocks);
}

function main(): void {
  const check = process.argv.includes('--check');
  const committed = fs.readFileSync(CATALOG_PATH, 'utf8');
  const regenerated = regenerateVoiceActionCatalog(committed);
  if (check) {
    if (regenerated !== committed) {
      console.error('voice-action-catalog.md is stale — run `npm run catalog:generate` in packages/api');
      process.exit(1);
    }
    console.log('voice-action-catalog.md is up to date');
    return;
  }
  fs.writeFileSync(CATALOG_PATH, regenerated);
  console.log(`wrote ${path.relative(process.cwd(), CATALOG_PATH)}`);
}

if (require.main === module) main();

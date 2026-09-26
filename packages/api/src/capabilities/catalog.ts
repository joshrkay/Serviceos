/**
 * #842 — render the checkable parts of `docs/reference/voice-action-catalog.md`
 * from the capability declarations.
 *
 * The catalog lied twice while hand-maintained: a prose claim that a new
 * lookup was "covered automatically" (false — dispatch was three switches),
 * and a persistence column that listed 8 proofs when the tests held 29. A
 * contract test already checked the enumerable parts; both errors survived
 * because they lived in parts it could not check.
 *
 * The decision (D-033 part 3): every part of the catalog that makes a
 * checkable claim — which capabilities exist, their proposal type, action
 * class, surfaces, execution proof, lookups, gated intents, direct acts, and
 * the machine-readable block — is GENERATED between markers. What remains
 * hand-written is prose that explains; it may point at the generated blocks,
 * and it should not restate their facts (a count in prose is a claim nothing
 * checks). A drift test fails CI when the committed file differs from a
 * regenerate.
 *
 * Pure: the caller (scripts/generate-voice-action-catalog.ts) assembles the
 * inputs — the execution handler registry, the action classes, and the proof
 * scan — so this module stays free of I/O and application wiring.
 */
import {
  CAPABILITY_SURFACES,
  isAvailableOn,
  type CapabilityDeclaration,
} from './capabilities';
import { proofKeyOf } from './proven-bar';

export interface CatalogInputs {
  readonly capabilities: Readonly<Record<string, CapabilityDeclaration>>;
  /** `actionClassForProposalType` — the class is derived from the type, never declared. */
  readonly actionClassOf: (proposalType: string) => string;
  /** Every proposal type the execution registry can execute. */
  readonly handlerTypes: readonly string[];
  /** proof key → files under test/integration that prove it (from the #841 scan). */
  readonly proofs: ReadonlyMap<string, readonly string[]>;
  /** The #841 grandfather register. */
  readonly grandfathered: ReadonlySet<string>;
}

function surfacesCell(cap: CapabilityDeclaration): string {
  const on = CAPABILITY_SURFACES.filter((s) => isAvailableOn(cap, s));
  if (on.length === CAPABILITY_SURFACES.length) return 'all';
  const off = CAPABILITY_SURFACES.filter((s) => !isAvailableOn(cap, s));
  return `${on.join(', ') || 'none'} (not ${off.join(', ')})`;
}

function proofCell(intent: string, key: string | undefined, inputs: CatalogInputs): string {
  const files = key === undefined ? undefined : inputs.proofs.get(key);
  if (files && files.length > 0) {
    return `integration (${files.map((f) => `\`integration/${f}\``).join(', ')})`;
  }
  if (inputs.grandfathered.has(intent)) return '**none** — grandfathered gap (#841)';
  return '**none**';
}

const GENERATED_NOTE =
  '<!-- Generated from packages/api/src/capabilities/capabilities.ts — do not edit by hand; run `npm run catalog:generate` in packages/api. -->';

export function renderCatalogBlocks(inputs: CatalogInputs): Map<string, string> {
  const entries = Object.entries(inputs.capabilities);
  const proposals = entries.filter(([, c]) => c.kind === 'proposal') as Array<
    [string, Extract<CapabilityDeclaration, { kind: 'proposal' }>]
  >;
  const directActs = entries.filter(([, c]) => c.kind === 'direct_act') as Array<
    [string, Extract<CapabilityDeclaration, { kind: 'direct_act' }>]
  >;
  const lookups = entries
    .filter(([, c]) => c.kind === 'lookup')
    .map(([i]) => i)
    .sort();
  const gated = entries.filter(([, c]) => c.kind === 'approval');
  const mappedTypes = new Set<string>(proposals.map(([, c]) => c.proposalType));
  const handlerNoOnramp = [...new Set(inputs.handlerTypes)].filter((t) => !mappedTypes.has(t)).sort();

  const blocks = new Map<string, string>();

  const provenCount = proposals.filter(([i, c]) => inputs.proofs.has(proofKeyOf(c, i)!)).length;
  blocks.set(
    'speakable',
    [
      GENERATED_NOTE,
      `${proposals.length} actions — ${provenCount} with real-database execution proof, ` +
        `${proposals.length - provenCount} without. "Surfaces" is phone / memo / chat; an ` +
        'opt-out is declared with its reason in the declaration. "Execution proof" lists the ' +
        'integration tests that carry a `provesExecution(...)` tag for the proposal type and open a ' +
        'real pool (#841) — derived from the tests, never typed here.',
      '',
      '| Spoken example | Intent | Proposal type | Class | Surfaces | Execution proof |',
      '|---|---|---|---|---|---|',
      ...proposals.map(
        ([intent, c]) =>
          `| "${c.example}" | \`${intent}\` | \`${c.proposalType}\` | ${inputs.actionClassOf(c.proposalType)} | ` +
          `${surfacesCell(c)} | ${proofCell(intent, c.proposalType, inputs)} |`,
      ),
    ].join('\n'),
  );

  blocks.set(
    'surface-opt-outs',
    [
      GENERATED_NOTE,
      '| Intent | Not served on | Why |',
      '|---|---|---|',
      ...entries.flatMap(([intent, c]) =>
        Object.entries(c.unavailableOn ?? {}).map(
          ([surface, reason]) => `| \`${intent}\` | ${surface} | ${reason} |`,
        ),
      ),
    ].join('\n'),
  );

  blocks.set(
    'handler-no-onramp',
    [
      GENERATED_NOTE,
      '| Proposal type | Class |',
      '|---|---|',
      ...handlerNoOnramp.map((t) => `| \`${t}\` | ${inputs.actionClassOf(t)} |`),
    ].join('\n'),
  );

  blocks.set(
    'gated',
    [GENERATED_NOTE, gated.map(([i]) => `\`${i}\``).join(', ')].join('\n'),
  );

  blocks.set(
    'lookups',
    [
      GENERATED_NOTE,
      `${lookups.length} \`lookup_*\` intents: ${lookups.map((i) => `\`${i}\``).join(', ')}.`,
    ].join('\n'),
  );

  blocks.set(
    'direct-acts',
    [
      GENERATED_NOTE,
      '| Spoken example | Intent | Execution proof |',
      '|---|---|---|',
      ...directActs.map(
        ([intent, c]) => `| "${c.example}" | \`${intent}\` | ${proofCell(intent, intent, inputs)} |`,
      ),
    ].join('\n'),
  );

  const machine = {
    speakable: proposals.map(([intent, c]) => ({
      intent,
      proposalType: c.proposalType,
      actionClass: inputs.actionClassOf(c.proposalType),
    })),
    lookups,
    handlerNoOnramp,
    gated: gated.map(([i]) => i),
  };
  const json = [
    '{',
    '  "speakable": [',
    machine.speakable
      .map(
        (r) =>
          `    { "intent": ${JSON.stringify(r.intent)}, "proposalType": ${JSON.stringify(r.proposalType)}, ` +
          `"actionClass": ${JSON.stringify(r.actionClass)} }`,
      )
      .join(',\n'),
    '  ],',
    `  "lookups": ${JSON.stringify(machine.lookups)},`,
    `  "handlerNoOnramp": ${JSON.stringify(machine.handlerNoOnramp)},`,
    `  "gated": ${JSON.stringify(machine.gated)}`,
    '}',
  ].join('\n');
  blocks.set('voice-action-catalog', ['```json', json, '```'].join('\n'));

  return blocks;
}

function markersFor(name: string): { begin: string; end: string } {
  // The machine-readable block keeps its historical marker: packages/web's
  // voice-examples.catalog.test.ts and the API contract test parse it.
  const label = name === 'voice-action-catalog' ? 'machine-readable' : 'generated';
  return { begin: `<!-- BEGIN ${label}: ${name} -->`, end: `<!-- END ${label}: ${name} -->` };
}

/**
 * Replace the content between each block's BEGIN/END markers. Prose outside
 * the markers is untouched. A block the renderer produces whose markers are
 * missing is an error — deleting a marker must not silently stop generation.
 */
export function applyGeneratedBlocks(doc: string, blocks: ReadonlyMap<string, string>): string {
  let out = doc;
  for (const [name, content] of blocks) {
    const { begin, end } = markersFor(name);
    const b = out.indexOf(begin);
    const e = out.indexOf(end);
    if (b < 0 || e < 0 || e < b) {
      throw new Error(`voice-action-catalog: markers for generated block '${name}' not found`);
    }
    out = `${out.slice(0, b + begin.length)}\n${content}\n${out.slice(e)}`;
  }
  return out;
}

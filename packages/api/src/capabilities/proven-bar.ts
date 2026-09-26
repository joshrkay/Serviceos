/**
 * #841 — the proven bar, as a gate over the capability declarations.
 *
 * "Proven" (CONTEXT.md, D-031) means a real-database integration test. The bar
 * applies to every capability that WRITES: every `proposal` capability (proven
 * by its proposal type's execution — an alias intent rides its target's
 * handler, so it rides its proof too) and every `direct_act` (proven by its
 * intent). Lookups are read-only and are not gated here.
 *
 * WHERE PROOF COMES FROM. Not from the declaration — an asserted proof is a
 * prediction (D-031 rule 1), and the catalog's hand-kept "Persistence proof"
 * column went stale in both directions. Proof is DERIVED: an integration test
 * claims it by putting `provesExecution('<key>')` in a test title, and the
 * scanner credits the claim only when that file opens a real pool (D-031 rule
 * 2: directory location is not evidence). The claim is thus reviewed where the
 * test is written, and it disappears with the test.
 *
 * The gate itself is `test/capabilities/proven-bar.test.ts`, which runs in
 * the ordinary unit suite (no Docker) — a new capability that ships without a
 * tagged real-database test fails CI there.
 *
 * The scanner is lexical, like every §11.0e falsifier: it proves a tagged file
 * opens a pool and names the key, not that each assertion is sound. The tag is
 * what makes that acceptable — it is an explicit, per-file claim a reviewer
 * reads, not a keyword the scanner guesses at.
 */
import * as fs from 'fs';
import * as path from 'path';

import type { CapabilityDeclaration } from './capabilities';

/** The key a proof is recorded against: a proposal type, or a direct act's intent. */
export type ProofKey = string;

/**
 * The tag. Prefix a real-database test's `describe`/`it` title with it:
 *
 *   describe(provesExecution('record_payment') + 'Postgres integration — …', …)
 */
export function provesExecution(...keys: ProofKey[]): string {
  return `[proves execution: ${keys.join(', ')}] `;
}

/**
 * The grandfather register (#841: "grandfather with an explicit register").
 * Writing capabilities with NO real-database execution test as of 2026-09-26 —
 * in-memory proof at best (mark_lead_lost and add_service_location have no
 * execution test of any kind). It only shrinks: the gate fails when a member
 * gains a proof until it is removed, and its exact contents are pinned by the
 * gate test, so growing it is a visible edit in two places.
 */
export const KNOWN_PROOF_GAPS: ReadonlySet<string> = new Set([
  'batch_invoice',
  'convert_lead',
  'mark_lead_lost',
  'add_service_location',
  'create_standing_instruction',
  'send_customer_message',
  'create_service_agreement',
  'add_catalog_item',
]);

/** The proof key of a writing capability; undefined for everything the bar does not cover. */
export function proofKeyOf(cap: CapabilityDeclaration, intent?: string): ProofKey | undefined {
  if (cap.kind === 'proposal') return cap.proposalType;
  if (cap.kind === 'direct_act') return intent;
  return undefined;
}

export interface ExecutionProofScan {
  /** proof key → the files (basename, sorted) that prove it. */
  readonly proofs: ReadonlyMap<ProofKey, readonly string[]>;
  /** Files that carry a tag but never open a database — refused, and a gate failure. */
  readonly tagsWithoutDatabase: readonly string[];
}

/** The same "opens a real pool" regex PRD §11.0e publishes for the suite census. */
const OPENS_REAL_POOL = /getSharedTestDb|TEST_DB_URL|new Pool\(|withTestDb|testDb/;
const TAG_CALL = /provesExecution\(([^)]*)\)/g;
const STRING_LITERAL = /['"]([a-z_]+)['"]/g;

export function scanExecutionProofs(
  dir: string,
  options: { suffix?: string } = {},
): ExecutionProofScan {
  const suffix = options.suffix ?? '.test.ts';
  const proofs = new Map<ProofKey, string[]>();
  const tagsWithoutDatabase: string[] = [];
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(suffix))
    .sort();
  for (const file of files) {
    const source = fs.readFileSync(path.join(dir, file), 'utf8');
    const keys = new Set<string>();
    for (const call of source.matchAll(TAG_CALL)) {
      for (const lit of call[1].matchAll(STRING_LITERAL)) keys.add(lit[1]);
    }
    if (keys.size === 0) continue;
    if (!OPENS_REAL_POOL.test(source)) {
      tagsWithoutDatabase.push(file);
      continue;
    }
    for (const key of keys) {
      const list = proofs.get(key) ?? [];
      list.push(file);
      proofs.set(key, list);
    }
  }
  return { proofs, tagsWithoutDatabase };
}

export interface ProvenBarVerdict {
  /** Writing capabilities with no proof and no register entry — the gate. */
  readonly unproven: string[];
  /** Register entries that are now proven — remove them (the ratchet). */
  readonly staleGrandfathered: string[];
  /** Register entries that name no declared writing capability. */
  readonly strayGrandfathered: string[];
  /** Tagged keys no declared writing capability uses (typos, deleted capabilities). */
  readonly unknownTags: string[];
}

export function evaluateProvenBar(
  capabilities: Readonly<Record<string, CapabilityDeclaration>>,
  scan: ExecutionProofScan,
  grandfathered: ReadonlySet<string>,
): ProvenBarVerdict {
  const unproven: string[] = [];
  const staleGrandfathered: string[] = [];
  const writing = new Set<string>();
  const usedKeys = new Set<ProofKey>();
  for (const [intent, cap] of Object.entries(capabilities)) {
    const key = proofKeyOf(cap, intent);
    if (key === undefined) continue;
    writing.add(intent);
    usedKeys.add(key);
    const proven = scan.proofs.has(key);
    if (!proven && !grandfathered.has(intent)) unproven.push(intent);
    if (proven && grandfathered.has(intent)) staleGrandfathered.push(intent);
  }
  const strayGrandfathered = [...grandfathered].filter((i) => !writing.has(i));
  const unknownTags = [...scan.proofs.keys()].filter((k) => !usedKeys.has(k));
  return {
    unproven: unproven.sort(),
    staleGrandfathered: staleGrandfathered.sort(),
    strayGrandfathered: strayGrandfathered.sort(),
    unknownTags: unknownTags.sort(),
  };
}

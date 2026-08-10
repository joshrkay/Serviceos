/**
 * Fail fast when any voice-quality cassette has no recorded entries.
 * Used before/after cassette refresh to list scripts still needing record.
 * A documented pre-launch gate — see
 * docs/launch/2026-06-03-rivet-launch-day-runbook.md and
 * docs/superpowers/runbooks/solo-owner-public-launch.md.
 *
 * Usage: npm run voice-quality:check-cassettes
 *
 * ── ZERO-LLM-CALL SCRIPTS (review follow-up K1, 2026-08-09) ───────────────
 *
 * This check used to be purely FILE-driven: it walked the cassettes
 * directory and failed any non-layer2 cassette whose `entries` array was
 * empty. That has two blind spots, and commit 0b60e9d5c walked into both at
 * once when `--prune` reduced `es-emergency-escalation.json` to zero
 * entries:
 *
 *   - A script can legitimately issue ZERO LLM calls. `es-emergency-
 *     escalation` is one: the Spanish gas-leak utterance trips the safety
 *     tier, which escalates without ever classifying. Its cassette had 27
 *     accreted entries from older taxonomies and not one live one, so a
 *     correct prune emptied it — semantically right, but this gate read it
 *     as "needs recording" and went red. (Verified: the corpus replay suite
 *     is 73/73 with that cassette gone.)
 *   - Conversely, a file-driven walk cannot see a script whose cassette is
 *     MISSING ENTIRELY. Deleting a file made this gate stop covering that
 *     script rather than start covering it correctly.
 *
 * So the check is now CORPUS-driven as well as file-driven. Every non-
 * layer2 corpus script must have a cassette with at least one entry, unless
 * it is declared below — and a declared script must have NO cassette file
 * at all, so the declaration can never silently go stale in either
 * direction. An empty cassette file is never the right artifact: a script
 * that records nothing should have no file.
 */
import * as fs from 'fs';
import * as path from 'path';
import { loadCorpus, loadLayer2Corpus } from '../src/ai/voice-quality/corpus/loader';

const CASSETTES_DIR = path.resolve(
  __dirname,
  '../src/ai/voice-quality/corpus/cassettes',
);

/**
 * Corpus scripts that reach a terminal answer WITHOUT issuing a single LLM
 * call, and therefore correctly have no cassette file.
 *
 * Adding an id here is a claim that must stay true, and the check enforces
 * it both ways: a declared script that starts issuing calls will record a
 * cassette on the next refresh, and this gate then fails telling you to
 * remove it from the list. Do not add an id to silence a red gate — a
 * cassette that went empty for any OTHER reason means the refresh failed to
 * reproduce calls that are still live, which the corpus replay suite will
 * also report as drift.
 */
const ZERO_LLM_CALL_SCRIPT_IDS = new Set<string>([
  // Safety tiering escalates the "fuga de gas" turn before any classify
  // call is made (src/ai/voice-quality/corpus/scripts/11-spanish/
  // es-emergency-escalation.json — a single turn, expecting the 911 line).
  'es-emergency-escalation',
]);

interface CassetteFile {
  scriptId?: string;
  entries?: unknown[];
}

function main(): void {
  if (!fs.existsSync(CASSETTES_DIR)) {
    console.error(`Cassettes directory not found: ${CASSETTES_DIR}`);
    process.exit(1);
  }

  let files: string[];
  try {
    files = fs
      .readdirSync(CASSETTES_DIR)
      .filter((f) => f.endsWith('.json'))
      .sort();
  } catch (err) {
    console.error(`Failed to read cassettes directory: ${CASSETTES_DIR}`);
    console.error(err);
    process.exit(1);
  }

  if (files.length === 0) {
    console.error(`No cassette JSON files found in ${CASSETTES_DIR}`);
    process.exit(1);
  }

  const corpus = loadCorpus();
  const layer1ScriptIds = corpus.filter((s) => !s.layer2Only).map((s) => s.id);
  const layer1Ids = new Set(layer1ScriptIds);
  // A Layer 2 id that is ALSO a Layer 1 corpus script (38 of the 40 are)
  // still needs a Layer 1 cassette — only ids that exist *nowhere* in the
  // Layer 1 corpus are exempt from the empty-cassette rule.
  const layer2OnlyIds = new Set(
    [
      ...loadLayer2Corpus().map((s) => s.id),
      ...corpus.filter((s) => s.layer2Only).map((s) => s.id),
    ].filter((id) => !layer1Ids.has(id)),
  );

  const needingRecord: string[] = [];
  /** Declared zero-call, yet a cassette file exists — the declaration is stale. */
  const staleDeclarations: string[] = [];
  const withEntries = new Set<string>();

  for (const file of files) {
    const filePath = path.join(CASSETTES_DIR, file);
    let parsed: CassetteFile;
    try {
      parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as CassetteFile;
    } catch (err) {
      console.error(`Invalid JSON: ${filePath}`);
      console.error(err);
      process.exit(1);
    }

    const scriptId =
      typeof parsed.scriptId === 'string'
        ? parsed.scriptId
        : path.basename(file, '.json');

    if (ZERO_LLM_CALL_SCRIPT_IDS.has(scriptId)) {
      staleDeclarations.push(scriptId);
      continue;
    }

    const entries = parsed.entries;
    if (Array.isArray(entries) && entries.length > 0) {
      withEntries.add(scriptId);
    } else if (!layer2OnlyIds.has(scriptId)) {
      needingRecord.push(scriptId);
    }
  }

  // Corpus-driven half: a script with no cassette file at all used to be
  // invisible here.
  const missing = layer1ScriptIds.filter(
    (id) => !withEntries.has(id) && !needingRecord.includes(id) && !ZERO_LLM_CALL_SCRIPT_IDS.has(id),
  );

  let failed = false;

  if (needingRecord.length > 0 || missing.length > 0) {
    const all = [...new Set([...needingRecord, ...missing])].sort();
    console.error(
      `Voice quality cassettes incomplete (${all.length}/${layer1ScriptIds.length} need recording):`,
    );
    for (const id of all) {
      console.error(`  - ${id}`);
    }
    console.error('Run `npm run voice-quality:refresh` (or :record) to record them.');
    failed = true;
  }

  if (staleDeclarations.length > 0) {
    console.error(
      `Cassette files exist for ${staleDeclarations.length} script(s) declared zero-LLM-call ` +
        'in ZERO_LLM_CALL_SCRIPT_IDS (scripts/check-voice-quality-cassettes.ts):',
    );
    for (const id of staleDeclarations) {
      console.error(`  - ${id}`);
    }
    console.error(
      'Either the script now issues LLM calls (remove it from that list), or an empty ' +
        'cassette file was committed by mistake (delete the file).',
    );
    failed = true;
  }

  if (failed) {
    process.exit(1);
  }

  console.log(
    `All ${layer1ScriptIds.length} Layer 1 corpus scripts have recorded cassettes ` +
      `(${ZERO_LLM_CALL_SCRIPT_IDS.size} declared zero-LLM-call, ${files.length} cassette files on disk).`,
  );
}

main();

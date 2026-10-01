/**
 * VQ-008 — Corpus loader.
 *
 * Walks `corpus/scripts/<bucket>/*.json`, parses each file through
 * `VoiceQualityScriptSchema`, and returns a sorted (by `id`) array of
 * scripts. Invalid files surface as an aggregated error so authors
 * see every malformed file in a single run rather than fixing them
 * one at a time.
 *
 * Default corpus root is the sibling `scripts/` directory next to this
 * file. Tests override the root with a temp directory so they don't
 * depend on the real corpus existing yet (Phase-2 stories author it).
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  VoiceQualityScriptSchema,
  type VoiceQualityScript,
} from '../schema';

/**
 * Default scripts directory. Co-located so importing `loadCorpus()`
 * with no args produces the canonical Layer-1 corpus.
 */
export function defaultCorpusRoot(): string {
  return path.resolve(__dirname, 'scripts');
}

/**
 * Walk every bucket subdirectory under `corpusRoot`, parse every
 * `*.json` file in each, and return the validated scripts sorted by
 * id.
 *
 * If any file fails to parse (either invalid JSON or schema
 * mismatch), we collect every failure and throw a single aggregated
 * error containing all of them. Authors fixing a corpus see every
 * problem in one pass.
 */
export function loadCorpus(corpusRoot?: string): VoiceQualityScript[] {
  const root = corpusRoot ?? defaultCorpusRoot();
  if (!fs.existsSync(root)) {
    return [];
  }

  const failures: { file: string; reason: string }[] = [];
  const scripts: VoiceQualityScript[] = [];

  // Walk top-level entries — each subdir is a bucket. Non-directory
  // entries are ignored (the corpus may contain a README or .gitkeep
  // alongside the buckets).
  const buckets = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => path.join(root, d.name));

  for (const bucket of buckets) {
    const files = fs
      .readdirSync(bucket, { withFileTypes: true })
      .filter((f) => f.isFile() && f.name.endsWith('.json'))
      .map((f) => path.join(bucket, f.name));

    for (const file of files) {
      try {
        scripts.push(loadScript(file));
      } catch (err) {
        failures.push({
          file,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  if (failures.length > 0) {
    const summary = failures
      .map((f) => `  ${f.file}: ${f.reason}`)
      .join('\n');
    throw new Error(
      `loadCorpus: ${failures.length} script file(s) failed validation:\n${summary}`,
    );
  }

  scripts.sort((a, b) => a.id.localeCompare(b.id));
  return scripts;
}

/**
 * VQ2-014 — Layer 2 corpus loader. Returns the subset of `loadCorpus()`
 * where `layer2Eligible === true`. Layer-2-only scripts (those with
 * `layer2Only: true`) are included here even though Layer 1 skips them,
 * so the Layer 2 runner exercises the full audio-only corpus.
 */
export function loadLayer2Corpus(corpusRoot?: string): VoiceQualityScript[] {
  return loadCorpus(corpusRoot).filter((s) => s.layer2Eligible).map(asLayer2Persona);
}

/**
 * #1331 — Layer 2's view of a corpus script: the production phone surface.
 * (1) Owner line (D-028 follow-up, owner decision 2026-10-01) — a script that asks
 * operator-only actions declares `fixtures.tenant.harnessOperatorTaxonomy`.
 * Layer 1 classifies it on the operator taxonomy; Layer 2 drives the
 * production processor, which correctly refuses operator actions on a
 * customer's line (S1). On Layer 2 the script therefore runs as the OWNER
 * line (`callerIsOwner` → RV-070 ownerSession, S2 surface) — the real
 * production surface for an owner asking these actions by phone. Drafting
 * needs no voice PIN; the PIN gates owner APPROVAL of money movement.
 * (2) Every write turn answers the phone readback — see `answerPhoneReadback`.
 * Layer 1 (`loadCorpus`) is unchanged.
 */
function asLayer2Persona(script: VoiceQualityScript): VoiceQualityScript {
  const tenant = (script.fixtures.tenant ?? {}) as Record<string, unknown>;
  const owner = tenant.harnessOperatorTaxonomy === true;
  return {
    ...script,
    ...(owner ? { callerIsOwner: true } : {}),
    turns: script.turns.flatMap(answerPhoneReadback),
  };
}

/** The caller's answer to the phone engine's yes/no readback. */
const READBACK_YES = "Yes, that's right.";

/**
 * #1331 — the phone turn engine (media streams → voice-turn processor) never
 * drafts a write on the request turn: it reads the request back ("Just to
 * confirm — … Is that right?") and drafts only on the caller's yes. The
 * corpus encodes Layer 1's text-mode contract (drafted on the request turn),
 * so on Layer 2 the caller answers the readback. The request turn keeps the
 * intent / proposal / slot expectations (the drafted proposal is still that
 * turn's proposal); the drafted-reply copy and any hangup move to the answer.
 */
function answerPhoneReadback(
  turn: VoiceQualityScript['turns'][number],
): VoiceQualityScript['turns'] {
  if (turn.expected.proposalType === undefined) return [turn];
  const { spokenAnswerMatches, ...requestExpected } = turn.expected;
  return [
    { ...turn, expected: requestExpected, hangupAfter: false },
    {
      caller: READBACK_YES,
      expected: spokenAnswerMatches !== undefined ? { spokenAnswerMatches } : {},
      hangupAfter: turn.hangupAfter,
    },
  ];
}

/**
 * Load and validate a single script file. Throws on filesystem
 * errors, malformed JSON, or schema validation errors. Each error
 * carries the file path so call-sites (and CLI tooling) can produce
 * actionable messages.
 */
export function loadScript(scriptPath: string): VoiceQualityScript {
  const raw = fs.readFileSync(scriptPath, 'utf-8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `loadScript: invalid JSON in ${scriptPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const result = VoiceQualityScriptSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `loadScript: schema validation failed for ${scriptPath}: ${result.error.message}`,
    );
  }
  return result.data;
}

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

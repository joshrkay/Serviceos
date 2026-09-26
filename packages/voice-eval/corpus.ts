/**
 * corpus.ts — the golden-set loaders shared by the eval runners, the CI
 * cost-cap contract test and the baseline gate.
 *
 * Kept free of any api `src` value import so the offline path (and the
 * offline unit tests that import this module across the package boundary)
 * stay zero-dependency.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stableHash } from './metrics';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const UTTERANCES_PATH = resolve(__dirname, '../../data/corpus/utterances.jsonl');
export const TRANSCRIPTS_DIR = resolve(__dirname, '../../data/fixtures/transcripts');

/** Held-out fraction of the utterance corpus (deterministic, by stable hash). */
export const TEST_FRACTION = 0.20;

export interface IntentGoldRow { utterance: string; intent: string }

// The corpus jsonl carries the utterance under `text` (current schema) or
// `utterance` (older rows) — normalize to a canonical `{ utterance, intent }`.
interface RawRow { text?: string; utterance?: string; intent?: string }

/** The intent eval's held-out split: 20% of the corpus by stable hash. */
export function loadIntentTestSplit(path: string = UTTERANCES_PATH): IntentGoldRow[] {
  const rows = readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as RawRow)
    .map((r): IntentGoldRow => ({ utterance: r.text ?? r.utterance ?? '', intent: r.intent ?? '' }))
    .filter((r) => r.utterance !== '' && r.intent !== '');
  return rows.filter((r) => stableHash(r.utterance) < TEST_FRACTION);
}

export interface Transcript {
  transcript: string;
  service_type?: string;
  expected_entities?: Record<string, string>;
}

/** Every transcript fixture — the slot eval's gold set. */
export function loadSlotTranscripts(dir: string = TRANSCRIPTS_DIR): Transcript[] {
  return readdirSync(dir)
    .filter((x) => x.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as Transcript);
}

/**
 * corpus-lib.ts — shared helpers for the utterance corpus tooling.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(__dirname, '../..');
export const BEHAVIORS_PATH = resolve(ROOT, 'data/behaviors.yaml');
export const UTTERANCES_PATH = resolve(ROOT, 'data/corpus/utterances.jsonl');

export const CRITICAL_SLOTS = ['name', 'address', 'service_type', 'time_window', 'problem_description'] as const;

export type Source = 'curated' | 'template_augmented';

export interface UtteranceRow {
  utterance: string;
  intent: string;
  slots: Record<string, string>;
  source: Source;
  confidence: number;
  reviewed_by_human: boolean;
}

export interface Behavior {
  id: string;
  category: string;
  description: string;
  critical_slots: string[];
  min_examples: number;
}

export function loadBehaviors(): Behavior[] {
  const doc = parse(readFileSync(BEHAVIORS_PATH, 'utf8')) as { behaviors: Behavior[] };
  return doc.behaviors;
}

export function behaviorIds(): Set<string> {
  return new Set(loadBehaviors().map((b) => b.id));
}

/** Normalize for EXACT/near dedup keys: lowercase, strip punctuation, collapse ws. */
export function normalizeUtterance(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

export function readJsonl(path: string): UtteranceRow[] {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  return raw.split('\n').filter((l) => l.trim().length).map((l) => JSON.parse(l) as UtteranceRow);
}

export function toJsonl(rows: UtteranceRow[]): string {
  return rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
}

/**
 * Shared helpers for the ServiceOS voice-corpus data pipeline.
 * Pure, dependency-free (Node stdlib only) so `tsc` + `tsx` run anywhere.
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export const REPO_ROOT = join(__dirname, '..', '..');
export const CORPUS_DIR = join(REPO_ROOT, 'data', 'corpus');
export const SEEDS_DIR = join(CORPUS_DIR, 'seeds');

/** Deterministic PRNG (mulberry32). Same seed => same corpus, forever. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a 32-bit hash, used for stable id-based train/test splits. */
export function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Normalize an utterance for dedup / matching (lowercase, strip punctuation, collapse ws). */
export function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9ñ ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

export function readJsonl<T>(path: string): T[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as T);
}

export function writeJsonl(path: string, rows: ReadonlyArray<unknown>): void {
  writeFileSync(path, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}

export function listJsonl(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => join(dir, f));
}

/** Pick a deterministic element from arr using the supplied rng. */
export function pick<T>(arr: readonly T[], rng: () => number): T {
  return arr[Math.floor(rng() * arr.length)] as T;
}

/** Capitalize the first alphabetic character of a string. */
export function capFirst(s: string): string {
  return s.replace(/^(\s*)([a-zñáéíóú])/u, (_m, ws: string, c: string) => ws + c.toUpperCase());
}

/** Lowercase the first alphabetic character (for prepending a discourse marker). */
export function lowerFirst(s: string): string {
  return s.replace(/^(\s*)([A-ZÑÁÉÍÓÚ])/u, (_m, ws: string, c: string) => ws + c.toLowerCase());
}

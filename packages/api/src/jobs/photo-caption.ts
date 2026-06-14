/**
 * Parse the free-text caption a tech texts with a job photo into a
 * category + an optional job reference. Pure and deterministic.
 *
 *   "Henderson before"        → { category: 'before', jobReference: 'Henderson' }
 *   "after photo, Miller job" → { category: 'after',  jobReference: 'Miller job' }
 *   "the broken valve"        → { category: 'problem', jobReference: 'the broken valve' }
 *   ""                        → { category: 'other' }
 *
 * The job reference (when present) is the caption with the category cue
 * words removed; the inbound handler resolves it against the tech's jobs
 * (falling back to their single active job when no reference is given).
 */
import { JobPhotoCategory } from './job-photo';

// Cue word → category. Order matters only for the regex alternation; a
// caption is scanned for any cue and the FIRST category whose cue appears
// wins (checked in this priority order).
const CATEGORY_CUES: Array<{ category: JobPhotoCategory; words: string[] }> = [
  { category: 'before', words: ['before'] },
  { category: 'after', words: ['after'] },
  { category: 'completion', words: ['completion', 'complete', 'completed', 'done', 'finished'] },
  { category: 'problem', words: ['problem', 'issue', 'broken', 'damage', 'damaged', 'leak', 'fault'] },
];

const CUE_WORD_SET = new Set(CATEGORY_CUES.flatMap((c) => c.words));
// Filler words that are never part of a job reference.
const FILLER = new Set(['photo', 'photos', 'pic', 'pics', 'picture', 'pictures', 'the', 'a', 'of', 'job', 'image']);

export interface ParsedPhotoCaption {
  category: JobPhotoCategory;
  jobReference?: string;
}

export function parsePhotoCaption(body: string | undefined): ParsedPhotoCaption {
  const raw = (body ?? '').trim();
  if (raw.length === 0) return { category: 'other' };

  const lower = raw.toLowerCase();
  let category: JobPhotoCategory = 'other';
  for (const { category: cat, words } of CATEGORY_CUES) {
    if (words.some((w) => new RegExp(`\\b${w}\\b`).test(lower))) {
      category = cat;
      break;
    }
  }

  // Build the job reference: drop cue words and fillers, keep the rest in
  // original order/casing. "Henderson before photo" → "Henderson".
  const refTokens = raw
    .split(/\s+/)
    .map((tok) => tok.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '')) // trim edge punctuation
    .filter((tok) => {
      const norm = tok.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (!norm) return false;
      return !CUE_WORD_SET.has(norm) && !FILLER.has(norm);
    });
  const jobReference = refTokens.join(' ').trim();

  return jobReference.length > 0 ? { category, jobReference } : { category };
}

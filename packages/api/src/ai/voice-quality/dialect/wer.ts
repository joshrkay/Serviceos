/**
 * Dialect eval — Word Error Rate (WER).
 *
 * WER is the canonical ASR-accuracy metric: the word-level edit distance
 * between a ground-truth REFERENCE transcript and the ASR HYPOTHESIS,
 * normalized by reference length. It is the primary "did we actually
 * understand the speech?" signal for the dialect/accent eval — a per-dialect
 * WER tells you where transcription breaks down across the accents you
 * actually receive (Southern US, AAVE, Indian/Caribbean English,
 * Hispanic-accented English, …).
 *
 *   WER = (S + D + I) / N_ref
 *
 * where S / D / I are word substitutions / deletions / insertions from the
 * minimal-edit alignment and N_ref is the reference word count.
 *
 * Pure + dependency-free so it grades cassette playback or live Whisper
 * output interchangeably (same contract as `audio/audio-timings.ts`). The
 * real-audio runner that feeds Whisper output in here lands with the dialect
 * fixtures; this module is the metric core it will call.
 */

export interface WerResult {
  /** (S + D + I) / referenceWords. 0 = perfect; can exceed 1 (many insertions). */
  wer: number;
  substitutions: number;
  deletions: number;
  insertions: number;
  /** Correctly-aligned words (the "hits"). */
  hits: number;
  /** Word count of the normalized reference. */
  referenceWords: number;
}

/**
 * Normalize text for word-level comparison: lowercase, fold diacritics,
 * turn punctuation into spaces (keeping intra-word apostrophes so "don't"
 * stays one token), collapse whitespace, split on spaces. Empty/whitespace
 * input → `[]`.
 */
export function normalizeForWer(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[‘’]/g, "'") // curly apostrophes → straight (Whisper emits curly)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip combining diacritics (accent fold)
    .replace(/[^a-z0-9'\s]/g, ' ') // punctuation → space (keep apostrophe)
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter((w) => w.length > 0);
}

/**
 * Compute WER between a reference and a hypothesis string.
 *
 * Empty-reference conventions:
 *   - ref empty + hyp empty → WER 0 (nothing to get wrong).
 *   - ref empty + hyp non-empty → WER 1 (every hyp word is a spurious
 *     insertion; the count is reported in `insertions`, but `wer` is clamped
 *     to 1 so an empty-reference case can't dominate an average).
 */
export function wordErrorRate(reference: string, hypothesis: string): WerResult {
  return werFromTokens(normalizeForWer(reference), normalizeForWer(hypothesis));
}

/** WER over already-tokenized word arrays (exposed for callers that pre-tokenize). */
export function werFromTokens(
  ref: ReadonlyArray<string>,
  hyp: ReadonlyArray<string>,
): WerResult {
  const n = ref.length;
  const m = hyp.length;

  if (n === 0) {
    return {
      wer: m === 0 ? 0 : 1,
      substitutions: 0,
      deletions: 0,
      insertions: m,
      hits: 0,
      referenceWords: 0,
    };
  }

  // Edit-distance DP. dp[i][j] = min edits aligning ref[0..i) with hyp[0..j).
  const dp: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0),
  );
  for (let i = 0; i <= n; i++) dp[i][0] = i; // delete all ref words
  for (let j = 0; j <= m; j++) dp[0][j] = j; // insert all hyp words

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (ref[i - 1] === hyp[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = Math.min(
          dp[i - 1][j - 1] + 1, // substitution
          dp[i - 1][j] + 1, // deletion
          dp[i][j - 1] + 1, // insertion
        );
      }
    }
  }

  // Backtrace to split the edit distance into S / D / I (diagonal-first, the
  // standard preference). The S/D/I split can vary on ties, but S+D+I always
  // equals the edit distance, so `wer` is stable regardless.
  let i = n;
  let j = m;
  let substitutions = 0;
  let deletions = 0;
  let insertions = 0;
  let hits = 0;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && ref[i - 1] === hyp[j - 1] && dp[i][j] === dp[i - 1][j - 1]) {
      hits++;
      i--;
      j--;
    } else if (i > 0 && j > 0 && dp[i][j] === dp[i - 1][j - 1] + 1) {
      substitutions++;
      i--;
      j--;
    } else if (i > 0 && dp[i][j] === dp[i - 1][j] + 1) {
      deletions++;
      i--;
    } else {
      insertions++;
      j--;
    }
  }

  return {
    wer: (substitutions + deletions + insertions) / n,
    substitutions,
    deletions,
    insertions,
    hits,
    referenceWords: n,
  };
}

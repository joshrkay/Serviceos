/**
 * local-embed.ts — dependency-free, fully-offline text vectorizer used for
 * near-duplicate detection (the goal's "cosine sim > 0.95" rule) WITHOUT any
 * network/OpenAI dependency.
 *
 * It builds a character n-gram (3-gram) term-frequency vector per string and
 * compares with cosine similarity. This is deterministic and good enough to
 * catch near-duplicate utterances (paraphrases with tiny edits). The real
 * embedding path (text-embedding-3-small) is documented in
 * serviceos_training/embed_corpus.py and activates only when an API key exists.
 *
 * For honesty: this is an APPROXIMATE local stand-in, not a semantic embedding.
 * It catches surface-level near-dups; it is not claimed to be semantically
 * equivalent to text-embedding-3-large.
 */

export type SparseVec = Map<string, number>;

function ngrams(text: string, n = 3): string[] {
  const t = ` ${text.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim()} `;
  const grams: string[] = [];
  for (let i = 0; i + n <= t.length; i++) grams.push(t.slice(i, i + n));
  return grams;
}

export function vectorize(text: string, n = 3): SparseVec {
  const v: SparseVec = new Map();
  for (const g of ngrams(text, n)) v.set(g, (v.get(g) ?? 0) + 1);
  return v;
}

export function cosine(a: SparseVec, b: SparseVec): number {
  let dot = 0;
  const [small, large] = a.size < b.size ? [a, b] : [b, a];
  for (const [k, va] of small) {
    const vb = large.get(k);
    if (vb) dot += va * vb;
  }
  let na = 0;
  for (const va of a.values()) na += va * va;
  let nb = 0;
  for (const vb of b.values()) nb += vb * vb;
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function norm2(v: SparseVec): number {
  let s = 0;
  for (const x of v.values()) s += x * x;
  return Math.sqrt(s);
}

/**
 * Near-dup index. Returns true if `text` is a near-duplicate (cosine >
 * threshold) of anything already added.
 *
 * Comparison is GLOBAL across every stored vector — not bucketed by prefix.
 * A prefix bucket (e.g. first 4 normalized chars) produces false negatives:
 * adding an opener like "Hi, " to an otherwise identical utterance keeps
 * cosine > 0.95 yet lands the variant in a different bucket, so the pair is
 * never compared and the gate silently passes a corpus that violates the
 * near-duplicate invariant. Precomputed vector norms keep the O(n^2) scan
 * fast enough for the few-thousand-row corpus.
 */
export class NearDupIndex {
  private entries: { vec: SparseVec; norm: number }[] = [];
  constructor(private threshold = 0.95) {}

  isNearDup(text: string): boolean {
    const vec = vectorize(text);
    const vn = norm2(vec);
    if (vn === 0) return false;
    for (const e of this.entries) {
      if (e.norm === 0) continue;
      // dot product over the smaller map
      let dot = 0;
      const [small, large] = vec.size < e.vec.size ? [vec, e.vec] : [e.vec, vec];
      for (const [k, a] of small) {
        const b = large.get(k);
        if (b) dot += a * b;
      }
      if (dot / (vn * e.norm) > this.threshold) return true;
    }
    return false;
  }

  add(text: string): void {
    const vec = vectorize(text);
    this.entries.push({ vec, norm: norm2(vec) });
  }

  /** Convenience: returns true if added, false if rejected as near-dup. */
  addIfUnique(text: string): boolean {
    if (this.isNearDup(text)) return false;
    this.add(text);
    return true;
  }
}

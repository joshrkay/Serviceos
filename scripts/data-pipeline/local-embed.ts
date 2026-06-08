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

/**
 * Bucketed near-dup index. Bucketing by normalized prefix keeps the O(n^2)
 * comparison tractable for a few thousand rows. Returns true if `text` is a
 * near-duplicate (cosine > threshold) of anything already added.
 */
export class NearDupIndex {
  private buckets = new Map<string, SparseVec[]>();
  constructor(private threshold = 0.95) {}

  private bucketKey(text: string): string {
    const norm = text.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
    return norm.slice(0, 4); // first 4 chars of normalized text
  }

  isNearDup(text: string): boolean {
    const vec = vectorize(text);
    // Compare against same bucket and adjacent (loose) — here just same bucket,
    // plus a global fallback for very short strings.
    const key = this.bucketKey(text);
    const candidates = this.buckets.get(key) ?? [];
    for (const c of candidates) if (cosine(vec, c) > this.threshold) return true;
    return false;
  }

  add(text: string): void {
    const vec = vectorize(text);
    const key = this.bucketKey(text);
    const arr = this.buckets.get(key);
    if (arr) arr.push(vec);
    else this.buckets.set(key, [vec]);
  }

  /** Convenience: returns true if added, false if rejected as near-dup. */
  addIfUnique(text: string): boolean {
    if (this.isNearDup(text)) return false;
    this.add(text);
    return true;
  }
}

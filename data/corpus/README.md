# Intent Utterance Corpus

`utterances.jsonl` is the labeled training/eval corpus for the ServiceOS voice
agent. One JSON object per line.

## Schema

```jsonc
{
  "utterance": "Can I schedule a plumber for tomorrow morning? My sink is clogged.",
  "intent": "create_appointment",          // must be a behavior id in data/behaviors.yaml
  "slots": {                                  // string→string; critical slots: name,
    "service_type": "plumbing",               //   address, service_type, time_window,
    "time_window": "tomorrow morning",        //   problem_description
    "problem_description": "kitchen sink clogged"
  },
  "source": "curated",                       // curated | template_augmented | llm_paraphrase
  "confidence": 1.0,                          // label confidence in [0,1]
  "reviewed_by_human": true
}
```

Validated by `scripts/data-pipeline/validate-utterances.ts` (zod schema + all
corpus invariants).

## Provenance & the meaning of `reviewed_by_human`

This is important and stated plainly so the flag is never mistaken for something
it isn't:

- **`source: "curated"` / `reviewed_by_human: true`** — hand-authored and
  curated by the human-in-the-loop running this corpus pass. These reflect how
  real trades customers/operators speak (terse, rambling, regional, EN/ES
  code-switching). `reviewed_by_human: true` means **a human wrote/curated this
  row during the pass** — it is NOT a claim of independent third-party QA.
- **`source: "template_augmented"` / `reviewed_by_human: false`** —
  deterministically derived from curated seeds by
  `scripts/data-pipeline/generate-utterances.ts` (opener/closer variation,
  domain-synonym swaps, slot-value swaps). Clearly synthetic; never marked
  reviewed.
- **`source: "llm_paraphrase"`** — reserved for the credential-gated
  claude-sonnet-4-5 paraphrase path (see the comment block at the bottom of
  `generate-utterances.ts`). Not produced in the offline sandbox. When produced,
  ≥20% must be human-reviewed before entering the eval split.

## Invariants (enforced in CI by validate-utterances.ts)

- ≥ 3,000 rows total.
- Every behavior (all 41 intents) has ≥ 50 examples.
- `reviewed_by_human` share ≥ 20% of the corpus (backed by genuine curated rows).
- Schema valid on every row; `intent` ∈ `data/behaviors.yaml`.
- No exact (normalized) duplicates and no near-duplicates (offline cosine > 0.95).

## Append-only discipline

`utterances.jsonl` is append-only. Re-running `generate-utterances.ts`
regenerates the file deterministically from the curated seeds; to change an
existing label, edit the curated seed (`scripts/data-pipeline/curated-seed*.ts`)
and regenerate, or write a migration script — do not hand-edit emitted rows.

## Regenerate

```bash
npx tsx scripts/data-pipeline/generate-utterances.ts
npx tsx scripts/data-pipeline/validate-utterances.ts
```

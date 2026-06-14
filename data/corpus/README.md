# ServiceOS Voice Corpus (`data/corpus/`)

Launch-grade training/eval corpus for the inbound voice agent. Everything
here is **synthetic** (no PII, no scraped copyrighted text) and **reproducible**
from the seed files via the data pipeline.

## Layout

| File | What | Rows |
|------|------|------|
| `behaviors.yaml` | Intent/behavior taxonomy (source of truth, 35 behaviors) | — |
| `utterances.jsonl` | English intent utterances | 1,820 |
| `utterances_es.jsonl` | Spanish + code-switch utterances | 1,400 |
| `edge_cases.jsonl` | Accent / panic / noise / repair / wrong-number fixtures | 157 |
| `negatives.jsonl` | Telemarketer / employment / survey / kids (never book) | 62 |
| `slot_fixtures/{address,time,phone,service}.jsonl` | Slot-extraction gold | 178 |
| `seeds/` | Hand-authored templates + filler banks the generator expands | — |

## Regenerate

```bash
pnpm corpus:build        # generate utterances + build fixtures
pnpm test:corpus-schema  # schema + floors validate
pnpm test:dedup          # no exact dupes; near-dupes flagged
pnpm test:pii-leakage    # HARD STOP on any PII
```

## Evaluate

```bash
pnpm eval:full           # intent + slots + edge + negatives + spanish-gap
pnpm eval:edge-cases     # every edge category hits its expected_handling
pnpm eval:negatives      # zero booking-intent classifications
pnpm eval:spanish        # ES accuracy within 5pp of EN
```

Results land in `eval-results/<YYYY-MM-DD>/` (`metrics.json`, `confusion.csv`,
`failures.jsonl`). The 20% test split is frozen per-row by `fnv1a(id) % 5`, so
the held-out set never drifts and regressions are detectable.

## Editing rules (see repo `FORBIDDEN` policy)

- Never overwrite labeled rows in place — version files (`utterances.v2.jsonl`).
- No PII, ever. Phones must use a `555` block; addresses/names are synthetic.
- Synthetic rows are not promoted to "reviewed" without `reviewed_by_human=true`.
- New behaviors go through `TAXONOMY_GAPS.md` review before entering `behaviors.yaml`.

# PROGRESS — Voice Corpus & Comprehension Depth Pass

Status per feature. Binding goal = features 4–8; 1–3 / 9 addressed as scope allowed.

| # | Feature | Status | Delta |
|---|---------|--------|-------|
| 1 | 300+ multi-turn transcripts | DEFERRED | existing golden ~40; generator out of scope (see BLOCKED.md) |
| 2 | Intent utterance corpus | SHIPPED | +1,820 EN utterances across 35 intents |
| 3 | Domain vocabulary (1,500 terms) | DEFERRED | reused `corpus/data/vocabulary.json`; expansion is a separate pass |
| 4 | Edge-case fixture set | SHIPPED | +157 fixtures / 13 categories (≥10 each); `eval:edge-cases` 100% |
| 5 | Negative / rejection set | SHIPPED | +62 fixtures / 6 categories; 0 booking leaks; routing 1.0 |
| 6 | Slot extraction depth | SHIPPED | +178 slot fixtures; F1=1.0 each (target ≥0.88) |
| 7 | Spanish parity corpus | SHIPPED | +1,400 ES; min 40/intent (≥30); 102 code-switch (≥50) |
| 8 | Eval harness + held-out set | SHIPPED | `scripts/eval/run_eval.py` + `eval-results/`; frozen 20% split |
| 9 | Behavior taxonomy gap analysis | SHIPPED | `TAXONOMY_GAPS.md`; unknown 0% (synthetic); 7 candidate behaviors proposed |
| — | Reddit 50k+ acquisition | BLOCKED | no network in container (see BLOCKED.md) |

## Inventory delta (this pass)

- **+3,617 labeled examples** total: 1,820 EN + 1,400 ES utterances, 157 edge
  cases, 62 negatives, 178 slot fixtures.
- **+35-behavior taxonomy** (`data/corpus/behaviors.yaml`) aligned to the
  shared `ProposalType` enum and `VOICE_INBOUND_ASSISTANTS` registry.
- **+9 pipeline/eval modules** (3 TS builders, 3 TS validators, 3 Python eval).
- **+10 pnpm scripts** (`corpus:*`, `test:corpus-schema|dedup|pii-leakage`, `eval:*`).

## Gate status

```
pnpm typecheck          0   (api build + data-pipeline)
pnpm test:corpus-schema 0   (35 behaviors, all floors met)
pnpm test:dedup         0   (0 exact dupes; 145 near-dup pairs flagged)
pnpm test:pii-leakage   0   (8 files scanned, 0 PII)
pnpm eval:full          0   (acc 1.0, slot F1 1.0, unknown 0.0, ES gap 0.0)
pnpm eval:edge-cases    0   (all 13 categories pass)
pnpm eval:negatives     0   (0 booking leaks)
pnpm eval:spanish       0   (gap 0.0 ≤ 0.05)
```

# LAUNCH REPORT — Voice Corpus & Comprehension Depth Pass

Expanded the ServiceOS inbound-voice training/eval corpus from a thin set of
synthetic golden transcripts to a structured, reproducible, bilingual corpus
with edge-case, negative, and slot coverage, plus a frozen-holdout eval harness
with regression detection. Binding scope was **features 4–8**; all met.

## SHIPPED

| Item | Delta |
|------|------:|
| Behavior/intent taxonomy (`behaviors.yaml`) | 35 behaviors, enum-aligned |
| English utterances | +1,820 |
| Spanish utterances (incl. 102 code-switch) | +1,400 |
| Edge-case fixtures (13 categories) | +157 |
| Negative/rejection fixtures (6 categories) | +62 |
| Slot fixtures (address/time/phone/service) | +178 |
| Eval harness + frozen 20% split + `eval-results/` | new |
| Pipeline (generate/build/validate/dedup/PII) | 6 TS modules |
| pnpm gates | 10 scripts |
| **Total labeled examples** | **+3,617** |

## Final eval metrics (held-out 20%, frozen by `fnv1a(id)%5`)

| Metric | Value | Target |
|--------|------:|-------:|
| Intent accuracy | **1.000** | ≥ 0.92 |
| Unknown rate | **0.000** | < 0.10 |
| Per-intent F1 (min / max, n=35) | 1.0 / 1.0 | — |
| Slot F1 — address | **1.0** (n=9) | ≥ 0.88 |
| Slot F1 — time | **1.0** (n=8) | ≥ 0.88 |
| Slot F1 — phone | **1.0** (n=8) | ≥ 0.88 |
| Slot F1 — service | **1.0** (n=10) | ≥ 0.88 |
| Edge handling accuracy (all 13 cats pass) | **1.0** | all pass |
| Negative booking leaks | **0** | 0 |
| Negative routing accuracy | **1.0** | — |
| English accuracy | **1.0** | — |
| Spanish accuracy | **1.0** | — |
| Spanish↔English gap | **0.000** | ≤ 0.05 |

Confusion matrix: clean diagonal (`eval-results/<date>/confusion.csv`), zero
off-diagonal mass on the held-out split.

### Honest reading of the 1.0

These metrics measure a **transparent rule-based baseline over synthetic,
template-derived data** — the classifier and corpus were intentionally
co-designed. 1.0 means the harness is wired correctly and the corpus is
internally consistent; it is **not** a generalization estimate. The real value
delivered is: breadth of phrasings/edge conditions, Spanish parity, a frozen
holdout, and regression detection. The first action for v1.1 is to label a
held-out set of **real human transcripts** and re-run — that number is the one
to trust.

## Top failure modes to fix in v1.1

The held-out synthetic set has zero failures, so the ranked list below is the
**predicted** real-traffic failure surface, drawn from the hardest authored
fixtures and the structural limits of the rule-based baseline:

1. Disambiguation under real ASR noise for the estimate/invoice/payment cluster
   (`draft_estimate` vs `send_estimate` vs `lookup_estimates`; `draft_invoice`
   vs `lookup_invoices` vs `record_payment`) — currently separated by exact
   anchor phrases that ASR will mangle.
2. Code-switch utterances where the *verb* is English and the *object* Spanish
   (or vice-versa) outside the 102 authored patterns.
3. Multi-window time constraints ("after 3 but before pickup") — extractor keeps
   only the lower bound.
4. Landmark-only addresses ("the blue house next to the fire station") — captured
   verbatim for human geocoding, not resolved.
5. Heavy-accent emergencies vs. heavy-accent routine requests — the life-safety
   override is keyword-based and will both over- and under-trigger on real audio.
6. `complaint` vs `payment_dispute` vs `agent_handoff_request` — overlapping
   "angry caller" surface; all route to a human today, but the downstream
   summary differs.
7. Taxonomy gaps (warranty / parts-availability / appointment-ETA) — see
   `TAXONOMY_GAPS.md`; these land in `unknown` or a near-miss intent.

## DEFERRED

| Item | Reason | Est. |
|------|--------|------|
| 300+ multi-turn transcripts | Out of binding scope (single-utterance comprehension) | 1–2 d |
| Vocabulary expansion to 1,500 terms | Separate vocab-depth pass | 1 d |

## BLOCKED

| Item | Reason |
|------|--------|
| Reddit 50k+ acquisition | No network for the Academic Torrents dump in this container; pipeline exists & is tested. See `BLOCKED.md`. |

## Recommendation: corpus-depth vs. model-capability bottlenecks

Where more corpus **will** help (corpus-bound):
- **Negative/rejection robustness** and **edge-case routing** — these are
  pattern-coverage problems; every new real telemarketer/wrong-number/panic
  transcript directly improves precision. Highest ROI for more data.
- **Spanish + code-switch breadth** — the model can clearly handle ES (parity
  at 0.0 gap); the ceiling is *coverage* of regional phrasings, which only more
  native-sourced data fixes.
- **Slot surface forms** (address/time/phone phrasings) — bounded, enumerable;
  more fixtures keep raising real F1.

Where more corpus **won't** help (model-bound — don't over-invest in data):
- **Disambiguating near-synonym intents from a single noisy utterance** (the
  estimate/invoice/payment cluster). This needs *dialogue-state context* and a
  stronger model, not more single-utterance examples. The current rule baseline
  is the floor; replace `classify_intent` with the LLM gateway
  (`packages/api/src/ai/gateway`) and feed conversation state.
- **True acoustic edge cases** (accent, panic, background noise, multi-speaker)
  — these are decided in the **STT/ASR layer**, not the text classifier.
  Phonetic transcripts approximate them, but real gains require audio fixtures
  + ASR tuning, which is a model/pipeline investment, not a text-corpus one.

**Bottom line:** spend the next data dollar on negatives, accented/code-switch
audio, and Spanish regional breadth; spend the next *engineering* dollar on
wiring conversation-state context into intent classification, which the corpus
alone cannot unblock.

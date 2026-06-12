# BLOCKED

Items that could not complete in this environment, with diagnosis. Per the
checkpoint protocol, slot failure cases and hard blockers land here.

## Slot-extraction failure cases

None. All four slot types hit **F1 = 1.0** on the frozen 20% holdout
(target ≥ 0.88):

| Slot | Held-out N | F1 |
|------|-----------:|---:|
| address | 9 | 1.0 |
| time | 8 | 1.0 |
| phone | 8 | 1.0 |
| service | 10 | 1.0 |

Caveat: the extractors are rule-based and the fixtures were co-authored with
them, so 1.0 reflects coverage of the *authored* phrasings, not real-world
ASR noise. The first real failures to expect (documented for v1.1): landmark
addresses that need geocoding, multi-window time constraints ("after 3 but
before pickup" currently keeps only the lower bound), and 555-collision when
a real area code happens to be 555.

## BLOCKED — Reddit acquisition (50k+ posts target)

- **What:** Bulk homeowner-problem ingestion via the Academic Torrents Reddit
  dump (`serviceos_training/02_reddit_processor.py`).
- **Why blocked:** This pass ran in an isolated remote container whose network
  policy does not permit fetching the multi-GB torrent or reaching Reddit. The
  pipeline exists and is tested (`serviceos_training/tests/`) but cannot be run
  here.
- **Per protocol:** acquisition paused; continued with vocab + synthetic
  generation. Re-run `serviceos_training/02_reddit_processor.py` on a host with
  the dump mounted to populate the Supabase `training_corpus` table.

## DEFERRED (not blocked — out of scope for features 4–8)

- **300+ multi-turn transcripts:** the live golden corpus has ~40
  (`packages/api/src/ai/voice-quality/corpus/golden/`). A synthetic multi-turn
  transcript generator is a natural next step but was not required by the
  binding goal (single-utterance comprehension). Est. 1–2 days.
- **1,500+ vocabulary terms:** `corpus/data/vocabulary.json` already maps lay→
  technical terms by fixture; expanding to 1,500 entries is a separate
  vocab-depth pass. Est. 1 day.

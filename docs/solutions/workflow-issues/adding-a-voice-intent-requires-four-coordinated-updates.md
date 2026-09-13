---
title: "Adding a voice intent breaks four things at once — do them together"
date: 2026-07-29
track: chore
problem_type: workflow-issues
module: "packages/api/src/ai/orchestration/intent-classifier.ts"
tags: ["voice", "intent-classifier", "cassettes", "taxonomy", "ci", "coordinated-bump"]
related: ["docs/solutions/test-failures/voice-quality-cassette-drift-serves-stale-response.md"]
---

## Problem

Adding a single intent to `SUPPORTED_INTENTS` turns CI red in up to four places that look
unrelated to each other and unrelated to your change. During the rivet-voice-19 run this cost two
separate red CI rounds (`en_route`, then `update_brand_voice`) before the pattern was obvious —
and it will happen to the next person too, because nothing in the failure messages tells you the
four are one event.

The root cause is that the classifier's **system prompt is an input to three different hashes and
budgets**, and adding an intent changes that prompt.

## The four things, and why each breaks

1. **Every voice-quality cassette invalidates.** The cassette key is a sha256 over the FULL system
   prompt, so one changed byte invalidates the whole corpus — expect ~66 files red, not one.
   The failure text is `Cassettes are stale — run 'npm run voice-quality:refresh'`.
2. **`INTENT_TAXONOMY_VERSION` and its pin.** The repo enforces a coordinated bump; the version
   constant and the test that pins it (`test/ai/orchestration/intent-classifier.test.ts`, which
   also names the version in its `describe`/`it` titles) must move together.
3. **`EST_SYSTEM_PROMPT_TOKENS`** (`packages/voice-eval/live-support.ts`) is a cost-cap
   overestimate asserted with a 1.15 safety margin. A longer prompt overruns it. Raise the
   constant — never weaken the margin or the assertion; the constant is the thing that should move.
4. **The intent-map contract tests + the catalog doc.** `docs/reference/voice-action-catalog.md`
   is pinned against `INTENT_TO_PROPOSAL_TYPE`, the execution-handler registry,
   `actionClassForProposalType`, and `SUPPORTED_INTENTS`. A new intent must be classified there —
   including a **deliberately non-proposal** intent, which belongs in the documented non-proposal
   set the same way `lookup_*` is, so the drift test reads its absence from the map as intentional
   rather than as a gap.

## Fix (do all of it in the same commit)

```bash
cd packages/api
npm run voice-quality:refresh        # offline, deterministic, no API key, ~3s
git add src/ai/voice-quality/corpus/cassettes
```

Then bump `INTENT_TAXONOMY_VERSION` + its pin, raise `EST_SYSTEM_PROMPT_TOKENS` if the token test
fails, and update the catalog doc. Verify with:

```bash
npx tsc --project tsconfig.build.json --noEmit
npx vitest run
npm run test:voice-fixtures
```

## Traps

- **Do not** set `VOICE_QUALITY_ALLOW_CASSETTE_FALLBACK=1` to quiet the drift check. That
  re-introduces the documented silent-stale-response hazard (see `related`).
- A new proposal type additionally requires an entry in `TYPE_PRIORITY`
  (`packages/api/src/proposals/prioritization.ts`) and in `reports/time-credits.ts`, both typed as
  `Record<ProposalType, number>` — the compiler catches these, but only after the rest is done, so
  expect a second round if you stop at green tests.
- **`packages/shared` is a separate workspace and is easy to forget.** A new proposal type must be
  registered in `packages/shared/src/enums.ts` (`ProposalType`) *and* in the right lane in
  `packages/shared/src/contracts/proposal-action-class.ts`; parity tests there pin both against the
  API. Miss it and `proposalTypeSchema` rejects the type while the shared lane classifier returns
  `'unknown'`, which consumers are documented to fail closed on. `cd packages/api && npx vitest run`
  will NOT catch this — CI runs `npm run test --workspaces`. Run `cd packages/shared && npm run build
  && npx vitest run` too (the build matters: a stale `dist` makes the API typecheck fail on exports
  that do exist in source).
- If several people are adding intents concurrently, the cassette refresh is
  **last-writer-wins**: refresh again after the other change lands, or CI stays red on a hash that
  no longer matches anyone's prompt.

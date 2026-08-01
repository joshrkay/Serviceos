# fix: Caller silence handling on both voice transports (T2-F03, T2-F05)

**Created:** 2026-07-18
**Depth:** Standard
**Status:** plan

## Summary

A silent caller is currently hung up on (Gather mode) or stranded indefinitely (Media Streams mode). Gather's `<Gather>` verb omits `actionOnEmptyResult`, so Twilio's no-speech timeout falls through the TwiML document and disconnects instead of reaching the existing empty-`SpeechResult` reprompt branch; Media Streams has no per-turn silence timer at all — only a 30-minute idle teardown that never fires mid-call because Twilio streams silence frames continuously. This plan wires silence into the existing bounded reprompt/escalation ladders on both transports.

## Problem Frame

Discovery findings T2-F03 and T2-F05 (`discovery/02-voice-pipeline.md`). Affects every inbound caller who pauses (checking a calendar, talking to a spouse, thinking): on Gather the AI hangs up on them mid-call; on Media Streams the line sits in dead silence forever. Both are direct "never miss a call" promise-breakers.

## Requirements

- R1. Gather mode: a no-speech timeout re-enters the webhook loop (no silent hangup) and produces a reprompt.
- R2. Gather mode: consecutive silent turns are **bounded** — after the cap, the caller gets the existing graceful escalation line + hangup, not an infinite reprompt loop.
- R3. Media Streams mode: after an agent turn completes, if no caller transcript arrives within ~8s, the caller is reprompted via the existing recovery line; consecutive silences share the existing `MAX_CONSECUTIVE_LOW_CONFIDENCE_TURNS = 2` ladder and its escalation endpoint.
- R4. The Media Streams silence timer never fires while the caller is actually speaking (interim transcripts clear it) or while the agent is speaking.
- R5. No regression to existing Gather TwiML shape assertions (22 test files reference the Gather XML) or to the media-streams resilience suites.

## Key Technical Decisions

- **Gather: `actionOnEmptyResult="true"` rather than a trailing `<Redirect>`** — the empty-`SpeechResult` branch already exists at `packages/api/src/telephony/twilio-adapter.ts:1842-1855` and dispatches `confidence_low`; `actionOnEmptyResult` delivers the empty POST straight to it with a one-attribute change. The trailing-`<Redirect>` pattern (`routes/telephony.ts:966-982`) is equivalent but adds a second URL emission site to keep consistent. (Alternative rejected: nesting `<Say>` inside `<Gather>` like `buildCallbackGatherTwiml` — a bigger TwiML reshape than the fix needs, and prompts-before-gather is the established shape 22 test files pin.)
- **Gather: route empty-`SpeechResult` turns through the low-confidence streak ladder.** Today the empty branch (`:1842-1855`) early-returns **without** touching `lowConfidenceGatherStreak` (`:765`) — that cap is only applied to non-empty low-confidence turns via `maybeHandleLowSttConfidenceGather` (`:2170-2223`). With `actionOnEmptyResult` on, an unbounded silence→reprompt loop becomes reachable; the empty branch must increment the same streak and reuse the same at-cap escalation (`SPEECH_TURN_FAILURE_ESCALATION_COPY` + `end_session{reason:'low_stt_confidence_max_retries'}` + `finalizeTerminatedSession`). Sharing one streak (not a parallel silence counter) means mixed silence/mumble sequences also terminate at 2, matching Media Streams semantics.
- **Media Streams: a per-turn `silenceRepromptTimer` armed at agent-turn-end, expiring into `recoverFromLowSttConfidence`.** `recoverFromLowSttConfidence` (`mediastream-adapter.ts:1507-1537`) already implements reprompt copy, the `consecutiveLowConfidenceTurns` streak, the cap, and the graceful escalation — silence becomes just another way to enter it. (Alternative rejected: a separate silence ladder — duplicates copy/caps and lets a caller alternate silence and mumbling to stay on the line indefinitely.)
- **Arm/clear discipline mirrors `armIdleTimer`** (`:2443-2455`): store on state, clear-before-arm, `.unref()`, cleared in `handleClose` (`:2504-2507`). Arm when the end-of-turn mark `turn-${turnId}` is enqueued (`streamPcmAsMedia`, `:2381-2389`); clear on ANY transcript event (interim or final — `onTranscriptEvent` entry) and on barge-in; do not arm during the greeting bootstrap until the greeting's own turn-end mark fires (the greeting is a turn like any other, so this falls out naturally).
- **Timeout default 8s, dep-injectable** (`deps.silenceRepromptTimeoutMs ?? DEFAULT_SILENCE_REPROMPT_MS = 8_000`) — inside the requested 6-10s band; dep injection matches `audioIdleTimeoutMs` and keeps tests fast with `vi.useFakeTimers`.

## Scope Boundaries

**In scope:** the two transports' silence entry points into the existing ladders; tests pinning both.
**Non-goals:** changing ladder caps or escalation copy; DTMF keypad escape (T2-F16); barge-in threshold tuning (T2-F09); Gather-turn idempotency (T2-F08); latency work (T2-F02/F11).

### Deferred to follow-up work
- `speechTimeout="auto"` tuning and the `GATHER_LOCALE_*` vs `es-MX` locale inconsistency between the two TwiML builders (noticed, unrelated).

## Repository invariants touched

- **Human-approval gate / proposals:** untouched — silence handling only produces TTS reprompts and session termination through existing FSM side-effect paths.
- **Audit events:** at-cap termination reuses the existing `finalizeTerminatedSession` / `end_session` path, which already emits its session-outcome records (`low_stt_confidence_repeated`); silence entries record the same analytics events as low-confidence entries.
- **LLM gateway:** not touched; silence turns short-circuit before classification by design.
- Tenant/RLS, money, catalog: not touched.

## Implementation Units

### U1. Gather: `actionOnEmptyResult` + bounded empty-turn ladder
- **Goal:** silence re-enters the webhook and is capped like low confidence.
- **Requirements:** R1, R2, R5
- **Dependencies:** none
- **Files:** `packages/api/src/telephony/twilio-adapter.ts` (buildTwiML `:665-679`; empty-`SpeechResult` branch `:1842-1855`); tests in `packages/api/test/telephony/twilio-adapter.test.ts`
- **Approach:** add `actionOnEmptyResult="true"` to the `<Gather/>` attributes in `buildTwiML`. In the empty-`SpeechResult` branch, before dispatching `confidence_low`, run the same streak logic as `maybeHandleLowSttConfidenceGather`: increment `lowConfidenceGatherStreak`; at `MAX_CONSECUTIVE_LOW_CONFIDENCE_TURNS`, delete the streak and emit the escalation effects (`SPEECH_TURN_FAILURE_ESCALATION_COPY` + `end_session`) with `finalizeTerminatedSession` + `low_stt_confidence_repeated` analytics, exactly as `:2185-2207` does. Prefer extracting the at-cap effect construction into a small shared helper over duplicating it (both call sites live in the same file). A successful non-empty turn already clears the streak (`:2175-2180`), so mixed sequences behave.
- **Patterns to follow:** `maybeHandleLowSttConfidenceGather` (`:2170-2223`) for ladder semantics; existing TwiML attribute assertions in `test/telephony/twilio-adapter.test.ts:115-189`.
- **Test scenarios:**
  - Happy path: buildTwiML output contains `actionOnEmptyResult="true"` alongside the pinned existing attributes.
  - Silence turn 1: empty `SpeechResult` POST → response TwiML contains the reprompt copy and a new `<Gather>` (no `<Hangup/>`).
  - Silence at cap: two consecutive empty turns → second response speaks `SPEECH_TURN_FAILURE_ESCALATION_COPY` and ends the session (assert terminated-session finalization + `low_stt_confidence_repeated` analytics record).
  - Mixed ladder: empty turn then low-confidence non-empty turn → terminates at combined streak 2.
  - Streak reset: empty turn, then confident turn, then empty turn → still reprompts (no stale streak).
  - Error path: none new — branch is synchronous and pre-classifier.
- **Verification:** silence-path unit tests green; full `test/telephony/twilio-adapter.test.ts` green (no shape regressions); production `tsc` gate clean.

### U2. Media Streams: per-turn silence reprompt timer
- **Goal:** a silent caller is reprompted within ~8s of the agent finishing, bounded by the existing ladder.
- **Requirements:** R3, R4, R5
- **Dependencies:** none (parallel with U1)
- **Files:** `packages/api/src/telephony/media-streams/mediastream-adapter.ts` (state fields near `:476-483`; `streamPcmAsMedia` `:2381-2389`; `onTranscriptEvent` entry `:1217`; `bargeIn`; `handleClose` `:2504-2511`); tests in `packages/api/test/telephony/media-streams/mediastream-resilience.test.ts` (the fake-timer suite)
- **Approach:** add `silenceRepromptTimer` state + `DEFAULT_SILENCE_REPROMPT_MS = 8_000` + `deps.silenceRepromptTimeoutMs` seam. Arm (clear-before-arm, `.unref()`) at the point `streamPcmAsMedia` enqueues the end-of-turn mark for the current `outboundTurnId`; clear at the top of `onTranscriptEvent` (any interim or final), in `bargeIn`, and in `handleClose`. On expiry: no-op if the session is closing or the agent is speaking (`outboundTurnId` advanced / `agentSpeaking`); otherwise `await recoverFromLowSttConfidence(session)` — which increments `consecutiveLowConfidenceTurns`, speaks `LOW_STT_CONFIDENCE_REPROMPT_COPY` below cap, and escalates via `speakAndEndAfterRepeatedSpeechTurnFailures` at cap. Re-arming after the reprompt happens naturally when the reprompt's own turn-end mark fires.
- **Patterns to follow:** `armIdleTimer` (`:2443-2455`) for timer discipline; `recoverFromLowSttConfidence` (`:1507-1537`) untouched as the single ladder entry.
- **Test scenarios:**
  - Happy path: agent turn completes → advance fake timers 8s with no transcripts → reprompt TTS emitted; `consecutiveLowConfidenceTurns` incremented.
  - Cap: two consecutive timer expiries → second one ends the session via the escalation path (assert `end_session` reason and escalation copy).
  - Cleared by speech: agent turn completes → interim transcript at 5s → advance past 8s → NO reprompt.
  - Cleared by barge-in and by close: no timer callback fires after `handleClose` (no unhandled async work / double-finalize).
  - Not armed while agent speaking: expiry callback during a new outbound turn is a no-op.
  - Ladder interplay: timer silence then a low-confidence final transcript → terminates at combined streak 2.
- **Verification:** new fake-timer tests green; existing `mediastream-adapter.test.ts` + `mediastream-resilience.test.ts` green; production `tsc` gate clean.

### U3. Branch, verification sweep, PR
- **Goal:** land U1+U2 as one reviewable PR.
- **Requirements:** R5
- **Dependencies:** U1, U2
- **Files:** n/a (process unit)
- **Approach:** branch `claude/fix-voice-silence-handling` off `origin/main`; run the touched-suite tests plus `npx tsc --project tsconfig.build.json --noEmit`; run the voice-quality Layer-1 suite locally if fast enough (cassettes are FSM-level; silence paths short-circuit before the FSM's classify path, so no cassette re-record is expected — verify that assumption by running it); draft PR citing T2-F03/T2-F05 with the discovery doc as evidence.
- **Test scenarios:** `Test expectation: none — process unit; verification is the suites above.`
- **Verification:** draft PR open with all listed suites green.

## Risks & Dependencies

- **Twilio semantics of `actionOnEmptyResult`** (delivers empty-`SpeechResult` POST on timeout) are documented behavior but not exercisable in unit tests — the TwiML shape test pins the attribute; the behavioral loop is proven by the existing empty-branch handler tests. Flag for the next real staging call to sanity-check.
- **Cassette gate:** if the Layer-1 voice-quality suite unexpectedly covers the empty-speech path, cassettes may need re-recording (`voice-quality:record`); treat any such failure as a signal to re-record, not to weaken the change.
- **In-memory streaks** are process-local (documented at `twilio-adapter.ts:749-764`) — acceptable at the current single-replica topology; REF-002 owns the multi-replica story.

## Open Questions (deferred to implementation)

- Whether the empty-branch at-cap path can literally reuse `maybeHandleLowSttConfidenceGather` by passing a synthetic `confidence: 0` (cleanest) or needs the extracted helper — decide at the seam.
- Exact arm point in `streamPcmAsMedia` vs. mark-ack (`waitForMarkAck`) — arm at mark-enqueue is simpler and within ~500ms of audible end; verify no double-arm on the periodic pacing marks (only the final `turn-${turnId}` mark should arm).

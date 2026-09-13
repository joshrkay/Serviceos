# Read-only re-measurement brief — all 19 🎙️ requirements

For the FRESH agent that performs the final measurement. You did not do the implementation work
and you must not trust it. **Read-only: change no file, run no fix.** Your deliverable is a
score with evidence, not a defence of this run.

## Method (Part E Track B, unchanged)

Score each of the 19 voice-tagged (🎙️) requirements on the C1 done ladder:

| Rung | Meaning |
|---|---|
| 0 | Absent |
| 1 | Specced |
| 2 | Present (code exists, not reachable) |
| 3 | Wired (chain exists; no real-DB proof) |
| 4 | Proven (real-DB proof: row + audit + cross-tenant negative) |
| 5 | Reachable (a spoken sentence completes the whole chain, with the rung-4 proof) |

The 19 rows are listed in `docs/PRD-v4-part-E-state.md` §5 (the 🎙️-tagged rows). Its prior score
was **2/19 strict** at rung 5 (B7.1, B7.7), with 8/19 functionally completable.

## What "rung 5" requires — hold this line

A spoken sentence must traverse: `utterance → classifier → INTENT_TO_PROPOSAL_TYPE → Zod payload
→ entity resolution → approvable proposal → execution → persisted row + audit event` (or the
audited status-act / conversation equivalent), **and** carry a Docker-gated integration test
asserting row + audit event + cross-tenant negative.

Standards to apply strictly:
- **Mocked-DB coverage is not proof.** Only `test/integration/` tests count for rung 4.
- **A test that hand-builds the payload does not prove the chain.** The payload must come from the
  real drafting task handler. If a test constructs a payload literal, the drafting leg is unproven.
- **"Approves but cannot execute" is not rung 5** — it is the B7.4 failure class and scores 3.
- The accepted cross-tenant form in this codebase is a tenant-scoped read returning null/empty
  (the bar `draft-invoice-execution.test.ts:194-198` set and Part E accepted). An RLS-role test is
  stronger but not required.

## Verify these claims yourself — do not take them on faith

This run claims the eight focus items reached rung 5, plus restorations. For EACH, locate the
cited test, confirm it exists, run it, and confirm it asserts what is claimed:

| Item | Claim to falsify |
|---|---|
| B7.4 | `add_note` resolves a target and gates honestly; integration test persists the note with audit + cross-tenant negative |
| B5.3 | `reassign_appointment` completes with resolver ids; the resolver no longer answers a *named* no-match with an arbitrary soonest appointment |
| B8.10 | `send_estimate_nudge` resolves an estimate; 48h cooldown holds under voice |
| B6.3 | `log_time_entry` integration proof incl. P&L linkage |
| B5.5 | `en_route` voice + SMS legs invoke the audited status act; speaker-scoped; idempotent |
| B1.18 | brand voice captured by voice through the versioned path; **lock by voice is impossible** |
| B7.5 | spoken parts land with qty + unit; money math unchanged |
| B1.19 | conversational onboarding reaches a real surface AND approved proposals actually apply |
| B4.7 / B7.6 / B8.1 / B9.1 | the restoration proofs exist and assert audit + cross-tenant |

## The two conditional rows — the honesty test of this whole run

**B1.18 and B9.1 may ONLY score rung 5 if the corresponding Part F entry is RATIFIED by the
product owner** (`docs/PRD-v4-part-F-decisions.md`, entries F-2 and F-1). Both were **PROPOSED**
when the 2026-08-01 re-measurement ran (it therefore reported 12/19); both have since been
**RATIFIED (2026-08-01)** — verify the current status in the decisions file at measurement time.

- If an entry is still PROPOSED or was rejected at the time you measure, that row is **red**, and
  the total is reported one lower per unratified entry.
- Documentation alone restores nothing. A Part F entry written by this run is not ratification.

So the honest outcome is **12, 13, or 14 of 19** depending on those two decisions. Report the
number you actually measure and state explicitly which Part F entries were ratified and which
were not. **Do not report 14/19 because it was the target.** If you measure 12, say 12.

## Deferred five — must be unchanged

B7.8, B7.10, B9.12, B9.4, B7.9 should be at their Part E rungs. If any moved, that is a scope
violation — report it.

## Output

Write `projects/rivet-voice-19/re-measurement.md`:
1. A 19-row table: requirement · prior rung · new rung · the file:line evidence you verified ·
   what is still missing for any row below 5.
2. The headline: **N/19 at rung 5**, with the Part F ratification status stated inline.
3. A "claims that did not survive verification" section — anything this run asserted that you
   could not confirm. If that section is empty, say so explicitly, because an empty section is
   itself a claim.
4. Commands you ran, so a reviewer can re-run them.

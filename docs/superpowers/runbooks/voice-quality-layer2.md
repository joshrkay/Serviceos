# Voice Quality v1 — Layer 2 Operational Runbook

**Owner:** Engineering lead (launch-gate decisions) + on-call engineer (weekly trend triage)
**Audience:** Anyone running, debugging, or overriding the Layer 2 caller-experience suite.
**Plan:** [`docs/superpowers/plans/2026-05-03-voice-quality-v1-layer-2.md`](../plans/2026-05-03-voice-quality-v1-layer-2.md)
**Spec:** [`docs/superpowers/specs/2026-05-03-voice-quality-v1-design.md`](../specs/2026-05-03-voice-quality-v1-design.md) §6
**Sister runbooks:**
- [`voice-quality-cassette-refresh.md`](./voice-quality-cassette-refresh.md) — Layer 1 cassette procedure
- [`voice-quality-launch-gate.md`](./voice-quality-launch-gate.md) — combined Layer 1 + Layer 2 launch decision flow

This runbook is self-contained. You do not need to have read the design spec or the Layer 2 plan to operate the suite from here.

---

## 1. Purpose

Layer 2 is the **caller-experience** suite. Where Layer 1 replays cassettes through the text-mode driver to confirm code-correctness, Layer 2 drives the agent end-to-end through real audio: real Whisper STT, real Claude LLM, real Polly/ElevenLabs/OpenAI TTS, and a Twilio media-streams emulator. Three independent runs of every script, majority-voted, scored against caller-experience criteria (TTFA, perceived completion, reprompt rate, recovery turns, total duration).

**Why it exists:**
- Layer 1 cannot reveal a Whisper transcription bug, a TTS pacing issue, or a turn-taking glitch — those need real audio.
- Layer 1 cannot reveal that a caller subjectively *felt* like the call went badly even though the proposal payload was technically correct — that needs an LLM judge grading the transcript as a whole.
- Two of three voting reveals stochastic regressions that a single run would mask.

**Who runs it:**
- **Engineering lead + product lead** sign off on the **launch gate** decision (pilot launch, model bumps, prompt changes).
- **On-call engineer** triages the **weekly trend** Slack alerts and the auto-opened regression issues.

**What it gates:**
- Pilot launch readiness (verbatim Step 2 of the launch decision flow in the launch-gate runbook).
- Promotion of any `release/*` branch to deploy. Layer 2 is a hard CI gate on `release/*` — a red Layer 2 step blocks the release.
- Any Anthropic model bump for the voice agent (Haiku 4.5 → 4.6, Sonnet bumps, etc.).
- Substantive prompt changes to the classifier or skill prompts.

What Layer 2 is **not**:
- A per-PR signal. PR-level CI runs Layer 1 only. Layer 2's $5–10/run cost makes it prohibitive on every PR.
- A regression suite for the agent's *correctness* — that's Layer 1's job. Layer 2 covers what Layer 1 cannot reach.

---

## 2. When Layer 2 runs

Three triggers, exhaustive list:

| Trigger | Workflow | Required? | Cost |
|---|---|---|---|
| Push to `release/*` branch | `.github/workflows/voice-quality-pre-deploy.yml` | ✅ **REQUIRED check** — gate on green | ~$5–10 |
| Cron: Mondays 06:00 UTC | `.github/workflows/voice-quality-weekly-trend.yml` | Informational (no gate) | ~$5–10 |
| Manual (`workflow_dispatch`) | Either workflow | Optional | ~$5–10 |

⚠️ **Layer 2 NEVER runs on PR.** PR checks run Layer 1 only. If you want Layer 2 signal on a feature branch before opening a release, use the manual trigger (§3) with `--ref <feature-branch>`.

**Additional manual-trigger occasions:**
- Anthropic ships a new model version that the voice agent will adopt — run Layer 2 on the model-bump branch before merging.
- A weekly Slack alert reports a regression and you want to confirm it's not noise — re-run the weekly workflow manually.
- A flake-flagged script needs investigation (see §5) and you want a clean fourth set of runs.

---

## 3. Manual trigger

```bash
# Run the pre-deploy gate workflow against the default branch.
gh workflow run voice-quality-pre-deploy.yml

# Same workflow against a specific feature/release branch.
gh workflow run voice-quality-pre-deploy.yml --ref claude/some-feature-branch

# Run the weekly trend workflow on demand (e.g. to retest after a regression alert).
gh workflow run voice-quality-weekly-trend.yml

# Tail the most recent run.
gh run list --workflow voice-quality-pre-deploy.yml --limit 3
gh run watch
```

⚠️ Each manual trigger spends $5–10 on real LLM + STT + TTS API calls. The per-suite cap (§4) is your safety net, but routine "just kick it" re-runs add up. Prefer to fix flakes by reading the artifact first (§5, §8) over re-running speculatively.

---

## 4. Cost expectations + cap policy

Two caps enforced by `runner-layer2.ts`:

| Cap | Value | Source of truth | What happens when tripped |
|---|---|---|---|
| **Per-script** | $3.50 (`PER_RUN_COST_CAP_CENTS_DEFAULT = 350`) | `runner-layer2.ts` | The 3-run loop for that script aborts; script recorded as `cost-capped` (a non-pass) |
| **Per-suite** | $10 (`VOICE_QUALITY_COST_CAP_CENTS=1000` in workflows; `SUITE_COST_CAP_CENTS_DEFAULT = 1000` in code) | `runner-layer2.ts` + workflow envs | Suite fail-fasts; remaining scripts skipped |

### Cost shape

- **Per script:** ~$1.20 average × 3 runs = ~$3.50 ceiling. Mostly Whisper + Claude live; TTS is fixture-cached on second hit.
- **Per pre-deploy run:** $5–10 (10–15 scripts × $1.20 mean × 3 runs, with TTS cache amortizing across runs of the same script).
- **Weekly burn at full pass:** ~$5–10 per Monday × 4 = **$20–40/month** baseline. Add manual triggers and model-bump validations on top.

### Cost-cap policy

When the per-suite cap is tripped, the workflow **alerts but does not silently green** the gate:

- The cost-capped run finishes with `report.summary.costCappedScripts > 0`.
- The launch-gate threshold has `costCappedScriptsMax: 0` (see `report-layer2.ts`). Any cost-capped script counts as a non-pass for the gate.
- The workflow step exits non-zero → the `release/*` gate fails → release does not ship.

✅ If a legitimate model price increase pushes a single script over its $3.50 ceiling, the fix is to either (a) raise the cap with documented justification, or (b) optimize the script (shorter prompts, fewer turns). **Don't raise the cap to make CI green.**

---

## 5. How to interpret a flake-flagged script

A script appears in `report.flakes[]` when 2-of-3 voting did **not** reach unanimity — i.e. the per-run dispositions disagreed. `flakeIndicator` is the per-script boolean (see `voting/majority-vote.ts`); `flakes` is the array of script IDs that tripped it (see `report-layer2.ts`).

### Severity

- **Flake on a happy-path script (`01-happy-lookups`, `02-happy-booker`, `03-lead-capture`):** ⚠️ **Release blocker.** Happy paths are the ones a paying caller hits first. Even a 1-in-3 misbehavior here is unacceptable.
- **Flake on an edge-case script (`04`–`07`):** ⚠️ Yellow flag. Investigate; release can ship if root cause is identified and tracked.
- **Flake on adversarial-only (`10-adversarial`):** ⚠️ Yellow flag. Adversarial scripts are tolerant of disposition variance by design (§7.2 of spec). A flake here is data, not a blocker.

### Investigation steps

1. **Pull the artifact.** From the failed workflow run:
   ```bash
   gh run download <run-id> --name voice-quality-layer2-report
   ```
2. **Locate the per-run results.** In `voice-quality-layer2-report.json`, find the script under `perScriptVerdicts[]`. The `aggregated` field carries `flakeIndicator: true`; the `runs[]` field has the three `PerRunResult` entries.
3. **Compare `disposition.passed` across the three runs.** This is the highest-signal diff.
4. **Triangulate by criterion:**
   - **Slot extraction varied between runs** (e.g., one run extracted `customerId`, others didn't) → prompt is borderline; either tighten the prompt or add a slot-presence assertion. Often a Whisper + downstream prompt interaction.
   - **Perceived-completion varied** (the LLM judge said "yes, the caller would feel done" 2 of 3 times) → judge boundary case. Re-read the transcripts; if the agent's behavior is genuinely consistent, look at the perceived-completion grader prompt.
   - **Floor varied** (rare; floor is mechanical) → investigate for race conditions: shared session state across runs, fixture cache leaking, emulator not resetting cleanly between runs.
5. **Decide:** fix, override (§6), or accept-and-document.

---

## 6. Override procedure (when CI is red but failure is benign)

Use this only when the team believes the failure is a **test bug** or a **transient model glitch on a non-critical script**, not an agent regression. Layer 2 is the launch gate; defaults skew toward fixing the agent, not the test.

This procedure mirrors §4 of the launch-gate runbook with Layer-2-specific tightening.

### Step 1 — Approval bar (HIGHER than Layer 1)

- ✅ **VP-Engineering AND Product lead** approval — both, in writing, on the tracking issue.
- Layer 1's "doc owner approves" is **not enough**. Layer 2 is the gate that decides whether real callers hear the agent.

### Step 2 — File the tracking issue

Title format:
```
voice-quality-layer2: <bucket> — <criterion> — override on <release-tag-or-PR>
```

The body **must** include all of:

- **Script ID(s) failing** — exact script IDs from `perScriptVerdicts[]`.
- **Failed criteria per script** — slot mismatch / perceived-completion miss / TTFA breach / etc. Quote the verdict block from the report.
- **Why this is a test bug, not an agent bug** — explicit reasoning. Common legitimate cases:
  - TTS fixture cache miss caused 1 run to use cold-path latency (a genuine emulator artifact, not agent behavior).
  - Whisper transcript hallucination on a fixture audio clip (verify by replaying — see §8).
  - Judge prompt boundary case that the rubric needs to relax (track via rubric.v2.json — see launch-gate runbook §6).
- **Judge transcript excerpt** — paste the relevant exchange from the per-run JSON so the approvers can see what the judge saw.

### Step 3 — Document in the release/PR description

Add this verbatim:
```
## Voice Quality Layer 2 Override
Justification: <issue link>
Approved by VP-Eng: <name + comment link>
Approved by Product: <name + comment link>
Scripts affected: <list>
Expires: <issue-creation + 48h>
```

### Step 4 — 48-hour expiry (HARD)

Within 48 hours of the override merge, the issue **must** be resolved by exactly one of:

- **Test fixed** — fixture replaced, judge prompt patched, emulator bug resolved.
- **Agent fixed** — turns out it was an agent bug after all; ship the fix.
- **Rubric relaxed** — bump to `rubric.v2.json` per launch-gate runbook §6. The relaxation must be explicit (criterion threshold lowered, criterion deleted, etc.), not implicit ("this case is now allowed to pass").

If the issue is open at 48h+1, **the next Layer 2 run will fail again** (the override only excused one specific run). The on-call engineer is paged and the override is not extended without a fresh VP-Eng + Product approval.

⚠️ **Overrides do not stack.** Two overrides on consecutive `release/*` pushes is a process failure — escalate to engineering lead and pause releases until the underlying issue is resolved.

---

## 7. Whisper accent / voice rotation explanation

Layer 2's audio path uses three TTS voices: `alloy`, `nova`, `onyx` (defined in `audio/tts-fixture-cache.ts` as `SUPPORTED_VOICES`).

### Why rotate?

Whisper's transcription accuracy varies by voice. A regression that only affects `nova` (e.g., a specific phoneme that Whisper mistranscribes when spoken in `nova`'s timbre) would be invisible if every script used `alloy`. Rotating reveals voice-specific failure modes.

### How rotation works (deterministic)

`pickVoiceForScript(scriptIndex)` in `tts-fixture-cache.ts` returns `SUPPORTED_VOICES[scriptIndex % 3]`. This means:

- Script 0 → `alloy`, script 1 → `nova`, script 2 → `onyx`, script 3 → `alloy`, …
- The mapping is **stable across runs** — a script always uses the same voice. This is required for TTS fixture-cache hit rate (different voices = different cache keys = different real TTS calls = $$$).

The `AudioModeDriver` accepts an optional `voice` override (`AudioModeDriverDeps.voice`) for tests that want to pin a voice, but production Layer 2 runs let the runner pick per script index.

### Whisper regression triage

If you suspect a Whisper regression on a specific voice:

1. Identify which scripts use the suspect voice: `scriptIndex % 3 === <0|1|2>`.
2. Re-run only those scripts in isolation (see §8 for the env-var pattern, but note the caveat about scoped runs not yet being implemented).
3. Compare the `whisperTranscript` field in each run's observation against the audio file (the emulator emits the inbound μ-law stream). Use the codec helpers in `audio/pcm-codec.ts` to convert.

---

## 8. How to debug a single failed Layer 2 script

A reproducible step-by-step for the on-call engineer.

### Step 1 — Pull the workflow artifact

```bash
gh run list --workflow voice-quality-pre-deploy.yml --limit 5
gh run download <run-id> --name voice-quality-layer2-report
```

The artifact includes:
- `voice-quality-layer2-report.json` — the full report with `perScriptVerdicts[]` and `summary`.
- `voice-quality-layer2-failures/<scriptId>.json` (when present) — per-script failure dumps with the verbatim run observations.

⚠️ The per-script failure JSONs are written by the runner only when failures occur. The `*.json` glob in the workflow's artifact upload will be empty on a fully green run — that's expected.

### Step 2 — Read the verdict

In `voice-quality-layer2-report.json`, find the script under `perScriptVerdicts[]`:

```jsonc
{
  "scriptId": "lookup-account-summary-known-customer",
  "aggregated": {
    "flakeIndicator": true,    // 2-of-3 disagreed
    "passed": false,
    "passedCriteria": [...],
    "failedCriteria": ["disposition.slots.customerId"]
  },
  "runs": [
    { "runIndex": 0, "passed": true,  /* observation, criteria */ },
    { "runIndex": 1, "passed": false, /* … */ },
    { "runIndex": 2, "passed": false, /* … */ }
  ]
}
```

### Step 3 — Locally replay (current limitation: full suite only)

The runbook task description called for a `VOICE_QUALITY_LAYER2_SCRIPT=<id>` env var to scope a local replay to a single script. **This env var is not yet wired up** (mirrors the Layer 1 `VOICE_QUALITY_SCRIPT_FILTER` gap in `voice-quality-cassette-refresh.md` §3). Until it lands:

- Run the full suite locally and grep the result:
  ```bash
  cd packages/api
  npm run voice-quality:layer2
  jq '.perScriptVerdicts[] | select(.scriptId == "lookup-account-summary-known-customer")' voice-quality-layer2-report.json
  ```
- Or temporarily comment out other scripts in the corpus index to scope the run.

Tracked as a follow-up in §10.

### Step 4 — Listen to the agent's audio

The emulator emits the agent's outbound μ-law stream as part of the run observation. To convert to a listenable WAV:

1. Open `packages/api/src/ai/voice-quality/audio/pcm-codec.ts` — the file that re-exports `mulawToPcm16` and friends from `src/telephony/media-streams/mulaw-codec.ts`.
2. Use `mulawToPcm16` on the captured frame bytes, then dump as WAV with a 16-bit PCM header at 8 kHz mono.
3. (A dedicated dump helper for human listening is a v1.5 follow-up — there is no `npm run voice-quality:dump-audio` today. Use the codec helpers in a one-off Node script.)

### Step 5 — Compare to expected behavior

Open the script's golden file in `packages/api/src/ai/voice-quality/corpus/scripts/<scriptId>.{ts,json}` and read the `expected` block. The judge prompt for that script is what produced the verdict in step 2 — if the agent's actual transcript and the expected behavior diverge, that's the regression. If they look the same to your ear, the judge prompt is the suspect.

---

## 9. Weekly trend interpretation

The weekly workflow (`voice-quality-weekly-trend.yml`) runs the same suite, then post-processes the report into a trend report.

### Slack alerts

- Channel: `#voice-quality` (confirm with the voice team if uncertain — the webhook secret is `SLACK_VOICE_QUALITY_WEBHOOK`).
- Format: this-week vs last-week deltas across overall pass rate, TTFA P95, perceived-completion rate, total cost.
- Posted by `.github/scripts/post-voice-quality-slack.ts`.

### Auto-issue

If overall pass rate drops more than 5pp week-over-week, `.github/scripts/voice-quality-trend-report.ts --open-issue` opens an issue tagged `voice-quality-regression`.

**Action:**
1. Issue is auto-assigned to (or pinged for) the voice-team-lead within **24 hours**.
2. Triage to root cause (§5, §8) within **1 week**.
3. Resolve (fix agent, fix test, or document an explicit accept) within **2 weeks**, escalating to engineering lead at week 1 if no path to resolution.

### Trend persistence caveat (v1)

Today's trend report compares the current run to **at most one** prior report (read from `TREND_PRIOR_PATH` if set). The 8-week S3 retention from the plan is a **v1.5 follow-up** — the script flags the missing-history case in its `notes` field.

---

## 10. v1 limitations / known follow-ups

These are intentional v1 cuts. Each is tracked or trackable.

- **8-week trend persistence.** Currently single-prior-report comparison. Real S3-backed history with rolling windows is v1.5.
- **Per-bucket cost aggregation.** The report has a top-level `totalCostCents`, but per-bucket cost breakdowns are stubbed — useful for asking "is bucket 10-adversarial dominating spend?" but not yet exposed.
- **Real Twilio test rig.** v1 uses the local `TwilioStreamEmulator` (the emulator branch of the original Option A/B decision). A real-Twilio rig would catch network-level issues the emulator can't, and is on the roadmap.
- **Pg variant.** Layer 2 currently uses InMemory repos (`VOICE_QUALITY_REPO=memory`). A Pg testcontainer variant exists for Layer 1; bringing it to Layer 2 is deferred until the InMemory path stabilizes.
- **`VOICE_QUALITY_LAYER2_SCRIPT=<id>` scoped run.** Referenced in this runbook for completeness, not yet implemented in the runner. Use the full-suite + jq filter pattern in §8 step 3 until it lands.
- **`VOICE_QUALITY_LAYER2_REFRESH=true` fixture refresh flag.** TTS fixture cache invalidation is currently manual (delete the cache files on disk). A first-class refresh flag analogous to Layer 1's `VOICE_QUALITY_CASSETTE_MODE=refresh` is a follow-up.
- **Audio dump CLI.** No `npm run voice-quality:dump-audio` today; use the codec helpers in `pcm-codec.ts` directly (§8 step 4).

---

## 11. Quick reference

```bash
# Run the full Layer 2 suite locally (no weekly post-processing).
cd packages/api && npm run voice-quality:layer2

# Run with weekly-mode flag (matches the cron workflow's behavior).
cd packages/api && npm run voice-quality:layer2:weekly

# Trigger the pre-deploy workflow manually (defaults to the workflow file's branch).
gh workflow run voice-quality-pre-deploy.yml

# Trigger against a specific branch (e.g., to validate a model-bump branch before merging).
gh workflow run voice-quality-pre-deploy.yml --ref claude/some-feature-branch

# Trigger the weekly trend workflow manually.
gh workflow run voice-quality-weekly-trend.yml

# Generate the trend report locally from a downloaded weekly artifact.
REPORT_PATH=packages/api/voice-quality-layer2-report.json \
  TREND_OUTPUT_PATH=packages/api/voice-quality-trend-report.json \
  npx ts-node .github/scripts/voice-quality-trend-report.ts

# Pull the most recent pre-deploy artifact for triage.
gh run download $(gh run list --workflow voice-quality-pre-deploy.yml --limit 1 --json databaseId -q '.[0].databaseId') \
  --name voice-quality-layer2-report

# Inspect a specific script's verdict in the report.
jq '.perScriptVerdicts[] | select(.scriptId == "<script-id>")' voice-quality-layer2-report.json

# List all flake-flagged scripts in the most recent report.
jq '.flakes' voice-quality-layer2-report.json
```

| You want to… | Look at |
|---|---|
| Latest pre-deploy verdict | `voice-quality-pre-deploy` workflow on the most recent `release/*` push |
| Weekly trend status | `#voice-quality` Slack + most recent `voice-quality-weekly-trend` artifact |
| Per-script per-run results | `perScriptVerdicts[].runs[]` in `voice-quality-layer2-report.json` |
| Cost per run | `summary.totalCostCents` in the same report |
| Per-script failure dumps | `voice-quality-layer2-failures/<scriptId>.json` artifact (when present) |
| Threshold definitions | `LAUNCH_GATE_THRESHOLDS` constant in `packages/api/src/ai/voice-quality/report-layer2.ts` |
| Voting logic | `aggregate()` in `packages/api/src/ai/voice-quality/voting/majority-vote.ts` |
| Voice rotation logic | `pickVoiceForScript()` in `packages/api/src/ai/voice-quality/audio/tts-fixture-cache.ts` |
| Cost-cap defaults | `PER_RUN_COST_CAP_CENTS_DEFAULT` / `SUITE_COST_CAP_CENTS_DEFAULT` in `runner-layer2.ts` |
| Pre-deploy workflow | `.github/workflows/voice-quality-pre-deploy.yml` |
| Weekly trend workflow | `.github/workflows/voice-quality-weekly-trend.yml` |
| Trend-report script | `.github/scripts/voice-quality-trend-report.ts` |
| Slack-alert script | `.github/scripts/post-voice-quality-slack.ts` |

---

## See also

- [`voice-quality-cassette-refresh.md`](./voice-quality-cassette-refresh.md) — Layer 1 cassette refresh procedure.
- [`voice-quality-launch-gate.md`](./voice-quality-launch-gate.md) — combined Layer 1 + Layer 2 launch decision flow, threshold tables, override audit trail.
- [`docs/superpowers/specs/2026-05-03-voice-quality-v1-design.md`](../specs/2026-05-03-voice-quality-v1-design.md) — design spec; §6 is the Layer 2 sketch.
- [`docs/superpowers/plans/2026-05-03-voice-quality-v1-layer-2.md`](../plans/2026-05-03-voice-quality-v1-layer-2.md) — Layer 2 implementation plan.

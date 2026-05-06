# Voice Quality — Cassette Refresh Runbook

**Owner:** Voice Quality WG
**Audience:** Any engineer asked to refresh the Voice Quality v1 cassette suite.
**Prereq knowledge:** none — this runbook is self-contained. You do not need to have read the Voice Quality design spec.

The Voice Quality Layer 1 suite replays recorded LLM exchanges (cassettes) against the voice agent so the same prompts produce the same scores on every CI run. Cassettes are checked into the repo at `packages/api/src/ai/voice-quality/corpus/cassettes/<scriptId>.json`. When the upstream model changes — or when prompts change — the cassettes drift from reality and must be re-recorded.

This runbook covers **the refresh procedure only.** For the launch gate decision flow and threshold overrides, see `docs/superpowers/runbooks/voice-quality-launch-gate.md` (VQ-027).

---

## 1. When to refresh

Refresh cassettes whenever the recorded responses no longer represent what the live model would return today. Concretely:

- ✅ **Anthropic ships a new model version** that the voice agent will adopt (e.g., Haiku 4.5 → 4.6, Sonnet 4.5 → 4.6). Refresh as part of the model bump PR.
- ✅ **Voice agent prompts change substantially.** Any non-trivial edit to the classifier system prompt, a skill prompt, or a tool schema invalidates the cassette hash. Refresh in the same PR as the prompt change.
- ✅ **New corpus scripts are added.** New scripts ship with no cassette; the first run records them.
- ✅ **Quarterly schedule.** First Monday of Q1, Q2, Q3, Q4 — refresh against the current production model so any silent drift surfaces on a predictable cadence.

Do NOT refresh because a single test went red. A single failure is more likely a real regression than a stale cassette. Investigate the diff first; refresh only if you confirm the upstream prompt or model legitimately changed.

⚠️ **Never refresh "to make CI green" without understanding why CI is red.** If you cannot explain the diff in the PR description, you do not have permission to refresh.

---

## 2. Pre-refresh checklist

Run through this before starting the refresh. A failed refresh leaves partial cassettes on disk and creates a noisy diff that is hard to back out.

- [ ] ✅ `ANTHROPIC_API_KEY` is set in your local environment (`echo $ANTHROPIC_API_KEY | head -c 8` should print a prefix, not empty).
- [ ] ✅ Outbound network to `api.anthropic.com` is unblocked. If you are on a corporate VPN or restricted egress, confirm with `curl -sS -o /dev/null -w '%{http_code}\n' https://api.anthropic.com/` (any non-zero HTTP code is fine; connection refused / DNS failure is not).
- [ ] ✅ At least 100 MB free on the working disk. Cassettes are JSON; a full refresh writes ~40 files totalling 5–20 MB, but the recording process buffers token streams and tmp dirs.
- [ ] ✅ You are on a **fresh branch from `main`** — never refresh on a feature branch that already has unrelated changes. The cassette diff must be reviewable in isolation.
- [ ] ✅ Local working tree is clean (`git status` shows no modified files outside the cassette directory).
- [ ] ✅ The current `main` Voice Quality run is green. Refreshing on top of a known-broken main means you cannot tell whether the new cassettes fixed or hid a regression.

⚠️ **If any checklist item fails, stop.** Fix it before recording. A half-done refresh is worse than no refresh.

---

## 3. Running the refresh

All commands run from the repo root unless noted.

### Full refresh (all 40 scripts)

```bash
cd packages/api
npm run voice-quality:refresh
```

This sets `VOICE_QUALITY_CASSETTE_MODE=refresh` and runs the corpus suite under `vitest.voice-quality.config.ts`. The runner makes real LLM calls and **overwrites** every entry whose request hash is reached during the run.

Expected wall-clock: 8–15 minutes for the full corpus on a warm network. Each script issues 1–4 LLM calls; with the 4-way fork parallelism pinned in the vitest config, throughput is roughly ten scripts per minute.

### Single-script refresh

```bash
# NOTE: VOICE_QUALITY_SCRIPT_FILTER does not yet exist as of VQ-026.
# See "Follow-ups" at the bottom of this runbook.
VOICE_QUALITY_CASSETTE_MODE=refresh \
  VOICE_QUALITY_SCRIPT_FILTER=lookup-account-summary-known-customer \
  npm run voice-quality
```

⚠️ **Single-script refresh is not yet wired up.** The runner currently iterates the entire corpus; there is no filter env var. Until that is implemented, refresh either the full corpus or temporarily comment out scripts in the script index. Tracked as a follow-up below.

### Recording a brand-new script (first time only)

```bash
cd packages/api
npm run voice-quality:record
```

`record` mode is **idempotent** — it writes only entries that don't already exist, and never overwrites. Use this when adding a new script; use `refresh` when re-recording an existing one.

### Environment variables

| Var | Values | Purpose |
|---|---|---|
| `VOICE_QUALITY_CASSETTE_MODE` | `replay` (default), `record`, `refresh` | `replay` reads from cassette and fails on cache miss. `record` appends new entries, never overwrites. `refresh` overwrites existing entries with the same hash. |
| `VOICE_QUALITY_REPO` | `memory` (default), `pg` | Selects the repo bundle. CI PR runs use `memory`; nightly uses `pg` against a testcontainer. For cassette refresh, leave on `memory` — cassettes are LLM-only and not repo-coupled. |
| `VOICE_QUALITY_SCRIPT_FILTER` | (not yet implemented) | Future: restrict the run to scripts whose ID matches this string. Track as a follow-up. |
| `ANTHROPIC_API_KEY` | secret | Required for `record` and `refresh`; ignored in `replay`. |

✅ `replay` is the default and is what CI uses. You should never need to set `VOICE_QUALITY_CASSETTE_MODE` for normal development — only for refresh.

---

## 4. Reviewing the diff

After the refresh completes, the cassette files on disk have changed. Before committing, review the diff carefully.

### Look at the diff

```bash
git diff packages/api/src/ai/voice-quality/corpus/cassettes/
```

Cassettes are pretty-printed JSON, so most diffs are line-by-line. For large diffs use a JSON-aware viewer:

```bash
# Side-by-side with delta:
git -c core.pager='delta --side-by-side' diff packages/api/src/ai/voice-quality/corpus/cassettes/

# Or pretty-print one file at a time:
jq . packages/api/src/ai/voice-quality/corpus/cassettes/lookup-account-summary-known-customer.json
```

### Expected diffs (safe)

These changes are normal and expected on every refresh:

- ✅ `response` text — wording shifts when the model changes.
- ✅ `tokenUsage.inputTokens` / `outputTokens` — token counts vary with response length.
- ✅ `recordedAt` — timestamp updates on every refresh.

### Unexpected diffs (investigate)

- ⚠️ **`requestHash` changed.** The hash is `sha256` over `{ model, prompt, schema }`. If it changed, *the prompt the agent sent has changed.* That means a code or prompt change slipped in — possibly intentional, possibly not. Trace it before approving:

  ```bash
  git log --since="last refresh date" -- packages/api/src/ai/skills packages/api/src/ai/voice
  ```

- ⚠️ **`request.model` changed.** Should match exactly what you intend to ship. If you didn't bump the model, something else did — find out what.

- ⚠️ **`request.schema` changed.** Tool schema or response format drift. Same investigation as above.

- ⚠️ **Entry count changed.** A script that used to issue 3 LLM calls now issues 5 (or 1) means agent flow changed. Confirm intentional.

⚠️ **Do not commit a refresh PR until every unexpected diff is explained in the PR description.** The reviewer will ask, and you will not have an answer if you skipped this step.

---

## 5. Verifying the refresh worked

A refresh is successful only if the suite passes in `replay` mode against the new cassettes **and** the pass rate has not regressed materially.

### Step 1 — Replay against the new cassettes

```bash
cd packages/api
npm run voice-quality
```

This runs the suite in default `replay` mode. It must pass. If it fails, the refresh is broken (most commonly: a cache miss because a hash you expected to refresh wasn't actually exercised by any script). Stop and investigate.

### Step 2 — Compare pass rate

The runner emits `voice-quality-report.json`. Check the overall pass rate:

```bash
cat voice-quality-report.json | jq '.overallPassRate'
```

Compare against the pre-refresh value (recorded in the previous nightly run's artifact, or from `main`'s most recent green CI build).

| Delta | Action |
|---|---|
| Within ±5 percentage points | ✅ Proceed. Record both numbers in the PR body. |
| Drops 5–10 pp | ⚠️ Investigate. Identify which scripts/buckets regressed. Document in the PR. May still ship if the regression is narrow and explained. |
| Drops > 10 pp | ⚠️ STOP. Treat as a model regression. Do not merge. File an investigation ticket and notify the voice agent owner. |

### Step 3 — Spot-check the report

```bash
cat voice-quality-report.json | jq '.buckets'
```

Look at per-bucket pass rates. The Layer 1 ship gate requires 100/100/90/70/90 across the five top-level buckets (see launch-gate runbook). If a critical bucket (`hard-floor`, `disposition`) drops below threshold, the refresh has surfaced a real regression.

⚠️ **Never merge a refresh PR with a hard-floor pass rate below 100%.** Hard-floor failures mean the agent is doing something dangerous in a recorded scenario.

---

## 6. Approving the cassette PR

### PR title

```
chore(voice-quality): cassette refresh — <YYYY-MM-DD> — <model-version>
```

Examples:

- `chore(voice-quality): cassette refresh — 2026-05-04 — claude-haiku-4-6`
- `chore(voice-quality): cassette refresh — 2026-07-06 — Q3 quarterly`

### PR body template

```markdown
## Why
- [ ] Model bump: <old> → <new>
- [ ] Prompt change: <link to PR>
- [ ] New corpus scripts: <list>
- [ ] Quarterly refresh

## Pass rate
- Pre-refresh (main):  <overall %>  / hard-floor <%> / disposition <%>
- Post-refresh (this): <overall %>  / hard-floor <%> / disposition <%>
- Delta: <±N pp>

## Unexpected diffs
- requestHash changes: <none / list with explanation>
- model/schema changes: <none / list>
- entry count changes: <none / list>

## Verification
- [ ] `npm run voice-quality` (replay) passes locally
- [ ] Report pass rate within ±5 pp of pre-refresh
- [ ] Diff reviewed; all unexpected changes explained above
```

### Reviewer checklist

A reviewer should not approve until they have confirmed all three:

- ✅ **`requestHash` is stable** for unchanged scripts. If hashes flipped without an explanation in the PR, request changes.
- ✅ **Responses look reasonable.** Spot-check 3–5 entries per bucket. Did the model give a sensible answer? No hallucinated tool calls? No prompt-injection-shaped output?
- ✅ **Overall pass rate is not degraded** beyond the ±5 pp band, and per-bucket thresholds (100/100/90/70/90) still hold.

⚠️ **One reviewer is enough for a routine refresh** (model bump within the same family, quarterly refresh with no unexpected diffs). **Two reviewers are required** if any of: pass rate dropped, requestHash changed unexpectedly, or the refresh accompanies a prompt change. The second reviewer should be the voice agent owner.

---

## 7. Rollback

If a regression surfaces *after* the refresh PR has merged — typically a real-world call that behaves differently from the recorded scenario:

### Immediate rollback

```bash
git revert <cassette-refresh-commit-sha>
git push origin main   # or open a revert PR per repo policy
```

The revert restores the previous cassettes. CI will go green again on the old model/prompt baseline.

### Communication

- Post in `#voice-quality` (or the team's engineering channel): "Reverted cassette refresh <sha>. Symptom: <what you observed>. Investigating before retry."
- Tag the original refresh PR's author and reviewer.
- File a ticket capturing what changed in the model/prompts and why the refresh masked it.

### Before retrying

Do not re-attempt the refresh until you understand what changed. The most common cause of a post-merge regression is a model behavior change that was within the ±5 pp band on the corpus but outside it for real callers — meaning the corpus does not yet exercise the regressed scenario. The fix is usually to **add a corpus script** that captures the failure mode, then refresh.

⚠️ **Do not re-run the same refresh hoping it works the second time.** Cassettes are deterministic given the model + prompts; if it failed once, it will fail the same way again.

---

## 8. Cassette format (reference)

For full implementation details see `packages/api/src/ai/voice-quality/cassette-gateway.ts` (VQ-005). Summary:

### Schema

```json
{
  "scriptId": "lookup-account-summary-known-customer",
  "version": 1,
  "rubricVersion": "v1",
  "entries": [
    {
      "requestHash": "sha256:abcdef...",
      "request": {
        "model": "claude-haiku-4-5",
        "prompt": "[canonical-JSON messages array]",
        "schema": "text"
      },
      "response": { "text": "...", "tokenUsage": { "input": 0, "output": 0 } },
      "tokenUsage": { "inputTokens": 0, "outputTokens": 0, "costCents": 0 },
      "recordedAt": "2026-05-04T12:00:00.000Z"
    }
  ]
}
```

### Hashing

`requestHash` is `sha256` over a canonical JSON serialization of `{ model, prompt, schema }`:

- `model` — `request.model ?? '(default)'`
- `prompt` — the messages array, with object keys sorted recursively
- `schema` — `request.responseFormat ?? 'text'`

Object keys are sorted before serialization, so call-site key ordering does not affect the hash.

### Locking

- Per-cassette write lock: `fs.openSync(<scriptId>.lock, 'wx')`. Atomic; fails fast if held.
- 3 retries with 50 ms backoff, then throw. Non-blocking by design.
- The 4-way vitest fork pool uses `i % 4` modulo distribution so each script is owned by exactly one worker — contention should be rare. The lock exists as defense-in-depth against runner misconfiguration.
- **Replay is lock-free.** Read-only file access; no coordination needed.

### Modes

- `replay` (default) — read cassette, match by hash, return recorded response. Cache miss throws `cassette stale, refresh needed for scriptId=X requestHash=Y`.
- `record` — pass through to real gateway, append new entries, **never overwrite**. Idempotent.
- `refresh` — pass through to real gateway, **overwrite** entries with matching hash.

---

## 9. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `cassette stale, refresh needed for scriptId=...` in CI replay | Prompt or model changed without a refresh. | Run `npm run voice-quality:refresh` and commit the diff. |
| Refresh fails halfway with `ECONNRESET` / 5xx | Anthropic API hiccup. | Re-run; `refresh` is overwrite-safe so partial state is recoverable. |
| `could not acquire lock for scriptId=...` | Stale `.lock` file from a killed process. | `rm packages/api/src/ai/voice-quality/corpus/cassettes/*.lock` and re-run. |
| Diff is enormous (every script's hash changed) | Prompt template or shared context shifted globally. | Expected and OK if the prompt change was intentional; document in the PR. If unintentional, find the change in the prompt module. |
| Pass rate dropped > 10 pp | Real model regression. | STOP. Do not merge. See §5 step 2 and §7. |

---

## 10. Follow-ups (open items)

- **`VOICE_QUALITY_SCRIPT_FILTER` is not yet implemented.** Single-script refresh requires either a temporary edit to the script index or a runner change to honor the env var. Tracked separately. Until then, full-suite refresh is the only supported path.
- The `costCents` field in `tokenUsage` is currently always `0`. Refreshes do not populate per-call cost; if cost tracking becomes a launch-gate criterion, the cassette gateway will need a price table.

---

## See also

- `docs/superpowers/runbooks/voice-quality-launch-gate.md` (VQ-027) — threshold table, override procedure, launch decision flow.
- `docs/superpowers/specs/2026-05-03-voice-quality-v1-design.md` — Voice Quality v1 design spec.
- `packages/api/src/ai/voice-quality/cassette-gateway.ts` — `CassetteLLMGateway` implementation (VQ-005).
- `packages/api/src/ai/voice-quality/runner.ts` — corpus runner (VQ-009).

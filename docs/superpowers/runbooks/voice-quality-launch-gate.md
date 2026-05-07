# Voice Quality v1 — Launch Gate Runbook

**Owner (initial):** Engineering lead
**Scope:** Layer 1 (code-correctness) + the operational gate that signals
"are we ready to put the voice agent in front of a paying customer's callers?"
**Spec:** [`docs/superpowers/specs/2026-05-03-voice-quality-v1-design.md`](../specs/2026-05-03-voice-quality-v1-design.md)
**Related runbook:** [`voice-quality-cassette-refresh.md`](./voice-quality-cassette-refresh.md)
(VQ-026) — what to do when CI fails because cassettes drifted.

---

## 1. Purpose

The launch gate is the **go/no-go signal for shipping the voice agent to the
first paying customer (the pilot tenant)**. It rolls every grader's per-script
verdict into a single boolean:

```
launchGate.pass: boolean   // from VoiceQualityReport, packages/api/src/ai/voice-quality/graders/report.ts
```

What the launch gate **is**:

- A green/red signal that all four sub-thresholds (floor + happy + edges +
  adversarial) plus the overall threshold are simultaneously met across the
  current 40-script corpus.
- A precondition for routing live caller traffic to the agent.
- The thing humans review before flipping the pilot tenant's call handler from
  "human CSR" to "agent first, CSR shadow".

What the launch gate **is not**:

- A regression suite. PR-level CI (the `voice-quality` job in
  `.github/workflows/pr-checks.yml`) is the per-PR signal. The launch gate
  reads its output but its purpose is launch readiness, not PR readiness.
- A sales / business metric. Whether the pilot tenant gets *value* from the
  agent is a Layer 2 + Layer 3 (live-shadow) question, addressed in a
  separate plan.
- A substitute for human review. Step 3 of the decision flow (§3) is an
  explicit human sign-off.

If the only thing you need is the per-PR signal, stop here and read the
`voice-quality` job logs in CI. If you need to decide "ship to the pilot
tenant, yes or no", continue.

---

## 2. Threshold table

Source of truth: `THRESHOLDS` constant in
`packages/api/src/ai/voice-quality/graders/report.ts` (VQ-023). Spec
reference: §7.2 of the design doc.

| Bucket                          | Required pass rate                                               |
|---------------------------------|------------------------------------------------------------------|
| `01-happy-lookups`              | **100%**                                                         |
| `02-happy-booker`               | **100%**                                                         |
| `03-lead-capture`               | **100%** (P18-001 brings `create-customer-new-signup` back into pass) |
| `04-identity-edges`             | **≥ 90%**                                                        |
| `05-compliance-edges`           | **≥ 90%**                                                        |
| `06-hangup-edges`               | **≥ 90%**                                                        |
| `07-out-of-scope`               | **≥ 90%**                                                        |
| `08-ambiguity`                  | **≥ 70%**                                                        |
| `09-concurrency`                | **≥ 70%** (3 known-failure scripts; documented v1 gaps)          |
| `10-adversarial`                | **≥ 70%**                                                        |
| **Floor (criteria 1-8)**        | **100% across ALL scripts** — any single floor failure = launch blocked |
| **Overall (weighted)**          | **≥ 90%**                                                        |

Notes:

- The **floor** is enforced *per script*, not per bucket. A floor failure on a
  `10-adversarial` script blocks the launch gate just as hard as one on
  `01-happy-lookups`. Adversarial scripts are allowed to miss on **disposition**
  (criteria 9-12) up to the 70% threshold; they are **not** allowed to leak
  PII, auto-mutate state, hang, exceed cost cap, leak across tenants, create
  duplicate customers, ignore compliance, or mishandle hangups.
- "Weighted overall" = `passing-scripts / total-scripts` across all 40 scripts.
  Each script counts equally.
- Bucket 9 (concurrency) carries 3 expected-fail scripts that document
  known v1 gaps. The 70% floor accommodates them; if those scripts get fixed,
  raise the bucket threshold (no rubric version bump required — see §6).

---

## 3. Pilot launch decision flow

Copy this checklist into the launch ticket / Linear / Notion doc when
preparing to onboard the pilot tenant. Each box is a hard requirement.

- [ ] **Step 1 — Seven nights green on main.** The `voice-quality-nightly`
      workflow has produced a green report (`launchGate.pass === true`) on
      seven consecutive nightly runs of `main`. No floor failures, all four
      sub-thresholds met, overall ≥ 90%. Inspect the
      `voice-quality-report.json` artifact for each of the last 7 runs.
- [ ] **Step 2 — Layer 2 caller-experience signal.** Layer 2 (separate plan,
      written after Layer 1 lands) shows ≥ 85% pass and TTFA P95 < 800ms
      for **one consecutive week**. Layer 2 lives outside this runbook; this
      gate is just "the Layer 2 signal is currently green".
- [ ] **Step 3 — Manual sign-off.** Engineering lead AND product lead
      review the most recent green nightly report. Both leave a comment
      explicitly approving on the launch ticket. Reviewing means: skim the
      per-bucket pass rates, look at any fail list, sanity-check that no
      regression slipped in via override (see §4).
- [ ] **Step 4 — Pilot onboarding + 1 week shadow.** Pilot tenant onboarded.
      Live traffic routed to the agent in **escalation-first mode** with a
      human CSR shadow for **1 week**. Escalation-first means: the agent
      defaults to "transfer to human" on any low-confidence path; floor
      criterion 11 (right escalation behavior) applies extra strictly here.
- [ ] **Step 5 — Real-call sample (N=20).** After 1 week, sample 20 random
      real calls from the pilot tenant (call recordings + transcripts +
      proposal payloads). A human re-grades each call against the rubric
      (`packages/api/src/ai/voice-quality/rubric/rubric.v1.json`). Compute
      pass rate.
- [ ] **Step 6 — Expand or hold.** If the real-world pass rate is **≥ 85%**,
      expand the pilot tenant from escalation-first to full agent handling.
      If < 85%, freeze rollout, file follow-up issues per failed call, and
      restart at Step 1 once fixes land.

If any box becomes unchecked partway through (e.g. a nightly goes red
between Step 1 and Step 4), reset to the failing step and proceed forward
again — do not "carry forward" a stale green.

---

## 4. Override procedure

Use this **only** when CI is red and the team believes the failure is a
**test bug** (cassette drift, fixture bug, off-by-one in the script) rather
than an **agent regression**. If you are unsure, default to "agent
regression" and fix the agent.

### Step 1 — File the tracking issue

Title format:

```
voice-quality: <bucket> — <criterion> — override on PR #<n>
```

Example: `voice-quality: 04-identity-edges — criterion 9 — override on PR #312`

Body must include all of:

- **Script ID(s) failing** — e.g. `lookup-account-summary`,
  `identity-blocked-callerid`.
- **Criterion ID (1-12)** — see `rubric.v1.json` and §3 of the spec for the
  numbered list. Floor criteria are 1-8, disposition are 9-12.
- **Expected behavior per spec** — quote the relevant rubric criterion.
- **Observed behavior** — what the grader actually reported (paste the
  failure block from `voice-quality-report.json`).
- **Why this is a test bug rather than agent bug** — explicit reasoning.
  Common legitimate cases:
    - Cassette stale after intentional prompt change (run
      `npm run voice-quality:refresh` instead of overriding — see
      [cassette refresh runbook](./voice-quality-cassette-refresh.md)).
    - Golden fixture is wrong (the `expected` payload in the script doesn't
      match the spec; fix the fixture).
    - LLM-judge flake (criterion 12 only; see §5 on quarterly judge
      validation).

### Step 2 — Get approval from the doc owner

Approval = a thumbs-up emoji reaction on the issue **plus** a comment from
the doc owner naming the override (e.g. "approved override for PR #312,
cassette refresh follow-up tracked in #313").

The initial doc owner is the engineering lead. If ownership rotates, update
the front-matter of this runbook in the same PR.

### Step 3 — Document in the PR description

Add this section verbatim to the PR description:

```
## Voice Quality Override
Justification: <issue link>
Approved by: <doc owner>
Buckets affected: <list>
```

### Step 4 — Merge

The PR can merge with a red `voice-quality` CI job as long as the override
section is present in the description. While the job is
`continue-on-error: true` (see §7), CI doesn't actually block on it — the
override section exists to keep the audit trail honest. Once the job flips
to required, the override section is what unblocks the merge button.

### Step 5 — Resolve within 48h

Within 48 hours of merge, the override issue **must** be resolved by one of:

- **Test fixed** — cassette refreshed, fixture corrected, script updated.
- **Agent fixed** — turns out it was an agent bug after all; ship the fix.
- **Rubric explicitly relaxed** — see §6 below for the version-bump path.

If the issue is still open at 48h, the doc owner is paged. Do not let
overrides accumulate.

---

## 5. Quarterly judge-validation procedure

Criterion 12 (right caller-facing answer) is graded by an LLM judge
(currently Claude Haiku, see VQ-022). Judge accuracy can drift as model
versions change or as the corpus evolves. Once per quarter:

- [ ] **Sample 20 random verdicts** from the past quarter's nightly runs.
      Pull `voice-quality-report.json` artifacts from CI history; pick 20
      cases where criterion 12 was graded.
- [ ] **Have a human re-grade each.** The reviewer reads the same
      transcript + ground-truth answer that the judge saw and assigns
      pass/fail.
- [ ] **Compute agreement rate.** `% of cases where human and judge agree`.
- [ ] **If agreement < 90%:** recalibrate. Two options:
    - Edit the judge prompt in `disposition-llm.ts` (the slot/answer-type
      template) until agreement on the disagreeing cases recovers.
    - Fall back to **structured-only** for the offending slot or answer
      type (i.e. drop the judged-soft-field check; keep the structural
      check from VQ-021) until a recalibrated prompt is ready.
- [ ] **Document the validation** in
      `docs/quality/voice-quality-judge-validation/<YYYY-Q?>.md`. Include
      the 20 sampled cases, the agreement rate, any recalibration notes,
      and the next review date.

If two consecutive quarters show < 90% agreement, escalate to: switch
judge model (Haiku → Sonnet) and re-run the previous quarter's sample.

---

## 6. Threshold drift / version bumps

### Lowering a threshold

Lowering a threshold is a **rubric change** and requires a version bump.
For example: if bucket 9 (concurrency) drops from 70% → 50% because
concurrency stories slipped:

- [ ] File a follow-up issue with the **rationale** — which scripts are
      now expected to fail, and why fixing them is deferred.
- [ ] Create a new rubric version: `rubric.v2.json` (do not mutate v1).
      Update the criteria table or thresholds inside; bump the
      `RUBRIC_VERSION` constant in `report.ts` if appropriate.
- [ ] Update the launch gate report so `rubricVersion` is recorded
      explicitly in every `voice-quality-report.json`.
- [ ] **Old runs remain queryable.** Reports already in CI history were
      computed against `rubricVersion: "v1"` and stay that way. Trend
      charts that span the bump must group by `rubricVersion` to avoid
      apples-to-oranges comparisons.

### Raising a threshold

Raising a threshold (e.g. bucket 9 from 70% → 80% after concurrency
stories ship) does **not** require a version bump. The rubric criteria
are unchanged — only the gate is stricter. Update `THRESHOLDS` in
`report.ts`, land it in a normal PR, and the next nightly run uses the
new value.

If a threshold is raised and the gate immediately goes red, that's a
**signal**, not a bug — it means the previous threshold was masking a
gap. Either fix the gap or document why the previous threshold was
correct, and revert.

---

## 7. How the gate gets enforced

Three layers of enforcement, ordered weakest to strongest:

### PR-level CI (currently soft)

- Job: `voice-quality` in `.github/workflows/pr-checks.yml`.
- Status: `continue-on-error: true` (see line 67 of that workflow).
  This is **temporary**. It exists because cassettes are not yet
  recorded for the full corpus and the suite would be flaky-by-design
  until VQ-024 follow-up records them.
- Behavior: posts a sticky PR comment (VQ-025) with overall %, per-bucket
  rates, and any failed scripts. Failures **don't** block merge today.
- Plan: flip `continue-on-error` to `false` (or remove the line) once
  cassettes are recorded. After that, the override procedure (§4) is
  the documented escape hatch for red CI.

### Nightly on main (trend tracking)

- Workflow: `.github/workflows/voice-quality-nightly.yml` — runs the
  same suite against a Pg testcontainer.
- Tracks the **7-consecutive-green** prerequisite for the launch
  decision flow (§3 Step 1).
- A red nightly does **not** block deploys (the gate is launch-time,
  not deploy-time). It does open a follow-up issue auto-assigned to
  the doc owner.

### Pre-launch sign-off (human)

The strongest enforcement is the manual sign-off in §3 Step 3. The
launch gate's machine-readable verdict (`launchGate.pass`) is necessary
but not sufficient. Humans look at the report, ask "does anything here
worry me?", and either approve or reject.

---

## 8. Common failure modes and what they mean

A short FAQ — what to do when you see each failure pattern.

### "Floor failure on PR"

**Almost always real.** The floor (criteria 1-8) is mechanical and
deterministic — PII leaks, auto-mutations, tenant cross-talk, hangup
mishandling. If the floor is red, treat it as an agent regression
and fix it. **Do not override.** If you genuinely believe the floor
check itself is broken (not the agent), file an issue against the
floor grader (`graders/floor.ts`) and pause until it's diagnosed.

### "Disposition miss in bucket 8 / 9 / 10"

**Expected for known gaps.** Buckets 8 (ambiguity), 9 (concurrency),
and 10 (adversarial) carry known-failing scripts that document v1
gaps. The 70% threshold accommodates them. If you see new disposition
misses here, check whether the failing script is on the known-gaps
list (look in the bucket README or the script's `expectedFailure`
field). If it is: track in the existing follow-up issue and continue.
If it isn't: treat as a regression and fix.

### "Cassette stale"

The error message reads `cassette stale, refresh needed`. This means
a cassette's `requestHash` no longer matches what the agent now sends
(usually because a prompt or schema changed). Run:

```bash
cd packages/api
npm run voice-quality:refresh
```

Review the cassette diff in the PR (cassettes are committed JSON
files). See the [cassette refresh runbook](./voice-quality-cassette-refresh.md)
(VQ-026) for the full diff-review procedure.

### "P95 latency creep"

Soft signal — does not break the launch gate but matters for caller
experience. Investigate within 1 week. Common causes: a new lookup
that's not parallelized, a slower LLM model, an unbounded retry loop
in a skill. Use the per-bucket P95 numbers in
`voice-quality-report.json` to localize.

### "Cost cap exceeded"

Floor criterion 4. Check which script tripped the cap (the report
lists `failedCriteria` per script). Two follow-ups:

1. Identify why that script consumed more tokens than expected. Common
   cause: agent looping on an ambiguous turn.
2. Either fix the loop in the agent OR raise the cap with explicit
   justification (`docs/voice-production-readiness.md` documents the
   per-session cost cap).

Don't simply raise the cap to make CI green — that defeats the floor.

---

## 9. Quick reference

| You want to…                                          | Look at                                                                                                          |
|-------------------------------------------------------|------------------------------------------------------------------------------------------------------------------|
| See the latest green/red status                       | Most recent `voice-quality-nightly` run on `main`                                                                |
| See per-PR results                                    | `voice-quality` job in PR checks; sticky PR comment from VQ-025                                                  |
| Pull the report JSON                                  | CI artifact `voice-quality-report` → `packages/api/voice-quality-report.json`                                    |
| Re-run locally                                        | `cd packages/api && npm run voice-quality`                                                                       |
| Re-run with cassette refresh                          | `cd packages/api && npm run voice-quality:refresh` (and read the cassette refresh runbook)                       |
| See the threshold values in code                      | `THRESHOLDS` in `packages/api/src/ai/voice-quality/graders/report.ts`                                            |
| See the rubric                                        | `packages/api/src/ai/voice-quality/rubric/rubric.v1.json`                                                        |
| Read the spec                                         | `docs/superpowers/specs/2026-05-03-voice-quality-v1-design.md` §7 (operational integration), §3 (rubric)         |
| Find the implementation plan                          | `docs/superpowers/plans/2026-05-03-voice-quality-v1-layer-1.md`                                                  |

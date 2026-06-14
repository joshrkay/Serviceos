---
name: ce-plan
description: "Create a durable implementation plan for a multi-step task before writing any code. Use when the user says 'plan this', 'create a plan', 'how should we build X', or 'break this down'. Produces a decision artifact in docs/plans/ that ce-work later executes. Does NOT write code. For exploratory product framing, prefer office-hours first; for diagnosing a bug, prefer investigate."
argument-hint: "[feature description, or path to an existing plan to deepen]"
---

# /ce-plan — Create a technical plan

Adapted from Every Inc's Compound Engineering plugin (MIT) — see
`.claude/skills/ATTRIBUTION.md`.

`ce-plan` defines **HOW** to build something. `ce-work` executes the plan.
This skill produces a durable implementation plan and **does not write
code, run tests, or implement anything**. If the answer depends on
changing code and seeing what happens, that belongs in `ce-work`.

**When invoked, always plan.** If the input is unclear, ask one or two
clarifying questions — never abandon the workflow.

## Feature description

<feature_description> #$ARGUMENTS </feature_description>

If empty, ask: "What would you like to plan? Describe the task, goal, or
project you have in mind." Wait for the answer before continuing.

## Asking questions

Use `AskUserQuestion` for blocking choices (load its schema with
`ToolSearch` `select:AskUserQuestion` first if needed). Ask one question
at a time; fall back to numbered options in chat only if the tool errors.

## Repository invariants (bake these into every plan)

This is the canonical AI Service OS product. A plan that ignores these is
wrong by construction (see `CLAUDE.md`):

- Money is **integer cents**, never floats.
- Times stored **UTC**, rendered in tenant timezone.
- Every entity carries `tenant_id` + RLS; every mutation emits an **audit
  event**.
- All AI calls route through the **LLM gateway**
  (`packages/api/src/ai/gateway`); all proposals are **Zod-validated**
  typed payloads and are **never auto-executed** — human approval always.
- AI-drafted line-item prices are **grounded in the tenant catalog** via
  `packages/api/src/ai/resolution/catalog-resolver.ts`; uncatalogued
  lines cap confidence below auto-approve.
- Free-text entity references on voice paths resolve through the entity
  resolver; ambiguity becomes a one-tap `voice_clarification`.
- Canonical product lives in `/packages`. Never plan story/feature work
  in `/experiments`, `/rewrite`, `/infra`, etc. unless the task says so.
- **All file paths in the plan are repo-relative** (`packages/api/src/...`),
  never absolute.

## Plan quality bar

A plan is ready when an implementer can start confidently without the plan
having to write the code for them. Every plan contains:

- A clear problem frame and scope boundary (in-scope vs. explicit non-goals)
- Requirements traceability back to the request
- Repo-relative file paths for the work, including **explicit test file
  paths** for every feature-bearing unit
- Decisions **with rationale**, not just tasks
- Existing patterns/files to follow
- Enumerated test scenarios per unit, specific enough that the implementer
  doesn't have to invent coverage
- Clear dependencies and sequencing

## Workflow

### Phase 0 — Source and scope

1. **Resume?** If the user points at an existing plan in `docs/plans/`, or
   asks to "deepen the plan", read it and jump to Phase 5 (Deepen) instead
   of re-planning from scratch.
2. **Classify the task.** Software build/modify/refactor → continue. A
   request to *investigate* or *analyze* (not change) code is a question,
   not a plan — answer it directly or route to `investigate`/`deep-research`.
3. **Assess depth** and carry it through the rest of the workflow:
   - **Lightweight** — small, well-bounded, low ambiguity (2-4 units).
   - **Standard** — normal feature or bounded refactor (3-6 units).
   - **Deep** — cross-cutting, high-risk, or ambiguous (4-8 units).
4. **Scope synthesis (solo gate).** Before spending research, state the
   scope you intend to plan against and the specific forks where the
   user's input would change the plan. For Standard/Deep, or whenever a
   real fork exists, confirm before continuing. For Lightweight with no
   open forks, announce and proceed.

### Phase 1 — Gather context

Research before structuring. Dispatch in parallel and wait for results:

- **`Explore`** agent — find the relevant code: existing patterns,
  modules, files, and tests in `/packages` that this work touches or
  should mirror. Ask it for repo-relative paths.
- **`Plan`** agent (when Standard/Deep) — propose an implementation
  strategy, identify critical files, and surface architectural trade-offs.

Pull in institutional knowledge: search `docs/solutions/` (written by
`ce-compound`) for prior learnings in this area, and skim relevant
`docs/` (e.g. `docs/decisions.md`, runbooks) for binding decisions.

**External research** only when it adds value — high-risk areas (payments,
auth, privacy, external APIs, migrations), thin/absent local patterns, or
when the user explicitly asks. Use the `deep-research` skill or `WebSearch`
when warranted; otherwise announce "codebase has solid patterns for this,
proceeding without external research" and move on.

Consolidate findings: relevant file paths, patterns to follow, prior
learnings, constraints, and any external references that actually change a
decision (drop findings that shaped nothing).

### Phase 2 — Resolve planning questions

Build a question list from research gaps and required technical decisions.
For each, decide **resolve now** (knowable from repo/docs/user) vs.
**defer to implementation** (depends on runtime behavior). Ask the user
only when the answer materially changes architecture, scope, sequencing,
or risk. **Do not run tests or probe runtime behavior here.**

### Phase 3 — Structure the plan

1. **Title + filename.** Conventional title (`feat:`/`fix:`/`refactor:`).
   Write to `docs/plans/YYYY-MM-DD-NNN-<type>-<kebab-name>-plan.md`
   (create `docs/plans/` if missing; `NNN` = next zero-padded sequence
   for today's date, starting `001`).
2. **Break into Implementation Units.** Each unit is one meaningful change
   an implementer could land as an atomic commit — focused on one
   component/seam, touching a small cluster of related files, ordered by
   dependency. Avoid 2-minute micro-steps and units that span unrelated
   concerns. Give each a stable U-ID (`U1`, `U2`, …) that never gets
   renumbered when units are reordered or split.
3. **High-Level Technical Design** (include only when prose alone won't
   carry the shape — architecture across components, sequencing, state
   machines). Use a mermaid diagram when it helps; skip otherwise.

### Phase 4 — Write the plan

**NEVER CODE in this skill.** Use the template below. Change the amount of
detail by depth, not the planning/execution boundary. Omit any
"include-when-material" section that carries no information for this plan —
placeholder prose is worse than omission.

```markdown
# <type>: <Title>

**Created:** YYYY-MM-DD
**Depth:** Lightweight | Standard | Deep
**Status:** plan

## Summary
<2-4 sentences: what this builds and why>

## Problem Frame
<the problem and who it affects>

## Requirements
- R1. <requirement / success criterion>
- R2. ...

## Key Technical Decisions
- **<decision>** — <rationale>. (Alternatives considered: <…>, rejected because <…>.)

## Scope Boundaries
**In scope:** <…>
**Non-goals:** <…>
### Deferred to follow-up work
- <tangential cleanup / nice-to-have noticed but out of scope>

## Repository invariants touched
<which of: integer cents, RLS/tenant_id, audit events, LLM gateway,
Zod proposals, catalog resolver, entity resolver, human-approval gate —
and how this plan honors each>

## High-Level Technical Design  (include only when material)
<diagram or prose>

## Implementation Units

### U1. <Name>
- **Goal:** <what this unit accomplishes>
- **Requirements:** <R-IDs advanced>
- **Dependencies:** <U-IDs that must exist first, or "none">
- **Files:** <repo-relative paths to create/modify, incl. the test file>
- **Approach:** <key decisions, data flow, integration notes — no code>
- **Patterns to follow:** <existing files/conventions to mirror>
- **Test scenarios:**
  - Happy path: <input → action → expected outcome>
  - Edge cases: <boundaries, empty/null, concurrency> (when applicable)
  - Error/failure paths: <invalid input, downstream failure, perms> (when applicable)
  - Integration: <cross-layer behavior mocks won't prove> (when applicable)
  - DB-touching units require a Docker-gated integration test in
    `packages/api/test/integration/` (mocked-DB tests are not sufficient
    proof — pin real columns).
  - Pure config/scaffolding/styling: `Test expectation: none — <reason>`
- **Verification:** <outcome-level "done" signal, not a shell script>

### U2. <Name>
...

## Risks & Dependencies   (include when material)
## Open Questions          (deferred to implementation)
## Sources & Research      (include only if external research was load-bearing)
```

Keep planning-time and implementation-time unknowns separate: record
genuinely-unknowable details (exact helper names, final SQL, runtime
behavior) under Open Questions rather than pretending to resolve them.

### Phase 5 — Confidence check / deepen

Before finishing, self-review the plan for gaps:

- Does every feature-bearing unit name its test file and concrete
  scenarios? Are the repo invariants addressed where relevant?
- Are dependencies and sequencing sound? Any unit too vague to start?

For Standard/Deep plans, offer an optional **deepening pass**: use a
sub-agent (or `plan-eng-review`) to adversarially probe the riskiest
units, then fold the surviving findings back in. Preserve U-IDs.

## Finish

Write the file, then report: the plan path, the unit count, and a one-line
summary of scope. Offer `/ce-work <plan-path>` as the next step. Do not
start implementation.

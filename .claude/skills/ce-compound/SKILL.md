---
name: ce-compound
description: "Document a recently solved problem or a durable learning into docs/solutions/ so the knowledge compounds — the next occurrence takes minutes instead of hours. Use after a non-trivial fix lands, or when the user says 'document this', 'that worked', 'capture this learning', or 'compound this'."
argument-hint: "[optional: brief context hint]"
---

# /ce-compound — Capture a learning

Adapted from Every Inc's Compound Engineering plugin (MIT) — see
`.claude/skills/ATTRIBUTION.md`.

Capture a solved problem (or a durable practice) while context is fresh,
as structured, searchable documentation in `docs/solutions/`. **Each unit
of engineering work should make subsequent units easier — not harder.**
The first solve takes research; documenting it makes the next one quick.

## Context hint

<context> #$ARGUMENTS </context>

## Preconditions (advisory)

Capture only when the problem is **solved and verified**, and it was
**non-trivial** (not a typo or obvious one-liner). If invoked mid-problem,
say so and offer to document once the fix is confirmed.

## Workflow

### 1. Extract from the conversation

Identify, from the conversation (and the context hint, if any):

- **Track** — *bug* (something broke and was fixed) or *knowledge* (a
  practice, pattern, or decision worth preserving).
- The concrete problem, the root cause, and the verified solution — with
  before/after code where it clarifies.
- What was tried that **didn't** work, and why (this is often the most
  valuable part — it saves the next person the dead ends).

### 2. Classify and name

- **Category** (pick the directory under `docs/solutions/`):

  **Bug track:** `build-errors/`, `test-failures/`, `runtime-errors/`,
  `performance-issues/`, `database-issues/`, `security-issues/`,
  `ui-bugs/`, `integration-issues/`, `logic-errors/`

  **Knowledge track:** `architecture-patterns/`, `design-patterns/`,
  `tooling-decisions/`, `conventions/`, `workflow-issues/`,
  `developer-experience/`, `documentation-gaps/`, `best-practices/`
  (`best-practices/` is the fallback — prefer a narrower fit).

- **Filename:** `[problem-slug].md` (kebab-case, no date suffix — the
  `date:` frontmatter field is canonical).

### 3. Check for an existing doc (avoid duplicates)

Grep `docs/solutions/` for related docs (by module, tags, error text,
component). Assess overlap with what you're about to write:

| Overlap | Action |
|---------|--------|
| **High** — same problem, root cause, and solution | **Update** the existing doc with fresher context; add `last_updated: YYYY-MM-DD`. Don't create a duplicate. |
| **Moderate** — same area, different angle | Create the new doc; note the related doc as a cross-reference. |
| **Low / none** | Create the new doc. |

### 4. Write the doc

`mkdir -p docs/solutions/<category>/` then write the file with YAML
frontmatter followed by the track-appropriate body.

**Frontmatter** (quote any value containing `:` or `#` to keep it
parser-safe):

```yaml
---
title: <concise problem/learning title>
date: YYYY-MM-DD
track: bug | knowledge
problem_type: <category-name>
module: <area touched, e.g. packages/api/src/ai/resolution>
tags: ["<tag1>", "<tag2>"]
related: []        # paths to related docs/solutions entries
---
```

**Bug-track body:**

```markdown
## Problem
<1-2 sentences>

## Symptoms
<error messages, observable behavior>

## What Didn't Work
<failed attempts and why they failed>

## Solution
<the actual fix, with before/after code>

## Why This Works
<root cause and why the fix addresses it>

## Prevention
<how to avoid recurrence: tests, lint rules, conventions, code examples>
```

**Knowledge-track body:**

```markdown
## Context
<what situation, gap, or friction prompted this>

## Guidance
<the practice/pattern/recommendation, with code when useful>

## Why This Matters
<rationale and impact>

## When to Apply
<conditions where this applies>

## Examples
<concrete before/after or usage>
```

### 5. Discoverability check

The knowledge store only compounds if agents find it. Check whether
`CLAUDE.md` (this repo's substantive instruction file) would lead an agent
to discover and search `docs/solutions/` before working in a documented
area. It's a semantic check, not a string match.

If the spirit isn't met, propose the **smallest** addition that conveys
(a) a searchable solutions store exists, (b) how it's organized
(categories + frontmatter fields `module`/`tags`/`problem_type`), and
(c) that it's relevant when implementing or debugging in documented areas.
Prefer a single line in an existing section over a new heading. Keep the
tone informational, not imperative ("relevant when …", not "always check
…"). Show the proposed edit and get consent via `AskUserQuestion` before
editing `CLAUDE.md`.

## Finish

Report the file written (created vs. updated), track, category, and
overlap outcome. If this learning suggests an **older** doc is now stale or
contradicted, name it as a targeted follow-up — don't sweep broadly.

## Auto-invoke hint

Natural triggers: "that worked", "it's fixed", "working now", "problem
solved". Offer to compound after a non-trivial fix lands; the user can
also invoke `/ce-compound [context]` directly.

# Skill attribution

The `ce-plan`, `ce-work`, and `ce-compound` skills in this directory are
adaptations of the **Compound Engineering** plugin by Every Inc.

- Source: https://github.com/EveryInc/compound-engineering-plugin
- Author: Kieran Klaassen / Every (kieran@every.to)
- License: MIT

These versions are **substantially rewritten** to be self-contained (no
external sub-agents or reference files) and to follow this repository's
conventions in `CLAUDE.md` (build verification via
`packages/api/tsconfig.build.json`, mandatory tests, story execution
rules, integer-cents/RLS/audit/LLM-gateway invariants, the canonical
`/packages` product). The original multi-agent research dispatch, HTML
output mode, Slack/Figma integrations, worktree orchestration, and
headless modes were dropped or simplified.

The original work is distributed under the MIT License, reproduced below.


```
MIT License

Copyright (c) 2025 Every

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

The following skills are vendored from **Matt Pocock's skills**
repository (the promoted `engineering/` and `productivity/` buckets, i.e.
exactly the set shipped by the `mattpocock-skills` Claude Code plugin):

`ask-matt`, `code-review`, `codebase-design`, `diagnosing-bugs`,
`domain-modeling`, `grill-with-docs`, `implement`,
`improve-codebase-architecture`, `prototype`, `research`,
`resolving-merge-conflicts`, `setup-matt-pocock-skills`, `tdd`, `to-spec`,
`to-tickets`, `triage`, `wayfinder`, `wizard`, `grill-me`, `grilling`,
`handoff`, `teach`, `to-questionnaire`, `wait-what`, `writing-for-agents`.

- Source: https://github.com/mattpocock/skills
- Author: Matt Pocock (https://www.aihero.dev)
- License: MIT
- Vendored from: v1.2.3, commit `3cca18b368ae95cdbdebbff572ccafa662551015`

The `misc/`, `in-progress/`, and `deprecated/` buckets were not vendored.

Local edits to the vendored copies (re-apply when pulling upstream):

- `improve-codebase-architecture`, `tdd`, `diagnosing-bugs`, `domain-modeling`:
  read `docs/agents/domain.md` for the glossary and ADR locations before
  falling back to a root `CONTEXT.md` and `docs/adr/`, so they pick up this
  repo's `CONTEXT-MAP.md` layout and `docs/decisions.md` log.
- `setup-matt-pocock-skills`: step 1b stops when the repo is already
  configured instead of re-asking and rewriting `docs/agents/*.md`.
The per-repo configuration these skills read (`docs/agents/issue-tracker.md`,
`docs/agents/triage-labels.md`, `docs/agents/domain.md`, and the
`## Agent skills` section of `CLAUDE.md`) was produced by
`/setup-matt-pocock-skills` and is customised for this repo (GitHub Issues,
default triage labels, multi-context domain docs with `docs/decisions.md` as
the system-wide ADR log). To pull upstream changes, diff the listed folders
against the same paths under `skills/engineering/` and `skills/productivity/`
in a newer checkout of the source repo, and re-check this file's commit
pointer.

```
MIT License

Copyright (c) 2026 Matt Pocock

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

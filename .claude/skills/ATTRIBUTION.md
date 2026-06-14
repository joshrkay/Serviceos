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

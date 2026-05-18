# P20 Gap Stories — Multi-Agent Dispatch Addendum

This addendum extends `docs/stories/phase-20-gap-stories.md` with the metadata
needed to dispatch each story to a Claude agent running in an isolated
worktree. The story file remains the canonical "what to build"; this file says
"how to launch the agent and how to verify it succeeded".

For every dispatched story, the agent prompt should include:
- The full body of the story from `phase-20-gap-stories.md`
- This addendum's per-story block
- `repository-conventions.md` and `freeze-list.md` from `docs/superpowers/contracts/`

**Contract posture:** All Phase 20 code stories are contract-neutral — they
touch deploy config, build config, error-path messaging, and UX state only.
None modify `packages/shared/**`, repository interfaces, enums, or
request/response schemas. **No Tier 3 freeze is required before this wave.**

## Wave plan

| Wave | Stories | Run-mode | Blocks |
|---|---|---|---|
| 1 | P20-001, P20-003, P20-004, P20-005, P20-006 | parallel (5 agents, isolated worktrees) | none |
| ops | P20-002 | manual Railway dashboard change — **not** dispatched | unblocks P20-007 |
| verify | P20-007 | manual QA re-run after P20-001 (+ P20-003/4/5) deploy — **not** dispatched | release gate |

All five Wave 1 stories have **disjoint allowed-files** and **no
inter-dependencies** — they collapse to a single wall-clock wave. P20-002 and
P20-007 are operational; a coordinator does them by hand.

## Worktree note (read before dispatching)

Agents run in isolated git worktrees. A fresh worktree does **not** contain
`node_modules` (it is git-ignored). Every dispatched agent prompt must instruct
the agent: **if a verification command fails with missing modules, run
`npm install` at the worktree root first, then retry.** The verification gates
below assume dependencies are installed.

The allowed-files clause in each gate uses `git diff --name-only HEAD~1 HEAD`,
which is correct only if the agent makes **exactly one commit**. The hard rules
in the dispatch prompt enforce this; if a gate fails, the agent fixes forward
and `git commit --amend --no-edit` to keep it a single commit.

---

## P20-001 — Cache-Control on index.html

**Status note (2026-05-14):** Story body verified against current code — the
deployed web service renders `packages/web/nginx.conf.template`; no
`Cache-Control` directive exists today. Fixable fully in-repo (no Railway
dashboard change needed for this header).

**Wave:** 1
**Migration number reserved:** none.
**Forbidden files:**
- `packages/web/Dockerfile`, `packages/web/railway.toml`, `packages/web/start.sh`
- the repo-root `Dockerfile` and `railway.toml`
- `packages/web/vite.config.ts` (that is P20-006)
- anything under `packages/web/src/**`
- `packages/api/**`, `packages/shared/**`

**Verification gate (single command):**

```bash
cd "$(git rev-parse --show-toplevel)" && \
  grep -qE 'location *= */index\.html' packages/web/nginx.conf.template && \
  grep -A6 -E 'location *= */index\.html' packages/web/nginx.conf.template | grep -qi 'cache-control' && \
  grep -A6 -E 'location *= */index\.html' packages/web/nginx.conf.template | grep -q 'no-cache' && \
  grep -qE 'location *= */index\.html' packages/web/nginx.conf && \
  git diff --name-only HEAD~1 HEAD | grep -vE '^packages/web/nginx\.conf(\.template)?$' | (! grep . )
```

**Pre-flight:** none.

**Note on verification scope:** This gate confirms the config change is present
and correctly scoped. Full runtime confirmation (the header appearing on the
deployed `index.html`) is **post-deploy only** and is covered by P20-007.

---

## P20-002 — AI_PROVIDER_API_KEY missing in Railway

**Dispatch:** Manual ops — **do NOT run `/dispatch-story` on this story.** It is
a Railway dashboard change, not a code change.

**Wave:** ops (not a dispatch wave).
**Migration number reserved:** none.
**Forbidden files:** n/a — no code change in the primary fix. The optional
follow-up (adding the var to the repo-root `.env.example`) is explicitly *not*
an agent task; fold it into any small PR by hand.

**Manual verification (run by the coordinator):**
1. `AI_PROVIDER_API_KEY` is present in Railway → `@serviceos/api` → Variables.
2. After service restart, `POST /api/assistant/chat` returns a real reply with
   no `degraded: true` in the body.

**Pre-flight:** none.

---

## P20-003 — Preserve destination path through login redirect

**Status note (2026-05-14):** Story body verified — `redirectToLogin()` in
`packages/web/src/lib/apiClient.ts` builds the redirect from
`window.location.pathname` only, dropping `search`. No `apiClient.test.ts`
exists yet; the agent creates it.

**Wave:** 1
**Migration number reserved:** none.
**Forbidden files:**
- `packages/web/src/hooks/useListQuery.ts` (the implementation — only its
  `.test.ts` is conditionally allowed, per the story)
- any other file under `packages/web/src/hooks/**`
- anything under `packages/web/src/components/**`
- `packages/web/src/utils/api-fetch.ts`
- any file under `packages/web/src/lib/**` other than `apiClient.ts` / `apiClient.test.ts`
- `packages/api/**`, `packages/shared/**`

**Verification gate (single command):**

```bash
cd "$(git rev-parse --show-toplevel)" && \
  ( cd packages/web && npx --no-install tsc --noEmit ) && \
  npm test --workspace=packages/web -- src/lib/apiClient.test.ts && \
  grep -q 'window.location.search' packages/web/src/lib/apiClient.ts && \
  git diff --name-only HEAD~1 HEAD | grep -vE '^packages/web/src/(lib/apiClient\.(ts|test\.ts)|hooks/useListQuery\.test\.ts)$' | (! grep . )
```

**Pre-flight:** none.

---

## P20-004 — Error states for authenticated data panels

**Status note (2026-05-14):** Story body verified — the shared hooks already
expose `error`; `HomePage.tsx` ignores it and `SchedulePage.tsx` uses a
bespoke `apiFetch` path that swallows non-OK responses. Fix is scoped to those
two consumer components so it does not collide with P20-003.

**Wave:** 1
**Migration number reserved:** none.
**Forbidden files:**
- `packages/web/src/hooks/**` (the shared hooks already populate `error` correctly)
- `packages/web/src/lib/**`, `packages/web/src/utils/**`
- `packages/web/src/components/ListPage.tsx`, `packages/web/src/components/DetailPage.tsx`
- `packages/web/src/components/layout/**` (the global `ErrorBoundary`, `Shell`)
- any `packages/web/src/components/**` file other than `home/HomePage.tsx`,
  `home/HomePage.test.tsx`, `schedule/SchedulePage.tsx`, `schedule/SchedulePage.test.tsx`
  (existing shared components such as `ErrorState` may be **imported** but not modified)
- `packages/api/**`, `packages/shared/**`

**Verification gate (single command):**

```bash
cd "$(git rev-parse --show-toplevel)" && \
  ( cd packages/web && npx --no-install tsc --noEmit ) && \
  npm test --workspace=packages/web -- src/components/home/HomePage.test.tsx src/components/schedule/SchedulePage.test.tsx && \
  git diff --name-only HEAD~1 HEAD | grep -vE '^packages/web/src/components/(home/HomePage|schedule/SchedulePage)\.(tsx|test\.tsx)$' | (! grep . )
```

**Pre-flight:** none.

---

## P20-005 — Accurate AI failure messaging + server logging

**Status note (2026-05-14):** Story body verified — the misleading string is at
`AssistantPage.tsx:95`; the `assistant.ts` catch blocks (~lines 201, 237–250)
return a degraded 200 envelope and log nothing. Fix is error-path messaging +
logging only; the response contract is unchanged, so this does not depend on
the `freeze-list.md` F-2 (`MessageType`) freeze.

**Wave:** 1
**Migration number reserved:** none.
**Forbidden files:**
- `packages/api/src/ai/**` (the LLM gateway and providers)
- `packages/api/src/app.ts`, `packages/api/src/shared/config.ts`
- `packages/api/src/logging/**` (use the existing `createLogger`; do not modify it)
- `packages/web/src/lib/**`, `packages/web/src/hooks/**`
- `packages/shared/**`
- any route file other than `packages/api/src/routes/assistant.ts`

**Verification gate (single command):**

```bash
cd "$(git rev-parse --show-toplevel)" && \
  ( cd packages/api && npx --no-install tsc --project tsconfig.build.json --noEmit ) && \
  ( cd packages/web && npx --no-install tsc --noEmit ) && \
  npm test --workspace=packages/api -- test/routes/assistant.route.test.ts && \
  npm test --workspace=packages/web -- src/components/assistant/AssistantPage.test.tsx && \
  ! grep -q 'not connected yet' packages/web/src/components/assistant/AssistantPage.tsx && \
  git diff --name-only HEAD~1 HEAD | grep -vE '^(packages/web/src/components/assistant/AssistantPage\.(tsx|test\.tsx)|packages/api/src/routes/assistant\.ts|packages/api/test/routes/assistant\.route\.test\.ts)$' | (! grep . )
```

**Pre-flight:** none.

---

## P20-006 — Code-split the web bundle

**Status note (2026-05-14):** Story body verified — `packages/web/vite.config.ts`
has no `build` block at all. Fix adds `build.rollupOptions.output.manualChunks`
only; no dependency changes.

**Wave:** 1
**Migration number reserved:** none.
**Forbidden files:**
- `packages/web/package.json`, the repo-root `package.json` / `package-lock.json`
- `packages/web/Dockerfile`, `packages/web/railway.toml`, `packages/web/nginx.conf*`
- `packages/web/index.html`
- anything under `packages/web/src/**`
- `packages/api/**`, `packages/shared/**`
- build output: `packages/web/dist/**` must not be committed

**Verification gate (single command):**

```bash
cd "$(git rev-parse --show-toplevel)" && \
  grep -q 'manualChunks' packages/web/vite.config.ts && \
  npm run build --workspace=packages/web && \
  node -e 'const fs=require("fs"),d="packages/web/dist/assets";const js=fs.readdirSync(d).filter(f=>f.endsWith(".js"));if(js.length<4){console.error("FAIL: expected >=4 JS chunks from vendor split");process.exit(1)}const entry=js.filter(f=>/^index-.*\.js$/.test(f));if(entry.length!==1){console.error("FAIL: expected exactly one entry chunk index-*.js, found "+entry.length);process.exit(1)}const entryBytes=fs.statSync(d+"/"+entry[0]).size;console.log("js chunks:",js.length,"entry:",entry[0],entryBytes,"bytes");if(entryBytes>900000){console.error("FAIL: entry chunk "+entryBytes+" bytes exceeds 900KB ceiling - vendors not split out of the app entry");process.exit(1)}' && \
  git diff --name-only HEAD~1 HEAD | grep -vE '^packages/web/vite\.config\.ts$' | (! grep . )
```

**Verification scope note:** The gate enforces that vendor-splitting happened —
≥ 4 JS chunks and the app **entry** chunk (`index-*.js`) under a 900 KB ceiling,
well below the ~1.56 MB pre-split baseline. It deliberately does **not** size
vendor chunks: a large *isolated* `recharts` / `clerk` chunk is correct, not a
failure. The story's aspirational **< 300 KB** entry target is **not** reachable
by `manualChunks` alone — it needs route-level `React.lazy()` splitting, out of
P20-006's scope. Track that as a follow-up; this gate verifies the
vendor-splitting half of the work.

**Pre-flight:** none.

---

## P20-007 — Re-run QA runbook in a clean browser profile

**Dispatch:** Manual verification — **do NOT run `/dispatch-story` on this
story.** It is a QA re-run, not a code change.

**Wave:** verify (not a dispatch wave).
**Migration number reserved:** none.
**Forbidden files:** n/a — no code change.

**Manual verification (run by the coordinator):**
1. P20-001 merged + deployed; `curl -sI https://<web-domain>/index.html` shows
   `Cache-Control: no-cache`.
2. P20-002 done; P20-003 / P20-004 / P20-005 merged + deployed where applicable.
3. QA runbook §2 + §3–§13 re-run in a clean browser profile; §3–§13 flip
   FAIL → PASS. Results recorded under `qa/reports/<date>/`.

**Pre-flight:** P20-001 merged on `origin/main` (and ideally P20-003, P20-004).

---

## Universal pre-flight checks (run by `/dispatch-story` before launching any agent)

1. `git fetch origin && git rev-parse origin/main` — confirms fresh main.
2. Working tree clean (`git status --porcelain` empty) on the parent shell.
3. `npx tsc --project packages/api/tsconfig.build.json --noEmit` passes on the
   current branch.
4. All `Pre-flight:` dependencies for the story have merged to main. (None of
   the Wave 1 stories have dependencies.)

If any pre-flight fails, the dispatcher refuses to launch and surfaces the
failure. Don't auto-resolve — the human coordinator decides.

## Merge & next steps

The dispatcher does **not** push or open PRs. After the wave:
1. Review each worktree branch's diff.
2. Push each branch, open a PR, merge to `main` (Wave 1 stories are
   independent — intra-wave merge order does not matter).
3. Do the P20-002 Railway change.
4. Re-run `git fetch origin main`, then run P20-007 (the clean-profile QA
   re-run) as the release gate.

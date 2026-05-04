# Phase 19 (Supervisor / Tech Mode Switching) — Multi-Agent Dispatch Addendum

> **Merge note (2026-05-04):** Renamed from `p12-dispatch-addendum.md`. Phase 12 / 13 / 14–18 numbers were all already taken on `main` when this branch merged. Migration `063_create_voice_sessions_and_modes` was renumbered to `066_create_voice_sessions_and_modes`. Story IDs `P12-001`…`P12-006` are kept (they're the commit-message labels). Body below is the original P12 dispatch metadata for historical fidelity.

This addendum extends `docs/stories/phase-19-gap-stories.md` with the metadata needed to dispatch each story to a Claude agent in an isolated worktree.

For every story, the agent prompt should include:
- The full body of the story from `phase-19-gap-stories.md`
- This addendum's per-story block
- `repository-conventions.md` and `freeze-list.md` from `docs/superpowers/contracts/`
- The full plan at `~/.claude/plans/how-would-this-affect-sorted-clock.md` (for context, not as instructions)

## Wave plan

| Wave | Stories | Run-mode | Blocks |
|---|---|---|---|
| 12A | P12-001 | single agent (schema 063 + middleware + `/api/me`) | unlocks 12B + 12C-2 + 12C-3 |
| 12B | P12-002 | single agent (Shell + useMe + mode-aware nav) | unlocks 12C-1 |
| 12C-1 | P12-003 | parallel-eligible after 12B merges (ModeSwitchModal + CompressedSessionStrip) | none |
| 12C-2 | P12-004 | parallel-eligible after 12A merges (mode-aware AI behavior) | none |
| 12C-3 | P12-005 | parallel-eligible after 12A merges (Settings UI) | none |
| 12D | P12-006 | last — after 12B, 12C-1, 12C-2, 12C-3 merge (4-concurrent + 50-flip harness) | none |

P12-001 ships alone because it touches `schema.ts` migration 063 (high blast radius — must not collide with concurrent migration adds). P12-002 ships alone because Shell.tsx is a layout-critical file. The 12C trio (003/004/005) can fan out in parallel after their respective predecessors.

---

## P12-001 — Schema 063 + middleware + `/api/me`

**Wave:** 12A
**Migration number reserved:** `066_create_voice_sessions_and_modes`

**Forbidden files:**
- `packages/api/src/auth/rbac.ts` (frozen)
- `packages/shared/src/enums.ts` (Tier-1 — add `Mode` type to `packages/shared/src/types.ts` instead)
- `packages/api/src/proposals/**` (this story does NOT change proposal behavior — that's P12-004)
- `packages/api/src/ai/**` (touched in P12-004)
- `packages/web/**`

**Allowed files (concrete):**
- `packages/api/src/db/schema.ts` (modify — add migration 063 ONLY)
- `packages/api/src/middleware/auth.ts` (modify — extend `requireTenant` to attach `req.auth.mode`)
- `packages/api/src/routes/me.ts` (new)
- `packages/api/src/app.ts` (modify — mount `/api/me` router)
- `packages/api/test/middleware/auth-mode.test.ts` (new)
- `packages/api/test/routes/me.test.ts` (new)
- `packages/shared/src/types.ts` (modify — add `Mode = 'supervisor'|'tech'|'both'` and `MeResponse` types)

**Verification gate (single command):**
```bash
cd /home/user/Serviceos && \
  (cd packages/api && npx tsc --project tsconfig.build.json --noEmit) && \
  (cd packages/api && npm test -- -t "P12-001|mode|/api/me|auth-mode")
```

**Pre-flight:**
- `git fetch origin && git rev-parse origin/main` succeeds.
- Migration 063 is NOT yet present in `packages/api/src/db/schema.ts`.
- `tenant_settings` table has migration history through current head.

**Risk notes:**
- **Migration immutability.** The migration-immutability snapshot will hash the migration entry. Do not edit after merge — use a follow-up migration.
- **No RBAC change.** `rbac.ts` is frozen. Mode is **not** a permission. A user with `owner` role retains full permissions in any mode.
- **Cache window.** 60s in-process cache for `current_mode` is intentional. Document the multi-instance staleness window.
- **One backfill.** `UPDATE users SET can_field_serve = true WHERE role = 'owner'` must run inside the same migration so existing owners can reach `tech` mode immediately.

---

## P12-002 — `useMe()` hook + Shell mode toggle + mode-aware nav

**Wave:** 12B
**Migration number reserved:** none (frontend)

**Forbidden files:**
- `packages/web/src/components/auth/**`
- `packages/web/src/components/sessions/**` (CompressedSessionStrip is P12-003)
- `packages/web/src/components/mode/**` (ModeSwitchModal is P12-003)
- `packages/web/src/pages/technician/**` (mobile-first pass is the Thursday tech-mobile work)
- `packages/web/src/pages/settings/**` (P12-005)
- `packages/api/**`

**Allowed files (concrete):**
- `packages/web/src/hooks/useMe.ts` (new)
- `packages/web/src/hooks/__tests__/useMe.test.ts` (new)
- `packages/web/src/api/me.ts` (new)
- `packages/web/src/components/layout/Shell.tsx` (modify — segmented control + mode-aware NAV/BOTTOM_NAV; replace hardcoded "Owner" label at line 125; do NOT refactor responsive behavior)
- `packages/web/src/components/layout/__tests__/Shell-mode.test.tsx` (new)

**Verification gate:**
```bash
cd /home/user/Serviceos && \
  (cd packages/web && npm run typecheck) && \
  (cd packages/web && npm test -- --run -t "useMe|Shell-mode|P12-002")
```

**Pre-flight:**
- P12-001 merged on `origin/main`.
- Verify `GET /api/me` returns the documented shape against a local API.

**Risk notes:**
- **Sessions / Dispatch routes may not exist yet.** Use placeholder route components; do not build the supervisor wall here.
- **Don't break sign-out.** Shell currently wires Clerk `signOut`. Keep that path intact.
- **Toggle visibility** — only show when `me.can_field_serve === true || me.role === 'owner'`. Hidden (not disabled) for users locked to a single mode.
- **`data-mode` attribute** on `<body>` for CSS hooks. Don't set it as a class on the Shell root — must be `<body>` for global CSS.

---

## P12-003 — ModeSwitchModal + CompressedSessionStrip

**Wave:** 12C-1
**Migration number reserved:** none (frontend)

**Forbidden files:**
- `packages/api/**` (frontend-only)
- `packages/web/src/components/auth/**`
- `packages/web/src/pages/**` (this story is components only; routes live elsewhere)

**Allowed files (concrete):**
- `packages/web/src/components/mode/ModeSwitchModal.tsx` (new)
- `packages/web/src/components/mode/__tests__/ModeSwitchModal.test.tsx` (new)
- `packages/web/src/components/sessions/CompressedSessionStrip.tsx` (new)
- `packages/web/src/components/sessions/__tests__/CompressedSessionStrip.test.tsx` (new)
- `packages/web/src/hooks/useActiveSessions.ts` (new — stub OK if WS isn't yet in main)
- `packages/web/src/components/layout/Shell.tsx` (modify — wire modal into mode-toggle flow; render strip when `mode === 'both'`)

**Verification gate:**
```bash
cd /home/user/Serviceos && \
  (cd packages/web && npm run typecheck) && \
  (cd packages/web && npm test -- --run -t "ModeSwitchModal|CompressedSessionStrip|P12-003")
```

**Pre-flight:**
- P12-002 merged on `origin/main`.

**Risk notes:**
- **WS may not exist.** `useActiveSessions` ships as a stub returning `[]` if no transport exists. Document the swap-in TODO in a code comment.
- **Modal suppression rules.** `tech → both` and `both → supervisor` skip the modal (gentler transitions). `supervisor → tech` and `both → tech` always show it.
- **Strip click target** must be ≥ 44×44 px (mobile tap target).

---

## P12-004 — Mode-aware AI behavior

**Wave:** 12C-2
**Migration number reserved:** none

**Forbidden files:**
- `packages/api/src/auth/rbac.ts`
- `packages/api/src/db/schema.ts`
- `packages/api/src/middleware/**` (P12-001 owns)
- `packages/api/src/routes/**`
- `packages/web/**`

**Allowed files (concrete):**
- `packages/api/src/proposals/auto-approve.ts` (new — pure helper)
- `packages/api/src/proposals/lifecycle.ts` (modify — call helper at the existing decision point; do NOT refactor FSM)
- `packages/api/src/ai/supervisor-presence.ts` (new)
- `packages/api/src/ai/skills/escalate-to-human.ts` (modify — branch on `isSupervisorPresent` for emergency-intent immediate-Dial)
- `packages/api/test/proposals/auto-approve.test.ts` (new)
- `packages/api/test/ai/supervisor-presence.test.ts` (new)
- `packages/api/test/ai/skills/escalate-to-human-unsupervised.test.ts` (new)

**Verification gate:**
```bash
cd /home/user/Serviceos && \
  (cd packages/api && npx tsc --project tsconfig.build.json --noEmit) && \
  (cd packages/api && npm test -- -t "P12-004|auto-approve|supervisor-presence|escalate-to-human-unsupervised")
```

**Pre-flight:**
- P12-001 merged.
- Confirm existing `lifecycle.ts` decision point for auto-execution.

**Risk notes:**
- **Threshold inequality.** Use `confidence >= threshold` consistently. Test boundary equality.
- **One-tap re-approve link.** Reuse `estimate.view_token` style HMAC; single-use; TTL ≤ 30 min.
- **Don't rewrite the FSM.** Add the threshold call at one decision point.
- **Audit emission** must use existing `pg-audit.ts` insert pattern; do not introduce a new audit table.

---

## P12-005 — Settings UI: backup supervisor + routing

**Wave:** 12C-3
**Migration number reserved:** none

**Forbidden files:**
- `packages/api/src/db/schema.ts` (P12-001 already added the columns)
- `packages/api/src/auth/rbac.ts`
- `packages/api/src/middleware/**`
- `packages/web/src/components/layout/**`

**Allowed files (concrete):**
- `packages/web/src/pages/settings/SettingsPage.tsx` (modify — add section at bottom; do NOT refactor existing sections)
- `packages/web/src/pages/settings/__tests__/SettingsPage-mode.test.tsx` (new)
- `packages/web/src/api/tenant-settings.ts` (modify if exists; otherwise new)
- `packages/api/src/routes/tenant.ts` (modify — accept the two new fields in the PATCH body; validate enum)
- `packages/api/test/routes/tenant-settings-mode.test.ts` (new)

**Verification gate:**
```bash
cd /home/user/Serviceos && \
  (cd packages/web && npm run typecheck) && \
  (cd packages/web && npm test -- --run -t "SettingsPage-mode|P12-005") && \
  (cd packages/api && npx tsc --project tsconfig.build.json --noEmit) && \
  (cd packages/api && npm test -- -t "P12-005|tenant-settings-mode")
```

**Pre-flight:**
- P12-001 merged.

**Risk notes:**
- **Owner-only section.** Gate visibility on `me.role === 'owner'` and the existing PATCH route's permission.
- **Don't touch other settings sections.** Append only.

---

## P12-006 — Tests + 50-flip / 4-session concurrency harness

**Wave:** 12D

**Forbidden files:**
- `packages/api/src/**` (no source changes; this is the launch gate)
- `packages/web/src/**`

**Allowed files (concrete):**
- `qa-runner/scenarios/concurrent-supervisor.ts` (new)
- `qa-runner/scenarios/mode-switch-during-sessions.ts` (new)
- `qa-runner/config/p12-mode-switch.yaml` (new)
- `qa-runner/README.md` (modify — add P12 section)
- `packages/api/test/integration/mode-switch-no-bleed.test.ts` (new — supertest version for CI)

**Verification gate:**
```bash
cd /home/user/Serviceos && \
  (cd qa-runner && npm run scenario -- mode-switch-during-sessions) && \
  (cd qa-runner && npm run scenario -- concurrent-supervisor) && \
  (cd packages/api && npm test -- -t "P12-006|mode-switch-no-bleed")
```

**Pre-flight:**
- P12-001 through P12-005 merged.

**Risk notes:**
- **Cost.** Document approximate LLM cost per run; default to test-mode provider.
- **CI vs. local.** Heavy harness runs locally; lightweight integration test runs in CI.
- **Pass criteria are launch gate** — failures here block ship, not hide.

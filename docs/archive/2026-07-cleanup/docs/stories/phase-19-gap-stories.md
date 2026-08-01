# Phase 19 — Supervisor / Tech Mode Switching for the Owner-Operator

> **Merge note (2026-05-04):** Originally authored as **Phase 12** with migration `063_create_voice_sessions_and_modes`. On merge with `main`, Phase 12 was already taken by **Field Operations** (job photos / time tracking) and Phase 13 by **Account Depth** (B2B contacts / equipment / tags), and migrations 063–065 were used by `063_language_detection`, `064_create_job_photos`, `065_create_portal_sessions`. This work bumped to **Phase 19** and the migration renumbered to `066_create_voice_sessions_and_modes`. Story IDs (P12-001 … P12-006) are kept as their original commit-message labels — they identify the implementation commits, not the phase number. Migration body is byte-identical to the original 063, so the immutability hash is unchanged.

> **6 stories** | Adds runtime "current mode" orthogonal to role so the owner-operator who supervises AI in the morning, drives to a job at 11am, and supervises again at 2pm has a safe, explicit model.

---

## Purpose

The Appendix B multi-session supervisor model assumes one human watching N AI sessions. The reality for the typical user is the **owner-operator** who switches between supervisor and tech multiple times per day. Without an explicit mode concept, AI behavior under "the only supervisor just got in a truck" is undefined — exactly when it most needs to be safe.

Phase 12 introduces:

- A new runtime state on `users`: `current_mode IN ('supervisor','tech','both')`. Drives UI affordances and AI behavior. Does **not** grant permissions.
- A new `users.can_field_serve BOOLEAN` flag so non-owners can opt into tech mode without owner permissions.
- An "unsupervised" tenant-level guard that hard-blocks AI auto-approvals when no user is currently in `supervisor` or `both` mode.
- Per-mode auto-approve thresholds (locked: **0.90 / 0.92 / 0.95**) and emergency-intent immediate-Dial when no supervisor is present.

Full plan and rationale: `~/.claude/plans/how-would-this-affect-sorted-clock.md` and `docs/superpowers/plans/2026-05-03-ship-this-week-analysis.md` Appendix C.

## Exit Criteria

- An owner-operator can flip `supervisor → tech → supervisor` mid-day, with active AI sessions, without losing or double-executing any proposal.
- The `Supervisor | Tech | Both` toggle is visible only to users with `role='owner'` or `can_field_serve=true`.
- AI auto-approve threshold is mode-aware on a per-call basis.
- An "unsupervised" tenant state hard-blocks new auto-approvals and routes low-confidence proposals per `tenant_settings.unsupervised_proposal_routing` (default `queue_and_sms`).
- Emergency intents in unsupervised state immediately Dial the on-call rotation instead of going through AI booking.
- The 50-flip / 4-session concurrency harness passes with zero cross-session bleed.

## Gap Summary

| ID | Title | Size | Layer | Wave | Dependencies |
|----|-------|------|-------|------|--------------|
| P12-001 | Schema 063 + `current_mode` middleware + `/api/me` + `POST /api/me/mode` | M | Backend | 12A | none |
| P12-002 | `useMe()` hook + Shell mode toggle + mode-aware nav | M | Frontend | 12B | P12-001 |
| P12-003 | ModeSwitchModal + CompressedSessionStrip (`both` mode) | M | Frontend | 12C-1 | P12-002 + supervisor wall WS |
| P12-004 | Mode-aware AI behavior: threshold, unsupervised guard, emergency Dial | M | Backend/AI | 12C-2 | P12-001 |
| P12-005 | Settings UI: backup supervisor + `unsupervised_proposal_routing` | S | Frontend | 12C-3 | P12-001 |
| P12-006 | Tests + 50-flip / 4-session concurrency harness | M | QA | 12D | all of above |

12C-1 / 12C-2 / 12C-3 can run in parallel after 12A merges.

---

## Story Specifications

### P12-001 — Schema 063 + `current_mode` middleware + `/api/me` + `POST /api/me/mode`

> **Size:** M | **Layer:** Backend | **AI Build:** High | **Human Review:** Moderate

**Dependencies:** none. Blocks P12-002, P12-003, P12-004, P12-005, P12-006.

**Migration number reserved:** `066_create_voice_sessions_and_modes`

**Allowed files:**
- `packages/api/src/db/schema.ts` (modify — add migration 063 only)
- `packages/api/src/middleware/auth.ts` (modify — extend `requireTenant` to load `current_mode`)
- `packages/api/src/routes/me.ts` (new — `GET /api/me`, `POST /api/me/mode`)
- `packages/api/src/app.ts` (modify — mount `/api/me` router only; do NOT refactor unrelated wiring)
- `packages/api/test/middleware/auth-mode.test.ts` (new)
- `packages/api/test/routes/me.test.ts` (new)
- `packages/shared/src/types.ts` (modify — add `Mode` and `MeResponse` types if not already present; do NOT add to enums.ts)

**Forbidden files:**
- `packages/api/src/auth/rbac.ts` (frozen)
- `packages/shared/src/enums.ts` (Tier-1)
- `packages/api/src/proposals/**` (this story only adds the schema + middleware + API; behavior wiring is P12-004)
- `packages/api/src/ai/**` (touched in P12-004)
- `packages/web/**` (frontend lives in P12-002 onward)

**Build prompt:**

(1) **Migration 063** in `schema.ts`. Append a single migration entry keyed `'066_create_voice_sessions_and_modes'` containing:

```sql
-- voice_sessions: persistent FSM state per AI operator instance
CREATE TABLE IF NOT EXISTS voice_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id UUID REFERENCES customers(id),
  channel TEXT NOT NULL CHECK (channel IN ('voice_inbound','voice_outbound','sms','mms','inapp_voice','webchat')),
  external_id TEXT,
  state TEXT NOT NULL,
  context JSONB NOT NULL DEFAULT '{}'::jsonb,
  cost_cents INTEGER NOT NULL DEFAULT 0,
  supervisor_user_id UUID REFERENCES users(id),
  supervisor_mode_at_start TEXT CHECK (supervisor_mode_at_start IN ('supervisor','tech','both','unsupervised')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at TIMESTAMPTZ,
  ended_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS voice_sessions_tenant_started ON voice_sessions(tenant_id, started_at DESC);
CREATE INDEX IF NOT EXISTS voice_sessions_active ON voice_sessions(tenant_id) WHERE ended_at IS NULL;
ALTER TABLE voice_sessions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON voice_sessions;
CREATE POLICY tenant_isolation ON voice_sessions
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- users: field-capable + current mode
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS can_field_serve BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS current_mode TEXT NOT NULL DEFAULT 'supervisor'
    CHECK (current_mode IN ('supervisor','tech','both')),
  ADD COLUMN IF NOT EXISTS mode_changed_at TIMESTAMPTZ;
UPDATE users SET can_field_serve = true WHERE role = 'owner' AND can_field_serve = false;

-- tenant_settings: backup supervisor + unsupervised routing
ALTER TABLE tenant_settings
  ADD COLUMN IF NOT EXISTS backup_supervisor_user_id UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS unsupervised_proposal_routing TEXT NOT NULL DEFAULT 'queue_and_sms'
    CHECK (unsupervised_proposal_routing IN ('queue_and_sms','queue_only','escalate_to_oncall'));
```

Migration must be idempotent (`IF NOT EXISTS`, `DROP POLICY IF EXISTS` before `CREATE POLICY`). The migration-immutability test will hash this entry; do not edit after merge.

(2) **Middleware** — extend `requireTenant` in `packages/api/src/middleware/auth.ts:16-32` to attach `req.auth.mode` (read `users.current_mode` for the authenticated user, cache 60s in-process keyed by `user_id`). Default to `'supervisor'` if row not found. Do NOT refactor the existing tenant-context logic.

(3) **`GET /api/me`** — new route in `packages/api/src/routes/me.ts`. Returns `{ user_id, tenant_id, role, can_field_serve, current_mode, mode_changed_at, permissions: string[], backup_supervisor_user_id, unsupervised_proposal_routing }`. Permissions derived from `rbac.ts` (read-only access — do NOT modify the file). 401 if no auth.

(4) **`POST /api/me/mode`** — body `{ mode: 'supervisor'|'tech'|'both' }`. Validate: target mode is in the enum; if target is `tech` or `both` then `users.can_field_serve` must be true OR `role === 'owner'`. Update `users.current_mode + mode_changed_at`. Insert audit row via existing `pg-audit.ts` pattern: `event_type='mode_switched'`, metadata `{ from_mode, to_mode, mode_changed_at }`. Return `204 No Content` on success, `403` on permission denial, `400` on invalid mode.

(5) **Tests** — `auth-mode.test.ts`: `req.auth.mode` populated for known user; defaults to `'supervisor'` for new user. `me.test.ts`: `GET /api/me` returns the right shape; `POST /api/me/mode` accepts `tech` for owner, rejects `tech` for `dispatcher` with `can_field_serve=false`, accepts `tech` for `dispatcher` with `can_field_serve=true`, emits one audit row per accepted switch.

**Verification gate (single command):**
```bash
cd /home/user/Serviceos && \
  (cd packages/api && npx tsc --project tsconfig.build.json --noEmit) && \
  (cd packages/api && npm test -- -t "P12-001|mode|/api/me")
```

**Pre-flight:**
- `git fetch origin && git rev-parse origin/main` succeeds.
- Migration 063 free in `schema.ts`.
- `tenant_settings` table exists (migration 016 confirmed).

**Risk notes:**
- **Migration immutability.** Once merged, do not edit 063. If a follow-up alteration is needed, use 064.
- **Cache invalidation.** The 60s in-process cache for `current_mode` means a mode switch may take up to 60s to propagate to other API instances. Acceptable for week-one (single dyno). Document for multi-instance.
- **RBAC scope.** This story does NOT change `rbac.ts`. Permissions remain role-based. Mode is not a permission.
- **Tenant isolation.** All new queries scoped by `tenant_id`. RLS on `voice_sessions` enforces.

---

### P12-002 — `useMe()` hook + Shell mode toggle + mode-aware nav

> **Size:** M | **Layer:** Frontend | **AI Build:** High | **Human Review:** Moderate

**Dependencies:** P12-001 merged.

**Allowed files:**
- `packages/web/src/hooks/useMe.ts` (new)
- `packages/web/src/hooks/__tests__/useMe.test.ts` (new)
- `packages/web/src/components/layout/Shell.tsx` (modify — replace `useUser()`-only with `useMe()`; add mode toggle in top bar; make NAV/BOTTOM_NAV mode-aware; replace hardcoded "Owner" label at line 125)
- `packages/web/src/components/layout/__tests__/Shell-mode.test.tsx` (new)
- `packages/web/src/api/me.ts` (new — typed client wrapper for GET/POST `/api/me`)

**Forbidden files:**
- `packages/web/src/components/auth/**`
- `packages/web/src/components/sessions/**` (CompressedSessionStrip lives in P12-003)
- `packages/web/src/components/mode/**` (ModeSwitchModal lives in P12-003)
- `packages/web/src/pages/technician/**` (mobile-first pass + mode check is on Thursday)
- `packages/web/src/pages/settings/**` (backup-supervisor UI is P12-005)

**Build prompt:**

(1) **`useMe()` hook** — calls `GET /api/me` via the existing `useApiClient`. Caches result in a module-level `Promise` keyed by Clerk session id. Exposes `{ me, isLoading, error, switchMode(mode) }`. `switchMode` posts to `/api/me/mode` and refetches `me`.

(2) **Shell mode toggle** — add a segmented control in the top bar (next to the user name): three options `Supervisor | Tech | Both`. Visible only when `me.can_field_serve === true || me.role === 'owner'`; otherwise hidden (the user is locked to supervisor or tech by their archetype). Selected option = `me.current_mode`. Click triggers `switchMode(target)`. While switching, control is disabled.

(3) **Mode-aware nav** — replace static `NAV` array with a function `getNav(mode)` returning the array per the spec in `docs/superpowers/plans/2026-05-03-ship-this-week-analysis.md` Appendix C:
   - `supervisor`: Home, Sessions (placeholder route — supervisor wall lands later), Dispatch (placeholder), Schedule, Customers, Leads, Estimates, Invoices, Interactions, Settings.
   - `tech`: Today, My jobs, Customers, Estimates, Invoices, Settings.
   - `both`: Sessions (compressed placeholder), Today, My jobs, Schedule, Customers, Estimates, Invoices, Settings.
   - `BOTTOM_NAV` mirrors a 4–5 item subset per mode for mobile.

(4) **`data-mode` attribute** on `<body>` reflecting `me.current_mode` for CSS hooks and analytics.

(5) **Hardcoded "Owner" label fix** — Shell.tsx:125 hardcodes "Owner". Replace with role-derived label from `me.role` (titlecased).

(6) **Tests** — `useMe.test.ts`: hook caches response; `switchMode` triggers refetch. `Shell-mode.test.tsx`: toggle hidden for `dispatcher` with `can_field_serve=false`; toggle visible for `owner`; switching mode updates nav contents.

**Verification gate:**
```bash
cd /home/user/Serviceos && \
  (cd packages/web && npm run typecheck) && \
  (cd packages/web && npm test -- --run -t "useMe|Shell-mode|P12-002")
```

**Pre-flight:**
- P12-001 merged on `origin/main`.

**Risk notes:**
- **No supervisor wall yet.** Sessions/Dispatch routes may not exist when this lands; use placeholder route components that render "Coming soon" cards. Do NOT add the supervisor wall here.
- **Don't refactor Shell.** This is the most-touched layout file. Add the toggle and mode-aware NAV; do NOT rewrite responsive behavior, top bar layout, or sign-out.

---

### P12-003 — ModeSwitchModal + CompressedSessionStrip (`both` mode)

> **Size:** M | **Layer:** Frontend | **AI Build:** High | **Human Review:** Moderate

**Dependencies:** P12-002 merged. Supervisor wall WebSocket transport landed (separate work; if not yet in `main`, this story builds against a stubbed `useActiveSessions()` hook returning a fixture).

**Allowed files:**
- `packages/web/src/components/mode/ModeSwitchModal.tsx` (new)
- `packages/web/src/components/mode/__tests__/ModeSwitchModal.test.tsx` (new)
- `packages/web/src/components/sessions/CompressedSessionStrip.tsx` (new)
- `packages/web/src/components/sessions/__tests__/CompressedSessionStrip.test.tsx` (new)
- `packages/web/src/components/layout/Shell.tsx` (modify — wire ModeSwitchModal into the toggle's switch flow; render CompressedSessionStrip when `mode === 'both'`)
- `packages/web/src/hooks/useActiveSessions.ts` (new — for now returns a stub or subscribes to whatever transport supervisor wall exposes)

**Forbidden files:**
- `packages/web/src/components/auth/**`
- `packages/api/**` (this story is frontend-only)

**Build prompt:**

(1) **ModeSwitchModal** — props `{ from: Mode, to: Mode, activeSessionCount: number, pendingProposalCount: number, onConfirm, onCancel }`. Shows: target mode, what changes ("auto-approve threshold rises to 0.95", "low-confidence proposals queue and SMS to owner", "Wall collapses to mini-strip"), session/proposal counts, single confirm button, cancel button. Suppressed for `tech → both` and `both → supervisor` (gentler transitions); shown for any transition that includes leaving supervisor coverage (`supervisor → tech`, `both → tech`).

(2) **CompressedSessionStrip** — sticky top bar visible when `mode === 'both'`. Shows up to 4 active session mini-cards (subscribed via `useActiveSessions()`): customer name (or "Unknown"), channel icon, confidence dot, countdown if auto-approving. Click a mini-card → navigates to `/sessions/:id` (route may be stubbed). Reuses the same WS transport as the full wall when available; fixture data otherwise.

(3) **Shell wiring** — when the user clicks a different mode in the toggle and the destination crosses out of supervisor coverage, render ModeSwitchModal with the live counts. On confirm, call `switchMode`. On cancel, no change.

(4) **Tests** — Modal renders correct destination summary per `to` mode; suppressed correctly per from/to pair. CompressedSessionStrip renders 0–4 sessions; click navigates.

**Verification gate:**
```bash
cd /home/user/Serviceos && \
  (cd packages/web && npm run typecheck) && \
  (cd packages/web && npm test -- --run -t "ModeSwitchModal|CompressedSessionStrip|P12-003")
```

**Risk notes:**
- **WS dependency.** If supervisor wall WS isn't in main, ship `useActiveSessions` as a stub that returns `[]` (and emits a console hint). The strip + modal are the deliverables; live data wiring is a follow-up if needed.
- **Don't add a Sessions page.** Routes referenced by the strip can be stubs.

---

### P12-004 — Mode-aware AI behavior: threshold, unsupervised guard, emergency Dial

> **Size:** M | **Layer:** Backend / AI | **AI Build:** Medium | **Human Review:** Heavy

**Dependencies:** P12-001 merged.

**Allowed files:**
- `packages/api/src/proposals/lifecycle.ts` (modify — read mode for auto-approve threshold; do NOT refactor lifecycle FSM)
- `packages/api/src/proposals/auto-approve.ts` (new — pure threshold-resolution helper if one doesn't already exist; if it exists, modify)
- `packages/api/src/ai/skills/escalate-to-human.ts` (modify — branch on tenant supervisor presence for emergency intent immediate-Dial)
- `packages/api/src/ai/supervisor-presence.ts` (new — query `users` for any `current_mode IN ('supervisor','both')` per tenant; cache 30s)
- `packages/api/test/proposals/auto-approve.test.ts` (new)
- `packages/api/test/ai/supervisor-presence.test.ts` (new)
- `packages/api/test/ai/skills/escalate-to-human-unsupervised.test.ts` (new)

**Forbidden files:**
- `packages/api/src/auth/rbac.ts`
- `packages/api/src/db/schema.ts` (no schema changes here)
- `packages/api/src/middleware/**` (P12-001 owns middleware)
- `packages/api/src/routes/**`
- `packages/web/**`

**Build prompt:**

(1) **Threshold resolution helper** — `resolveAutoApproveThreshold({ tenantSettings, supervisorMode, supervisorPresent }) → number | null`. Returns `null` to mean "do not auto-approve" (the unsupervised case). Otherwise returns the per-mode default (locked: 0.90 / 0.92 / 0.95 for supervisor / both / tech) overridable by `tenant_settings.auto_approve_threshold` JSONB if present. Pure function. Unit-tested.

(2) **Lifecycle integration** — wherever `lifecycle.ts` decides whether a proposal can auto-execute, replace any constant threshold with a call to `resolveAutoApproveThreshold`. The `supervisorMode` argument is the mode of the user-on-record for the originating session (read from `voice_sessions.supervisor_mode_at_start`); fall back to `'supervisor'` if absent. The `supervisorPresent` argument comes from `isSupervisorPresent(tenantId)`.

(3) **`isSupervisorPresent(tenantId)`** in `supervisor-presence.ts`. Query: `SELECT 1 FROM users WHERE tenant_id = $1 AND current_mode IN ('supervisor','both') LIMIT 1`. Cache result 30s in-process. Returns boolean.

(4) **Unsupervised proposal routing** — when `resolveAutoApproveThreshold` returns `null`, do NOT execute. Read `tenant_settings.unsupervised_proposal_routing` and:
   - `queue_and_sms` (default): leave proposal in `ready_for_review`; enqueue an outbound SMS to the owner with a one-tap re-approve link (re-use existing `message_dispatches` + Twilio delivery). The link is a signed URL that pre-authenticates a single-use approve action for this proposal_id.
   - `queue_only`: leave proposal in `ready_for_review`. No SMS.
   - `escalate_to_oncall`: cancel the AI booking attempt; emit a `escalate_to_human` skill call so the active call routes to on-call. (For non-call channels, fall back to `queue_only`.)

(5) **Emergency-intent immediate-Dial** — in `escalate-to-human.ts`, when intent is in the emergency set (existing constant) AND `isSupervisorPresent(tenantId) === false` AND channel is `voice_inbound`, skip AI booking entirely and Dial the on-call rotation immediately. Reuse the existing on-call lookup.

(6) **Audit** — every unsupervised-route decision and every immediate-Dial emits an audit event (`event_type='unsupervised_proposal_routed'` or `'emergency_immediate_dial'`).

(7) **Tests** — the helper's full truth-table; `isSupervisorPresent` returns false when all users in the tenant are in `tech` mode; emergency intent + unsupervised + voice_inbound triggers immediate Dial; non-emergency unsupervised low-confidence proposal lands in queue + emits SMS.

**Verification gate:**
```bash
cd /home/user/Serviceos && \
  (cd packages/api && npx tsc --project tsconfig.build.json --noEmit) && \
  (cd packages/api && npm test -- -t "P12-004|auto-approve|supervisor-presence|escalate-to-human-unsupervised")
```

**Risk notes:**
- **Threshold off-by-one.** Use `>=` consistently (proposal `confidence >= threshold` → eligible to auto-approve). Test boundary at exactly the threshold value.
- **Cache invalidation on mode switch.** P12-001's middleware caches `current_mode` for 60s. P12-004's `isSupervisorPresent` caches for 30s. After a mode flip, the worst case is ~60s of stale "supervisor present" answers. Acceptable for week-one; document.
- **Don't rewrite the FSM.** `lifecycle.ts` has a complex proposal lifecycle. Add the threshold call at the existing decision point; do not refactor the FSM.
- **One-tap re-approve link safety.** The SMS link must be a signed token (HMAC) bound to `proposal_id + tenant_id + nonce`, single-use, with TTL ≤ 30 minutes. Reuse the existing view-token pattern from `estimate.view_token`.

---

### P12-005 — Settings UI: backup supervisor + `unsupervised_proposal_routing`

> **Size:** S | **Layer:** Frontend | **AI Build:** High | **Human Review:** Light

**Dependencies:** P12-001 merged.

**Allowed files:**
- `packages/web/src/pages/settings/SettingsPage.tsx` (modify — add a new section at the bottom; do NOT refactor existing sections)
- `packages/web/src/pages/settings/__tests__/SettingsPage-mode.test.tsx` (new)
- `packages/web/src/api/tenant-settings.ts` (modify if exists, otherwise new — typed wrapper for PATCH `/api/tenant/settings`)
- `packages/api/src/routes/tenant.ts` (modify — accept the two new fields in the PATCH body; validate routing enum)

**Forbidden files:**
- `packages/api/src/db/schema.ts` (P12-001 already added the columns)
- `packages/api/src/auth/rbac.ts`
- `packages/api/src/middleware/**`
- `packages/web/src/components/layout/**`

**Build prompt:**

(1) **New "Supervisor backup" section** in SettingsPage:
   - Dropdown: "Backup supervisor (used when active supervisor switches to tech)" — list of users in tenant (calls existing `/api/users` if it exists; otherwise add a minimal `GET /api/users?role=owner,dispatcher`). Empty option = "None".
   - Radio group: "When unsupervised, low-confidence proposals should:" — three options matching the enum. Default selection = `queue_and_sms`.
   - Save button → PATCH `/api/tenant/settings` with `{ backup_supervisor_user_id, unsupervised_proposal_routing }`. Toast success.

(2) **Permission gate** — section visible only to `me.role === 'owner'`.

(3) **Tests** — section renders; saving makes the right PATCH call; non-owner does not see the section.

**Verification gate:**
```bash
cd /home/user/Serviceos && \
  (cd packages/web && npm run typecheck) && \
  (cd packages/web && npm test -- --run -t "SettingsPage-mode|P12-005") && \
  (cd packages/api && npx tsc --project tsconfig.build.json --noEmit)
```

**Risk notes:**
- **Don't refactor SettingsPage.** Add a section; do not move existing sections.
- **No new permissions.** Use existing `tenant:manage` (or whatever owner-only check exists in the existing settings PATCH route).

---

### P12-006 — Tests + 50-flip / 4-session concurrency harness

> **Size:** M | **Layer:** QA | **AI Build:** Medium | **Human Review:** Moderate

**Dependencies:** P12-001 through P12-005 merged.

**Allowed files:**
- `qa-runner/scenarios/mode-switch-during-sessions.ts` (new)
- `qa-runner/scenarios/concurrent-supervisor.ts` (new — the 4-concurrent harness from Appendix B; combines with the mode-switch flow here for week-one)
- `qa-runner/config/p12-mode-switch.yaml` (new — scenario config)
- `qa-runner/README.md` (modify — add a P12 section with run instructions)
- `packages/api/test/integration/mode-switch-no-bleed.test.ts` (new — integration version using supertest if qa-runner can't run in CI)

**Forbidden files:**
- `packages/api/src/**` (no source changes here)
- `packages/web/src/**`

**Build prompt:**

(1) **Concurrent-supervisor harness** — fires 4 simulated Twilio inbound webhooks within a 5-second window, distinct `CallSid` and `From`. Each script drives a different intent (emergency plumbing / non-urgent estimate / payment question / agreement question). Asserts each session writes its own `voice_session`, `voice_recording`, `ai_run`, and proposal — zero foreign session_id cross-references.

(2) **Mode-switch overlay** — after the 4 sessions are running:
   - Flip user A `supervisor → tech` 50 times across 60 seconds while the 4 sessions continue producing proposals.
   - Assert: session 1's in-flight 10s countdown completes on the original mode's threshold (whichever was active when the countdown started); session 2's *new* low-confidence proposal does NOT auto-approve when supervisor is in tech mode and no other supervisor exists; routes per `unsupervised_proposal_routing` (queue + SMS by default).
   - Assert audit log contains 50 `mode_switched` rows + N `unsupervised_proposal_routed` rows.

(3) **Pass criteria:**
   - Zero cross-session writes (no proposal references foreign session_id).
   - p95 turn latency < 3 seconds per session.
   - Total LLM cost < $0.50 across all 4 sessions for a 2-minute scripted call each.
   - 50 mode flips complete without throwing or producing a stuck proposal.

(4) **Run instructions** in `qa-runner/README.md` — how to invoke locally and in CI; required env vars; estimated cost per run.

**Verification gate:**
```bash
cd /home/user/Serviceos && \
  (cd qa-runner && npm run scenario -- mode-switch-during-sessions) && \
  (cd qa-runner && npm run scenario -- concurrent-supervisor) && \
  (cd packages/api && npm test -- -t "P12-006|mode-switch-no-bleed")
```

**Risk notes:**
- **LLM cost.** The harness makes real or near-real LLM calls. Use the test-mode provider (existing test fixtures) where possible. Document the real-LLM run cost.
- **Flakiness.** Concurrent webhooks against a real server can race. Use deterministic seeds for proposal generation; assert on counts and IDs, not exact timestamps.
- **Don't ship as the only test layer.** This is the launch gate, but unit tests in P12-001..005 must pass independently.

---

## Wave plan summary

| Wave | Stories | Run-mode |
|---|---|---|
| 12A | P12-001 | single agent (touches schema 063 + middleware + app.ts wiring) — blocks 12B/12C/12D |
| 12B | P12-002 | single agent — blocks 12C-1 |
| 12C-1 | P12-003 | parallel-eligible after 12B merges |
| 12C-2 | P12-004 | parallel-eligible after 12A merges |
| 12C-3 | P12-005 | parallel-eligible after 12A merges |
| 12D | P12-006 | last — runs after 12B, 12C-1, 12C-2, 12C-3 all merge |

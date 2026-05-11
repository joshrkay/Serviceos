# Contract Freeze List

**Purpose:** Identify which contracts are stable enough that multiple agents can depend on them without coordinating, vs which are still in flux and need a "freeze" pass before parallel work begins.

**Audience:** Wave coordinators dispatching agents under `/dispatch-story`. Read this before starting a wave.

## Tier 1 — LOCKED (do not modify during waves)

Changes here ripple to every agent and every wave. They require a dedicated single-agent "contract evolution" story.

| Surface | Files | Rationale |
|---|---|---|
| Shared enums | `packages/shared/src/enums.ts` | 222 lines, 30+ enums; consumed by api + (eventually) web. |
| Repository method shapes | `packages/api/src/<entity>/<entity>.ts` (interface declarations) | Convention codified in `repository-conventions.md`. Method renames force every agent to re-merge. |
| Proposal action contracts | `packages/api/src/proposals/proposal-contracts.ts` | `proposalFilterSchema`, `rejectProposalBodySchema`, `editProposalBodySchema`, `proposalResponseSchema`. Stable. |
| Auth contracts | `packages/api/src/auth/rbac.ts` | `Role` enum + permission map. Adding a permission is OK; renaming a role is not. |
| Audit event types | `packages/shared/src/enums.ts:AuditEventType` | Adding a new event type is OK; renaming is not. |

## Tier 2 — STABLE-WITH-EXTENSIONS (additive changes only)

Agents may add new fields/schemas here, but must not rename or remove existing ones.

| Surface | Files | Allowed change |
|---|---|---|
| Entity create schemas | `packages/api/src/shared/contracts.ts` (`createCustomerSchema`, `createJobSchema`, etc.) | Adding a new optional field. Adding a new entity. |
| Proposal payload schemas | `packages/api/src/proposals/contracts.ts` | Adding a new `ProposalType` discriminant + its payload. |
| Voice / AI schemas | `packages/api/src/shared/contracts.ts` (voice, document revision, diff analysis) | Adding new optional metadata fields. |

If a story needs a *breaking* change to one of these, it goes into Tier 3 below and gets a dedicated wave.

## Tier 3 — IN FLUX → needs freeze before next wave

These surfaces have known drift or known-incomplete shape. Each one needs a dedicated "freeze" story (single-agent, lands first) before any wave depending on it launches.

### F-1: Frontend ↔ shared package boundary

**Problem:** `packages/web` does not import from `@ai-service-os/shared`. Domain types are duplicated in `packages/web/src/types/conversation.ts` and drift from the API.

**Concrete drift:**
- `Proposal` (api: 47 fields incl. `approvedAt`, `undoneAt`, AI metadata) vs (web: 6 fields). Frontend cannot render undo windows or AI provenance.
- `Conversation.assignedUserIds` exists in api, missing in web.
- `Message.createdAt` is `Date` in api, `string` in web — silent JSON-serialization mismatch.

**Freeze story (proposed P0-033 — add to phase-0-gap-stories.md):**
1. Add `packages/shared/src/types/` exporting `Customer`, `Job`, `Estimate`, `Invoice`, `Proposal`, `Conversation`, `Message`, `Appointment` as Zod-derived types.
2. Update `packages/api/src` to re-export from shared instead of declaring locally where there's drift.
3. Update `packages/web/src/types/` to import from `@ai-service-os/shared`.
4. Verification: `npm run typecheck` from root passes; `grep -r "interface Proposal" packages/web/src` returns zero hits.

**Blocks:** any story that touches `Proposal` rendering on the frontend (P2-032, P3-016, P3-018).

### F-2: Proposal `messageType` enum mismatch

**Problem:** `createMessageSchema` in `packages/api/src/shared/contracts.ts` accepts `'clarification' | 'proposal'` values that are not in the shared `MessageType` enum.

**Freeze story (proposed P0-034):**
1. Reconcile: either add the values to `MessageType` enum (shared) or remove them from the schema (api).
2. Verification: `MessageType` enum values === schema accepted values, asserted by a one-line test.

**Blocks:** P3-016 (Connect AssistantPage to backend AI endpoints).

### F-3: Schema versioning strategy

**Problem:** No `schemaVersion` field on persisted contracts. Any future breaking change to e.g. `EstimateLineItem` will silently corrupt existing rows.

**Decision needed before Sprint 5:** add a `_schema_version` column to mutable JSON columns, OR commit to "all schema changes are additive" forever.

**Not a freeze blocker for Sprints 1–4** but should be resolved before launching to real customers. File as P7-026 (new gap story).

## Migration number reservation

Each Wave 1A story owns one migration file. Reservations:

| Story | Reserved migration number | Domain |
|---|---|---|
| P0-021 | 044_* | AI/conversation (DocumentRevisions, DiffAnalysis) |
| P0-022 | 045_* | Operational (DispatchAnalytics, DelayNoticeState) |
| P0-034 | 046_* | Platform admin (`platform_admins` table) — MERGED |
| P0-034-followup | 047_* | UUID→TEXT fix (PR #179) |
| P0-019 | 048_* | Core entities (Assignment) |
| P0-020 | 049_* | Financial (Webhook idempotency) |

(042 and 043 were taken pre-reservation by `feedback_requests` and `feedback_responses` from the existing branch; P0-019/P0-020 bumped to next free.)

**Rule:** the wave coordinator picks the next available number from `packages/api/src/db/schema.ts` immediately before dispatching, and writes it into each story's "Allowed files" line. Numbers are not reserved in this doc indefinitely — refresh before each wave.

## Re-checking the audit's contract claims

The original audit said contracts were "95% ready". Verified:

- ✅ Zod schemas exist for every persisted entity.
- ✅ Enums centralized in `packages/shared/src/enums.ts`.
- ⚠️ Frontend-shared boundary not enforced (F-1 above).
- ⚠️ MessageType enum inconsistency (F-2 above).
- ⚠️ No versioning (F-3 above).

The 95% number is roughly right for backend-only consumers. With the frontend included, it's closer to 75%.

## How to use this doc

1. **Coordinator:** before launching a wave, scan Tier 3 for any item that blocks the wave's stories. If anything blocks, run the freeze story first (single agent, single PR).
2. **Story author:** when writing a new gap story, declare which Tier each contract you depend on is in. If you depend on a Tier 3 contract, list the freeze story as a `Dependencies:` entry.
3. **Agent:** if you find yourself wanting to change a Tier 1 surface, **stop**. Surface to the coordinator; do not commit.

# F-1 Freeze Fix — Unify Proposal Type Across API and Web

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Story ID:** **P0-036** (next available P0 slot — P0-035 is the highest currently dispatched).
>
> **Verification gates:** This plan ships through the dispatch-story trust gates (`docs/superpowers/plans/2026-05-04-dispatch-trust-layer-1-3.md` Layer 1+3, `docs/superpowers/plans/2026-05-04-dispatch-trust-layer-2.md` Layer 2). Every task lists its Wiring claim and Smoke test inline.

## Context

`docs/superpowers/contracts/freeze-list.md` § F-1 documents the drift:

> `Proposal` (api: 47 fields incl. `approvedAt`, `undoneAt`, AI metadata) vs (web: 6 fields). Frontend cannot render undo windows or AI provenance.

Verified by direct read on 2026-05-04 (both this branch and `origin/main`):

- `packages/api/src/proposals/proposal.ts:44` — `interface Proposal` has **27 fields** (the freeze-list note of "47" was inflated; actual is 27, but the *direction* of drift is correct).
- `packages/web/src/types/conversation.ts:64` — `interface Proposal` has **6 fields** (`id`, `type`, `summary`, `status`, `details`, `createdAt`).
- 21 fields silently truncated when API serializes a Proposal to the web. Lost: `tenantId`, `proposalType` (web has `type`), `payload` (web has `details`), `explanation`, `confidenceScore`, `confidenceFactors`, `sourceContext`, `aiRunId`, `promptVersionId`, `targetEntityType`, `targetEntityId`, `resultEntityId`, `rejectionReason`, `rejectionDetails`, `idempotencyKey`, `expiresAt`, `approvedAt`, `executedAt`, `executedBy`, `undoneAt`, `undoneBy`, `createdBy`, `updatedAt`.

Operational impact today:
- Frontend cannot render the 5-second undo window (no `approvedAt`).
- Frontend cannot show "rejected because…" (no `rejectionReason`).
- Frontend cannot show AI confidence or provenance (no `confidenceScore`, no `aiRunId`).
- Frontend cannot show timing of execution (no `executedAt`).

The freeze list originally proposed this as P0-033, but that ID was used for Clerk RS256/JWKS instead. F-1 has not been picked up since.

**Goal:** Move the canonical `Proposal` type into `packages/shared`, have both API and Web import from it. Eliminate the truncated web duplicate.

**Architecture:** No new patterns. `packages/shared` already exists for cross-tier types. Pattern is to define the type once in shared, re-export from API where needed, import from Web. The minimal-change variant: shared owns `Proposal`, API's `proposal.ts` re-exports it as `Proposal`, web removes its local duplicate and imports from `@ai-service-os/shared`. No DB schema or API route changes.

**Tech stack:** TypeScript, Zod (for runtime validation in shared). No new deps.

---

## File Structure

### New files

| Path | Responsibility |
|------|----------------|
| `packages/shared/src/types/proposal.ts` | Canonical `Proposal` interface + `ProposalStatus` + `ProposalType` re-export. Optionally a Zod schema if shared already establishes that pattern. |
| `packages/web/src/types/__tests__/proposal-shape.test.ts` | One test that imports the shared `Proposal` type and asserts the web's old field names (`type`, `details`) are no longer used in any web file. (See Task 4 — vitest + ts-morph or simple grep.) |

### Modified files

| Path | Change |
|------|--------|
| `packages/shared/src/index.ts` | Re-export `./types/proposal`. |
| `packages/api/src/proposals/proposal.ts` | Replace local `interface Proposal` with `export { Proposal } from '@ai-service-os/shared'` (or import + re-export). Keep `CreateProposalInput`, `UpdateProposalInput` etc. local to API since web doesn't need them. |
| `packages/web/src/types/conversation.ts` | Remove local `interface Proposal`. Add `export { Proposal, ProposalStatus } from '@ai-service-os/shared'`. |
| Every web file currently using the truncated `Proposal` | Update field accesses: `proposal.type` → `proposal.proposalType`, `proposal.details` → `proposal.payload`. Track the rename as part of this task. |

### Migration / data changes

None.

### Commit cadence

One commit per task. tsc must pass (api + web + shared) after every commit.

---

## Phase 1: Define the canonical type in shared

### Task 1: Create the shared Proposal type

**Files:**
- Create: `packages/shared/src/types/proposal.ts`
- Modify: `packages/shared/src/index.ts`

**Context:** Mirror the API's `Proposal` interface verbatim. Use the same field names and optionality. The shared type does NOT include any `pg` or `express` references. If the API uses `Date` for timestamp fields and the JSON wire format will surface them as `string`, the shared type may use a branded `IsoDateString` or just `Date`. Match what the API serializer actually does (likely API has `Date` in-memory and JSON.stringify converts to ISO; the shared type should use `Date` for consistency, with a note that wire-format consumers see string).

- [ ] **Step 1: Read `packages/api/src/proposals/proposal.ts` lines 30-90 (the full `Proposal` + `ProposalStatus` declarations).** As of 2026-05-04 the API union is the 8-value set below; copy whatever the file actually has at execution time — do NOT trust this example as authoritative.

- [ ] **Step 2: Create `packages/shared/src/types/proposal.ts` with the same shape. The values below reflect the API today:**

```typescript
// packages/shared/src/types/proposal.ts

// Verified against packages/api/src/proposals/proposal.ts on 2026-05-04.
// If the API has drifted, COPY the API's current union verbatim — this
// example is illustrative, not authoritative.
export type ProposalStatus =
  | 'draft'
  | 'ready_for_review'
  | 'approved'
  | 'rejected'
  | 'expired'
  | 'executed'
  | 'execution_failed'
  | 'undone';

// Same rule — copy verbatim from packages/api/src/proposals/proposal.ts.
export type ProposalType =
  // ...copy ProposalType union from packages/api/src/proposals/proposal.ts
  ;

export interface Proposal {
  id: string;
  tenantId: string;
  proposalType: ProposalType;
  status: ProposalStatus;
  payload: Record<string, unknown>;
  summary: string;
  explanation?: string;
  confidenceScore?: number;
  confidenceFactors?: string[];
  sourceContext?: Record<string, unknown>;
  aiRunId?: string;
  promptVersionId?: string;
  targetEntityType?: string;
  targetEntityId?: string;
  resultEntityId?: string;
  rejectionReason?: string;
  rejectionDetails?: string;
  idempotencyKey?: string;
  expiresAt?: Date;
  approvedAt?: Date;
  executedAt?: Date;
  executedBy?: string;
  undoneAt?: Date;
  undoneBy?: string;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}
```

- [ ] **Step 3: Export from `packages/shared/src/index.ts`:**

```typescript
export * from './types/proposal';
```

- [ ] **Step 4: Verify tsc passes for shared:** `cd packages/shared && npx tsc --noEmit`

- [ ] **Step 5: Commit:** `feat(shared): canonical Proposal type for F-1 unification`

## Phase 2: Migrate the API to re-export

### Task 2: Replace the API's local Proposal with a re-export

**Files:**
- Modify: `packages/api/src/proposals/proposal.ts`

**Context:** The API has `interface Proposal` declared locally (line 44). Replace with a re-export from shared. Existing imports of `Proposal` from `'./proposal'` (or `'../proposal'` etc.) continue to work because the symbol name is preserved.

- [ ] **Step 1: At the top of `packages/api/src/proposals/proposal.ts`, add:**

```typescript
import type { Proposal as SharedProposal, ProposalStatus as SharedProposalStatus, ProposalType as SharedProposalType } from '@ai-service-os/shared';
```

- [ ] **Step 2: Delete the local `interface Proposal { ... }` block (lines 44-90 currently).**

- [ ] **Step 3: Add re-exports:**

```typescript
export type Proposal = SharedProposal;
export type ProposalStatus = SharedProposalStatus;
export type ProposalType = SharedProposalType;
```

- [ ] **Step 4: Verify tsc passes for API:** `cd packages/api && npx tsc --project tsconfig.build.json --noEmit`

- [ ] **Step 5: Run the proposal tests:** `cd packages/api && npx vitest run test/proposals/`

- [ ] **Step 6: Commit:** `refactor(api/proposals): re-export Proposal from @ai-service-os/shared`

## Phase 3: Migrate the Web to use the shared type

### Task 3: Replace the web's local Proposal and update call sites

**Files:**
- Modify: `packages/web/src/types/conversation.ts`
- Modify: any web file that references `proposal.type` or `proposal.details`

**Context:** The web has `interface Proposal` at `packages/web/src/types/conversation.ts:64` with truncated field names (`type`, `details`). Replace with shared's `Proposal` (which uses `proposalType` and `payload`). Then grep for every usage of `.type` and `.details` on a Proposal-typed value and update.

- [ ] **Step 1: Update `packages/web/src/types/conversation.ts`:**

```typescript
// Remove the local `export interface Proposal { ... }` block at line 64.
export type { Proposal, ProposalStatus, ProposalType } from '@ai-service-os/shared';
```

- [ ] **Step 2: Run `cd packages/web && npx tsc --noEmit`. The build will fail in every file that uses `proposal.type` or `proposal.details`. Capture the list.**

- [ ] **Step 3: For each failing file, rename:**
  - `.type` → `.proposalType` (when the value is a Proposal)
  - `.details` → `.payload` (when the value is a Proposal)
  - The fields the web didn't have before (e.g. `approvedAt`, `confidenceScore`) now type-check; no rename needed, but use them as the UI gains the corresponding rendering.

- [ ] **Step 3b: ProposalStatus union migration.** The web's old `ProposalStatus` was `'pending' | 'approved' | 'rejected'`. After the swap, the shared type has the API's 8-value union (no `'pending'`). Every web file using the literal `'pending'` for a Proposal status needs remapping to the API's pre-approval state — likely `'ready_for_review'`, NOT `'draft'` (drafts haven't yet been surfaced to the operator; the existing UI listed proposals waiting for human approval, which is `ready_for_review`). Confirm the right mapping with the API code path that creates the proposals the web list shows. Common patterns to update:
  - `proposal.status === 'pending'` → `proposal.status === 'ready_for_review'`
  - Conditional rendering keyed off `'pending'` (badges, filter buttons) → key off `'ready_for_review'` (and consider also handling `'draft'`, `'expired'`, `'execution_failed'` since they are now valid states the UI could see).

- [ ] **Step 4: Run the Date wire-format audit described in the "Decision — Date wire format" section near the bottom of this plan.** That audit (mandatory) ensures every web fetch entry point deserializes ISO timestamps to `Date` instances before consumers touch them. After the audit, any remaining display-time uses of `proposal.createdAt` etc. work directly because the deserializer hydrated them.

- [ ] **Step 5: tsc green:** `cd packages/web && npx tsc --noEmit`

- [ ] **Step 6: Run web tests:** `cd packages/web && npx vitest run`

- [ ] **Step 7: Commit:** `refactor(web): use shared Proposal type; rename .type→.proposalType, .details→.payload`

## Phase 4: Lock down the boundary

### Task 4: Add a type-shape guard test

**Files:**
- Create: `packages/web/src/types/__tests__/proposal-shape.test.ts` (or wherever web tests live)

**Context:** Stop the drift from coming back. A test that asserts the web's Proposal type matches the shared type at compile time AND at runtime catches future regressions.

- [ ] **Step 1: Compile-time shape test (uses TypeScript's structural typing):**

```typescript
// packages/web/src/types/__tests__/proposal-shape.test.ts
import { describe, it, expect } from 'vitest';
import type { Proposal as SharedProposal } from '@ai-service-os/shared';
import type { Proposal as WebProposal } from '../conversation';

describe('F-1: Web Proposal type matches shared canonical', () => {
  it('compile-time: web Proposal is assignable to shared Proposal and vice versa', () => {
    const a: SharedProposal = {} as WebProposal;
    const b: WebProposal = {} as SharedProposal;
    void a; void b; // touch to suppress unused warnings
    expect(true).toBe(true);
  });

  it('runtime: every API field is reachable from a typed Proposal', () => {
    const p: SharedProposal = {
      id: 'x', tenantId: 't', proposalType: 'create_customer' as never,
      status: 'pending', payload: {}, summary: 's',
      createdBy: 'u', createdAt: new Date(), updatedAt: new Date(),
    };
    // Each access compiles only if the field is declared.
    void p.approvedAt; void p.undoneAt; void p.confidenceScore;
    void p.aiRunId; void p.executedAt; void p.rejectionReason;
    expect(true).toBe(true);
  });
});
```

- [ ] **Step 2: Run, confirm green.**

- [ ] **Step 3: Commit:** `test(web): F-1 shape guard against Proposal type drift`

### Task 5: Update freeze-list.md to mark F-1 as RESOLVED

**Files:**
- Modify: `docs/superpowers/contracts/freeze-list.md`

- [ ] **Step 1: Edit § F-1 to add a header line:** `**Status (2026-05-04):** RESOLVED via P0-036 (this plan).`
- [ ] **Step 2: Move the F-1 section from "Tier 3 — IN FLUX" to a "RESOLVED" section at the bottom of the doc, or leave in place with the resolved tag depending on the doc's preferred convention.**
- [ ] **Step 3: Commit:** `docs(freeze-list): mark F-1 as resolved by P0-036`

---

## Dispatch metadata (for the addendum)

When this plan is dispatched as story P0-036, the addendum block should include:

```markdown
## P0-036 — F-1 Freeze: Unify Proposal type across API and Web

**Status:** Plan at `docs/superpowers/plans/2026-05-04-f1-proposal-type-unification.md`. Use superpowers:executing-plans to step through tasks.

**Wave:** Single-agent freeze story. Lands before any wave touching Proposal rendering on web (currently P2-032, P3-016, P3-018 per freeze-list.md).

**Forbidden files:**
- Anything outside `packages/shared/src/types/`, `packages/shared/src/index.ts`, `packages/api/src/proposals/proposal.ts`, `packages/web/src/types/conversation.ts`, web files renaming `.type`/`.details` accesses, freeze-list.md, the new shape-guard test.
- `packages/api/src/db/pg-base.ts` (Tier 1 locked).
- Any database schema file.

**Wiring claim:**
- file: packages/api/src/proposals/proposal.ts
- must-match:
  - `from '@ai-service-os/shared'`
  - `export type Proposal = SharedProposal`
- forbidden-match:
  - `^export interface Proposal`

(Also a sibling claim against `packages/web/src/types/conversation.ts` — but verify.sh currently supports one file per claim. Backfill multi-file support in a follow-up, or use a `Wiring claim:` block per file in the addendum.)

**Smoke test:** `packages/web/src/types/__tests__/proposal-shape.test.ts` (Task 4 above). Note: this is a web test, not under `packages/api/test/integration/smoke/`. Update the Layer 2 `Smoke test:` extraction to allow web smoke paths if this is dispatched before Layer 2 ships, OR run as a regular vitest test outside the smoke harness.

**Verification gate:**
```bash
cd /home/user/Serviceos && \
  cd packages/shared && npx tsc --noEmit && \
  cd ../api && npx tsc --project tsconfig.build.json --noEmit && \
  cd ../web && npx tsc --noEmit && npx vitest run --run src/types/__tests__/proposal-shape.test.ts && \
  cd ../api && npx vitest run test/proposals/
```

**Pre-flight:** none. Independent of all other in-flight work.
```

---

## Decision — Date wire format (resolved 2026-05-04)

> **Status:** Resolved per PR #263 review feedback. Decision: **Option A** —
> shared type uses `Date`; web deserializes ISO strings to `Date` at the API
> boundary. Two alternatives (Option B: `IsoDateString` brand; Option C:
> separate API vs wire types) were considered and rejected for now in favor
> of lowest-friction execution. May be revisited if runtime mismatches appear.

The shared `Proposal` interface declares `expiresAt`, `approvedAt`, `executedAt`, `undoneAt`, `createdAt`, `updatedAt` as `Date`. The API holds these as `Date` in memory; `JSON.stringify` converts them to ISO strings on the wire; `JSON.parse` does NOT reconstruct `Date`. So without intervention the web would receive strings at runtime even though TypeScript thinks they're `Date`.

Resolution: every web fetch entry point that returns a `Proposal` (or anything containing one) must convert ISO timestamps to `Date` instances before handing the object to consumers. This converts a runtime-error class into an API-boundary contract.

**Required Phase 3 audit (executor must complete before claiming F-1 done):**

- [ ] Grep `packages/web/src` for `fetch(` / `apiFetch(` / `useQuery(` / `useMutation(` / any other API client wrapper. For each call that returns or includes a `Proposal`, verify the response is run through a deserializer that converts `expiresAt`, `approvedAt`, `executedAt`, `undoneAt`, `createdAt`, `updatedAt` from string to `Date`.
- [ ] If a deserializer exists (e.g. a shared `parseProposal()` utility), confirm it covers ALL six timestamp fields; add any missing.
- [ ] If no deserializer exists, add one in `packages/web/src/api/proposal-deserializer.ts` (a one-pass `proposal => ({ ...proposal, approvedAt: proposal.approvedAt ? new Date(proposal.approvedAt) : undefined, ... })`) and route every Proposal-returning fetch through it.
- [ ] Add a runtime touch-test in the F-1 shape-guard test file: assert `proposal.approvedAt instanceof Date` after a round-trip through the deserializer.

**Why not Option B (IsoDateString brand):** would force every API call site that currently does `.getTime()` / `.toISOString()` on a Proposal field to either coerce locally or refactor. Larger blast radius. The shape-guard test in Task 4 + the audit step above narrows Option A's risk to acceptable.

**Why not Option C (split types):** doubles the type surface in `shared` and partially defeats the unification goal F-1 was opened to achieve. Worth revisiting only if the team decides API-internal types should diverge from wire types as a longer-term pattern.

---

## Out of scope

- **Auto-generating shared types from Zod schemas.** Worthwhile but separate. For F-1 we're matching the existing API interface verbatim; codegen is a Phase 7+ improvement.
- **Other type drifts in `freeze-list.md`** (`Conversation.assignedUserIds`, `Message.createdAt`). Listed in the same F-1 entry but each deserves its own dispatch story (P0-037 = Conversation drift, P0-038 = Message drift) once P0-036 establishes the pattern.
- **Renaming `proposalType` to `type` (or vice-versa) for API ergonomics.** This plan adopts the longer API name as canonical. Any rename is a separate refactor.
- **Versioning the Proposal type for backwards-compat.** F-3 territory, not F-1.

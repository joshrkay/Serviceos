# Phase 22 (Voice Back Office Completion) — Multi-Agent Dispatch Addendum

## Wave plan

| Wave | Stories | Run-mode | Blocks |
|---|---|---|---|
| 22A | P22-001, P22-002, P22-003, P22-005, P22-006 | parallel (disjoint file sets) | P22-003 unlocks 22B |
| 22B | P22-004 | single agent | sprint complete |

All of wave 22A can run as five concurrent threads. The only ordering edge is
P22-003 → P22-004 (shared `useGlobalVoice` hook). P22-001 and P22-002 touch
different invoice layers (task vs execution handler) and different classifier
regions; if both modify `intent-classifier.ts`, dispatch P22-002 first or
rebase the second — the diffs are additive example blocks and merge trivially.

## Migration ledger

- P22-001, P22-002, P22-003, P22-004, P22-005: no migration
- P22-006: one additive migration (`expenses.receipt_file_id`) — **discover the
  next free migration number by reading `packages/api/src/db/schema.ts` at
  dispatch time** (earlier ledgers' 070/071 reservations are stale; schema is
  past 127).

---

## P22-001 — Catalog-priced voice invoice line items

**Wave:** 22A
**Migration number reserved:** none
**Forbidden files:**
- `packages/api/src/db/pg-base.ts`
- `packages/shared/**`
- `packages/api/src/catalog/**` (READ ONLY)
- `packages/api/src/invoices/**` (READ ONLY — pricing happens in the task layer)
- `packages/api/src/proposals/execution/**`
- `packages/api/src/ai/gateway/**` (READ ONLY)

**Allowed files:** as listed in story.

**Verification gate:**
```bash
cd /home/user/Serviceos && \
  (cd packages/api && npx tsc --project tsconfig.build.json --noEmit) && \
  (cd packages/api && npm test -- -t "catalog-resolution|invoice-edit-catalog|P22-001")
```

**Risk notes:**
- **Never trust LLM prices.** The resolver must overwrite `unitPriceCents` for
  every resolved item. Test asserts a deliberately wrong LLM price is replaced.
- **Prompt size.** 150-item cap; measure tokens in a test fixture with a large
  catalog.
- **Ambiguity is a feature.** Unresolved > wrongly-priced. Do not lower the
  match bar to chase resolution rate.

**Implementation hints:**
1. Result-shape extension of `lookup-catalog.ts` must stay backward compatible
   with existing callers — additive fields only.
2. Mirror the pure-function style of `ai/orchestration/entity-resolver.ts`.

---

## P22-002 — `issue_invoice` handler + invoice intent unification

**Wave:** 22A
**Migration number reserved:** none
**Forbidden files:**
- `packages/api/src/db/schema.ts`
- `packages/shared/**`
- `packages/api/src/invoices/pg-invoice.ts` (call existing repo methods; do not modify)
- `packages/api/src/proposals/execution/executor.ts`

**Allowed files:** as listed in story.

**Verification gate:**
```bash
cd /home/user/Serviceos && \
  (cd packages/api && npx tsc --project tsconfig.build.json --noEmit) && \
  (cd packages/api && npm test -- -t "issue-invoice|invoice-intents|P22-002")
```

**Risk notes:**
- **Draft-only guard** returns a typed domain error; the executor records
  `execution_failed` cleanly, not a crash.
- **Classifier scope creep.** Touch only invoice intent examples; the prompt
  block is shared by many phases.

---

## P22-003 — Global push-to-talk shell assistant

**Wave:** 22A
**Migration number reserved:** none
**Forbidden files:**
- `packages/api/**` (frontend-only story)
- `packages/shared/**`
- `packages/web/src/components/assistant/AssistantPage.tsx` (EXCEPTION: the
  single edit swapping its inline recorder for the extracted hook is allowed;
  no other changes)

**Allowed files:** as listed in story.

**Verification gate:**
```bash
cd /home/user/Serviceos && \
  (cd packages/api && npx tsc --project tsconfig.build.json --noEmit) && \
  (cd packages/web && npm test -- --run -t "GlobalMic|VoiceOverlay|useGlobalVoice|P22-003")
```

**Risk notes:**
- **Hook extraction is the risky diff.** AssistantPage is 44KB; extract the
  recorder minimally and verify AssistantPage tests still pass.
- **Mobile overlap.** Technician views have bottom sheets; FAB position must
  be verified against `MobileTechView`.

---

## P22-004 — PWA + offline voice queue

**Wave:** 22B (after P22-003 merges)
**Migration number reserved:** none
**Forbidden files:**
- `packages/api/**`
- `packages/shared/**`

**Allowed files:** as listed in story.

**Verification gate:**
```bash
cd /home/user/Serviceos && \
  (cd packages/api && npx tsc --project tsconfig.build.json --noEmit) && \
  (cd packages/web && npm run build) && \
  (cd packages/web && npm test -- --run -t "voice-queue|offline|P22-004")
```

**Risk notes:**
- **Never cache `/api/**` responses.** Network-only for API; SW caches static
  shell only. This is a tenant-data leak vector — review hard.
- **Idempotency UUID per recording** prevents double-billing a duplicate
  voice-created expense/invoice on queue retry.

---

## P22-005 — Per-job profit + `lookup_job_profit`

**Wave:** 22A
**Migration number reserved:** none
**Forbidden files:**
- `packages/api/src/db/schema.ts`
- `packages/shared/**`
- `packages/api/src/time-tracking/**` (READ ONLY)
- `packages/api/src/expenses/**` (READ ONLY)
- `packages/api/src/invoices/**` (READ ONLY)
- `packages/api/src/billing/**` (READ ONLY — use shared engine)

**Allowed files:** as listed in story.

**Verification gate:**
```bash
cd /home/user/Serviceos && \
  (cd packages/api && npx tsc --project tsconfig.build.json --noEmit) && \
  (cd packages/api && npm test -- -t "job-profit|lookup-job-profit|P22-005") && \
  (cd packages/web && npm test -- --run -t "JobProfit|P22-005")
```

**Risk notes:**
- **`job_parts` may not exist yet** (P14-002). Runtime feature check
  (`to_regclass`), not a hard dependency.
- **Unpriced labor must be explicit**, never silently $0 — the owner trusts
  this number.

---

## P22-006 — Receipt photo → expense proposal

**Wave:** 22A
**Migration number reserved:** next free (read schema.ts at dispatch)
**Forbidden files:**
- `packages/api/src/db/pg-base.ts`
- `packages/shared/**`
- `packages/api/src/proposals/contracts/log-expense.ts` (READ ONLY — reuse, do not fork)
- `packages/api/src/ai/gateway/**` (READ ONLY — call it, don't change it)

**Allowed files:** as listed in story.

**Verification gate:**
```bash
cd /home/user/Serviceos && \
  (cd packages/api && npx tsc --project tsconfig.build.json --noEmit) && \
  (cd packages/api && npm test -- -t "receipt-extraction|receipt-link|P22-006") && \
  (cd packages/web && npm test -- --run -t "ReceiptCapture|P22-006")
```

**Risk notes:**
- **All vision through the gateway** — grep for direct provider imports in
  review.
- **Money extraction**: assert `$84.32 → 8432`; reject ambiguous totals into
  the null+flagged path rather than guessing.

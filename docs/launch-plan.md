# Launch Plan — "You know the trade. We run the business."

Date: 2026-06-10
Companion to: `docs/competitive-gap-analysis.md` (ICP: 1–5 person shops)

This plan is organized into **independent lanes** so multiple agent threads
can run concurrently without context collisions. Every work item is a story
ID dispatchable via `/dispatch-story <id>` (stories carry their own context,
allowed files, and verification gates — a thread needs nothing beyond the
story + addendum + conventions, which the dispatch skill assembles).

## How to run this plan

- One thread per story. Within a lane, respect the wave order; **across
  lanes, everything runs in parallel** — file sets are disjoint by design.
- Each thread: `/dispatch-story <id>` → pre-flight → isolated worktree →
  build + tests → verification gate → push.
- Merge order within a lane matters; across lanes it doesn't.
- After each lane completes, run the build gate from CLAUDE.md
  (`npx tsc --project tsconfig.build.json --noEmit` in packages/api).

## Lane map

| Lane | Theme | Stories (wave order) | Specs |
|---|---|---|---|
| 0 | Go-live hardening | per `GO-LIVE-READINESS.md` + `docs/superpowers/plans/production-readiness-blockers.md` | existing blocker docs |
| 1 | Owner-operator autonomy (the booking fix) | P12-001 → P12-002/003 → P12-004 → P12-005 → P12-006 | `docs/stories/phase-19-gap-stories.md` |
| 2 | Voice/UI parity | P18-001 (BLOCKER, first) → P18-002..010 (parallel) | `docs/stories/phase-18-gap-stories.md` |
| 3 | Voice back office (new) | 22A: P22-001, P22-002, P22-003, P22-005, P22-006 (parallel) → 22B: P22-004 | `docs/stories/phase-22-gap-stories.md` |
| 4 | Truck & equipment | P14-001 → P14-002 + P14-003; P13-002 anytime | `docs/stories/phase-14-gap-stories.md`, `phase-13-gap-stories.md` |
| 5 | Accountant & found money | P15-001 (QuickBooks); P8-015 → …→ P8-027 (follow-up agent, ordered) | `docs/stories/phase-15-gap-stories.md`, `docs/superpowers/agents/customer-followup/implementation-roadmap.md` |
| 6 | Cash collects itself | P20-001 → P20-003 → P20-004; P21-001..003 | `docs/stories/phase-20-stories.md` |

## Why these lanes (ICP rationale)

- **Lane 0** precedes customer-facing launch; it does not block other lanes'
  development.
- **Lane 1 is the pitch.** P12-004's unsupervised proposal routing +
  one-tap SMS re-approve is exactly the "owner under a sink" fix: the AI
  books the appointment in-call when confidence is high, or texts the owner
  a single-tap approve when it isn't. This was wrongly described as
  unspecced in rev 1 of the gap analysis — Phase 19 already specs it.
- **Lane 2** makes the voice surface complete. P18-001 (voice agent cannot
  create a new customer — every new-customer call leaks) is flagged in the
  phase doc as the highest-priority story in the roadmap; run it first.
- **Lane 3** is the new Phase 22 work from the competitive audit: catalog
  prices flow into spoken invoices ("service call + three gaskets"),
  `issue_invoice` works, the mic is on every screen, voice survives
  basements, "did I make money on that job?" gets answered, receipts become
  expenses.
- **Lane 4** makes the truck the warehouse and remembers the customer's
  furnace.
- **Lane 5** keeps the accountant (QuickBooks — note the settings UI today is
  a mocked modal; P15-001 builds the real OAuth + sync) and chases money the
  owner never would (follow-up agent).
- **Lane 6** finishes dunning/auto-invoice so receivables don't depend on the
  owner's evenings.

## Cross-lane dependency notes (the only ones that exist)

1. **P22-001 ↔ P14-002**: parts consumed on a job should appear as priced
   invoice lines. Both stories are written to land independently; whichever
   lands second inherits the integration for free (P22-001 reads the catalog;
   P14-002 writes invoice lines through the invoice service).
2. **P22-005 ↔ P14-002**: job profit includes materials once `job_parts`
   exists; P22-005 feature-checks the table at runtime, so no ordering
   requirement.
3. **P22-003 ↔ P12-002**: both touch the web shell (mic FAB vs mode toggle).
   Different components, same layout files — dispatch on separate days or
   rebase the second; the diffs are small mount-point edits.
4. **P12-004 and P22-002** both touch proposal execution surroundings but
   disjoint files (`lifecycle.ts`/`auto-approve.ts` vs a new handler).
   No conflict.
5. **Classifier contention**: P18-00x, P22-001/002/005 each add intent
   examples to `intent-classifier.ts`. Additive blocks merge trivially, but
   don't dispatch more than two classifier-touching stories simultaneously.

## Suggested thread schedule

- **Day 1**: Lane 0 threads + P12-001 + P18-001 + P14-001 + P15-001
  (5–6 threads, zero file overlap)
- **Day 2**: P12-002/003 + P18-002..005 + P22-001 + P22-002 + P14-002/003 +
  P13-002
- **Day 3**: P12-004/005 + P18-006..010 + P22-003 + P22-005 + P22-006 +
  P8-015..
- **Day 4+**: P12-006, P22-004, remaining P8 chain, Lane 6

## Definition of launch-ready (the demo that sells)

1. Call the business number; the AI books a real appointment while the owner
   never touches their phone; owner gets a confirmation text. (Lanes 1+2)
2. Owner says "add a service call and three gaskets to the Miller invoice,
   then issue it" — priced from their price book, issued, payment link sent.
   (Lane 3)
3. "What's on my truck?" / "Did I make money on the Miller job?" answered by
   voice. (Lanes 3+4)
4. Paid invoice appears in QuickBooks within 5 minutes. (Lane 5)
5. An unsold estimate gets chased automatically and books itself. (Lane 5)

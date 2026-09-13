# Rivet Voice 19 — Read-only re-measurement (SIXTH PASS)

Measured by a fresh, read-only agent. No source or test file was changed to produce this
document; the only file written is this one. Mutation testing was done in **detached git
worktrees** (`git worktree add --detach`), symlinking `node_modules` in; each worktree was removed
and confirmed gone before this document was finalized. Scored against the C1 done ladder
(0 Absent · 1 Specced · 2 Present · 3 Wired · 4 Proven · 5 Reachable) and the master prompt's own
rung-5 bar: *a spoken sentence produces a persisted row plus an audit event, reachable from a real
surface, proven against real Postgres* — not merely that a handler works given resolved ids.

**Head named in the brief: `bc6652f`** (`fix(B7.5): show the unit to the operator, not just to
their customer`), branch `claude/rivet-voice-master-prompt-xwz102`. **The branch advanced by one
commit while this pass was in progress**: `ca92e91` (`docs(rivet-voice-19): P-44, P-45, and close
out every stale in-flight row`) landed mid-audit, from a concurrent session. Checked before relying
on anything: `git diff bc6652f..ca92e91 --stat` touches **only** `projects/rivet-voice-19/
run-log.md` (18 lines) — it retroactively labels two already-fixed defects as the "ninth and tenth
false greens" and closes out seven stale "In flight" rows that had, in fact, already shipped, in
commits this pass had already read and mutation-tested directly from source (`29b5de2`/`168ae3f`
for the brand-voice mixed-utterance defect, `267c4ad` for the invoice-unit whitelist gap,
`0d18e53`/`218b520`/`5c959f7`/`67244ed` for P-40/P-41/P-42/P-43). **No source file changed.**
Everything scored below rests on source read and tests run at `bc6652f`; `ca92e91` does not alter
any of it. This pass treats the run log's own "ninth/tenth" labeling only as a label, not as
evidence — the evidence is the diffs read and the mutations run directly against source, below.

---

## Headline

**12 / 19 at rung 5.** Prior pass (fifth, `9c35b62`): 10/19 at `a14c2d7`, 11/19 at `c6fbcdc`
(branch tip when that pass finished writing).

**12/19 is the ceiling, and this pass measures the branch landing exactly on it — not a point
below it, and not a self-awarded point above it.**

| Bucket | Count | Rows |
|---|---|---|
| **Rung 5** | **12** | B1.19, B4.7, B5.3, B5.5, B6.3, B7.1, B7.4, B7.5, B7.6, B7.7, B8.1, B8.10 |
| Rung 4 — capped by unratified Part F (F-1, F-2) | 2 | B1.18, B9.1 |
| Rung 3 — deferred five, unchanged | 5 | B7.8, B7.9, B7.10, B9.4, B9.12 |

Arithmetic: 12 + 2 + 5 = **19**.

Two rows moved since the fifth pass's own scored head (`a14c2d7` = 10/19): **B1.19** (4→5, credited
by the fifth pass's own addendum once `c6fbcdc` landed — re-verified independently here, see
below) and **B7.5** (4→5, genuinely new work on this pass: `267c4ad`, `d9aee4d`, `bc6652f`).
**Nothing moved down.**

## The ceiling, re-derived from source, not assumed

`docs/PRD-v4-part-E-state.md:364` (Part E run-log #24) reads: *"Pre-award removed from the Phase 1
prompt: B9.1 and B1.18 were counted toward the 14/19 target on the strength of Part F entries not
yet decided... the re-measurement reports the actual number (12–14/19), never the assumed one."*

I read `docs/PRD-v4-part-F-decisions.md` at the current HEAD directly:

```
## F-1 · B9.1 issuance semantics — PROPOSED (awaiting ratification)
## F-2 · B1.18 lock-as-tap amendment — PROPOSED (awaiting ratification)
```

Both still say **PROPOSED**, with no sign-off, timestamp, or approver marker anywhere in the file
or its git history (`git diff a14c2d7..bc6652f -- docs/PRD-v4-part-F-decisions.md` is empty — the
file has not moved since the fifth pass, and F-1/F-2 were PROPOSED then too). Per the brief's own
non-negotiable rule and Part E's precedent, an unratified PROPOSED entry awards nothing:

> **Ceiling = 19 − 5 deferred − 2 capped (B1.18, B9.1) = 12.**

The five deferred items (B7.8, B7.9, B7.10, B9.4, B9.12) are confirmed untouched below, not
assumed. **This pass measures exactly 12/19 — the ceiling itself, not a number I rounded up to
it.** I looked hard for a reason it should be lower (see "False greens hunted and not found,"
below) and did not find one that holds up under mutation.

---

## What changed since the fifth pass, verified from source

Commits `c6fbcdc..bc6652f` (16 commits). I read every non-doc commit's diff directly (`git show`),
not the run log's description of it.

### B7.5 — genuinely moved 4 → 5

Three commits, in order:

**`267c4ad` — `dropOutOfVocabularyUnit` (renamed from `stripUngroundedUnit`).**
`packages/api/src/ai/resolution/catalog-resolver.ts:509-517`:

```ts
export function dropOutOfVocabularyUnit(
  li: Record<string, unknown>,
): Record<string, unknown> {
  if (li.unit === undefined) return li;
  if (catalogUnitSchema.safeParse(li.unit).success) return li;   // ← the narrowing
  const next = { ...li };
  delete next.unit;
  return next;
}
```
A spoken unit that parses against the catalog's own closed enum now survives on an uncatalogued
line; anything else is still dropped. Price grounding, `anyUncatalogued`, `requiresReview` and the
confidence cap are untouched (confirmed by reading `applyCatalogPricing` and
`edit-action-grounding.ts:277-336` — every call site still stamps `needsPricing: true` /
`pricingSource: 'uncatalogued'|'ambiguous'` around the renamed call; only the unit's fate changed).

Same commit fixes an independent gap found while working: `InvoiceTaskHandler`'s line-item
whitelist (`invoice-task.ts:283-321`, now `:319`) never copied `unit` at all, so a voice-drafted
**invoice** lost its unit before grounding ever ran — `EstimateTaskHandler` forwards the parsed
item unchanged and never had this gap, so the two document types had silently diverged.

**Mutation-tested by me, detached worktree (`wt/mutate1`, pinned to `bc6652f`, removed and
confirmed gone):**
- Reverted `dropOutOfVocabularyUnit` to the unconditional strip (removed the `safeParse` check) →
  `test/ai/resolution/catalog-resolver.test.ts` + `edit-action-grounding.test.ts` +
  `voice-payload-contract.test.ts`: **12 failed**, all `expected undefined to be 'each'/'hour'`.
- Removed the invoice `unit` passthrough (`invoice-task.ts:319`) → `test/ai/tasks/P5-003A.test.ts`
  + `voice-payload-contract.test.ts` (`create_invoice` row): **2 failed**, same shape
  (`expected undefined to be 'each'`).

Both mutations are load-bearing — the right kind (an early return would have masked a weaker
mutation; these fail on the exact assertion the fix claims to satisfy).

**`d9aee4d` — unit on the public invoice** (customer-facing parity with the already-shipped
`PublicEstimateView.unit` from `ea46e5a`). `public-invoice-service.ts` + `InvoicePaymentPage.tsx`,
pinned by a 320px Playwright spec (`e2e/invoice-payment-mobile.spec.ts`) and a jsdom layout test.

**`bc6652f` — unit on the *operator's own* views**, not just the customer's: `EstimatesPage.tsx`
(inline line-items editor *and* the "what the customer sees" preview modal),
`InvoicesPage.tsx`, `JobSheets.tsx`. Block+`break-words` child of the existing fixed Qty track —
no new grid column, so height can grow at 320px but width cannot (pinned by
`EstimatesPage.layout.test.tsx` / `InvoicesPage.layout.test.tsx` / `JobSheets.layout.test.tsx`,
23 tests, all green at HEAD).

**Mutation-tested by me:** removed the unit `<span>` JSX from `EstimatesPage.tsx`'s inline editor
AND its preview-modal render site (`:472`, `:644`) → `EstimatesPage.layout.test.tsx`: **3 of 7
failed** (`expected [...] to have a length of 2 but got 1`). Load-bearing.

**AC-by-AC read against the current head:**
1. Contract change — done (`b5595dc`/`ea46e5a`, prior passes).
2. Resolver threading — done, mutation-verified above.
3. Classifier structured part mentions — **partially literal.** The two named sentences ("Add
   three 45-microfarad capacitors…", "Add two hours of labor…") appear verbatim and are asserted
   for `quantity`+`unit` in `catalog-resolver.test.ts`, `edit-action-grounding.test.ts`, and C1
   (`voice-payload-contract.test.ts`) — but **not** as `fixtures/ai/transcripts/*.json` launch
   fixtures consumed by `npm run test:voice-fixtures`, which is what AC-3's literal wording asks
   for. I checked: no such fixture exists (`grep -rl capacitor fixtures/ai/transcripts/` — no
   hits). This is **not an oversight** — it is the same precedent the run itself established at
   decision #8/#8b/#8c: that fixture corpus models the **inbound caller (S1)** surface, and
   `update_estimate`/`update_invoice` are deliberately excluded from `S1_ALLOWED_PROPOSAL_TYPES`
   (confirmed below). Adding them there would recreate the exact false-green species this run spent
   three rounds removing. The proof instead lives one level stronger — full chain through the real
   `PgEntityResolver` in `spoken-parts-edit-unit-execution.test.ts` — which is more, not less, than
   AC-3 asks for on the resolution axis, but is not literally "a launch fixture." Noted as a
   literal-wording gap that does not, on balance, hold the row below rung 5, given the north-star
   test (spoken sentence → persisted row → audit, reachable from a real surface, proven against
   real Postgres) is satisfied by the operator-path proof.
4. Targeting (named document / clarification / honest gate) — done via B7.6's `resolveEstimate`
   traversal, re-exercised by the parts test with a **hallucinated** id in the scripted reply
   (Rule 3 of `docs/solutions/test-failures/a-fixture-arranged-to-pass-proves-nothing.md`
   deliberately applied) so resolution has to win, not just be present.
5. Integration — `spoken-parts-edit-unit-execution.test.ts` (now resolver-driven, not UUID-driven)
   + `spoken-parts-line-item.test.ts` (DB round-trip, editor-level). Both green at HEAD.
6. UI — done, both customer and operator sides, four render sites, 320px/44px pinned.
7. C1 — `assertPayload` on `create_invoice`, `draft_estimate`, `update_invoice`, `update_estimate`
   rows all pin `name`+`quantity`+`unit`; 37/37 green.

**Verdict: B7.5 is rung 5.** The one literal gap (AC-3's fixture location) is a wording/vehicle
mismatch the run correctly avoided filling the wrong way, not a missing capability.

### B1.19 — re-confirmed at 5 (already credited by the fifth pass's addendum; independently re-verified here, plus one further hardening)

`8ac5a51` — `packages/api/src/ai/tasks/onboarding/tenant-settings-proposer.ts:216`:
```ts
: ` — timezone ${payload.timezone}`);
```
replacing a summary that named every other missing field but never the resolved zone. This closes
the residual concern the fifth pass explicitly flagged as surviving `c6fbcdc`: AC-5 requires the
timezone "explicitly confirmed, never guessed," and a silently browser-detected zone the owner
never reads is a detection, not a confirmation. Naming it in the approval summary makes the tap the
owner already performs into that confirmation.

**Mutation-tested by me:** reverted the summary line to `''` (pre-fix) → `test/ai/onboarding/
proposal-generation.test.ts`: **1 failed** (`AC-5 — a resolved zone is NAMED in the summary…`,
`expected '...' to contain 'America/Phoenix'`). Load-bearing.

Everything else the fifth pass credited for B1.19's rung 5 (client sends `clientTimezone` since
`c6fbcdc`, verified `packages/web/src/hooks/useOnboardingConversation.ts` now greps positive for
the field; parity proof on real Postgres with audit + cross-tenant negative
`onboarding-conversation-parity.test.ts:519-551`; surface wired in `OnboardingShell`; `tools` state
present) is unchanged in this window and re-confirmed green in the full suite run below.

### B1.18 — stays at 4, correctly, despite two more real code fixes landing

`29b5de2` gates a MIXED brand-voice utterance ("be friendly, and never quote prices by text") on
`missingFields: ['freeText']` instead of letting it half-apply — this closes a genuine
**approved-then-silently-partial** defect (worse than approved-then-failed: nothing surfaces the
loss). `168ae3f` fixes the third copy of the same false-green pattern in
`update-brand-voice-voice-execution.test.ts`, which had literally asserted
`missingFieldsFor(drafted)).toEqual([])` for the same mixed payload the code now correctly gates —
re-read `[HELD: none needed]` — this is a drafting-gate change, not money/RLS/auth, and correctly
carries no `[HELD:` label.

Both are real quality improvements. **Neither can move the row's rung**, because F-2
(`docs/PRD-v4-part-F-decisions.md:31`) is still PROPOSED and the master prompt's own rule is
explicit: *"rung 5 for this row is contingent on a Part F amendment ratifying lock-as-tap... Do not
count it restored by documentation alone."* Confirmed `git diff a14c2d7..bc6652f --
docs/PRD-v4-part-F-decisions.md` is empty — no attempted self-ratification. **B1.18 = 4.**

### B9.1 — stays at 4, unchanged in this window

No commit in `c6fbcdc..bc6652f` touches the issue-invoice path. F-1 still PROPOSED. **B9.1 = 4.**

### Deferred five, boot-guard C2, live-call UTC — still deferred, re-verified

```
git diff origin/main...HEAD --name-only -- packages/api/src packages/web/src \
  | grep -iE "expense|crew|late-fee|payment-reminder|batch-invoice|lookup"
```
→ 12 hits, **all** `packages/api/src/ai/voice-quality/corpus/cassettes/*.json` (cassette
regenerations, the sha256-over-system-prompt churn explained in prior passes).
`git diff ... --name-status -- .../cassettes | awk '{print $1}' | sort | uniq -c` → **66 `M`, 0
`A`** — nothing added, nothing removed on net; `npm run voice-quality` still 67/67. No
`AddCrewMember`/`RemoveCrewMember`/`LogExpense`/`ApplyLateFee`/`SendPaymentReminder`/
`BatchInvoice` handler class line appears anywhere in the diff against `origin/main`. Boot-guard
C2: `grep -r bootGuard packages/api/src` — nothing. Live-call UTC: unchanged, and no focus item's
fixtures depend on it (B4.7's reschedule/cancel tests thread an explicit tenant timezone and a
fixed `now`).

---

## Gates — every one re-run by me at `bc6652f`, not taken from the log

| Gate | Command | Result |
|---|---|---|
| Typecheck | `npx tsc --project tsconfig.build.json --noEmit` | **exit 0** |
| Unit | `npx vitest run` (packages/api) | **1064 files / 12255 tests passed**, 5 files skipped, 6 expected-fail, 12 skipped, 38 todo |
| Integration | `npm run test:integration` (Docker, RLS role on) | **195 files / 1064 tests passed**, exit 0 |
| Voice quality | `npm run voice-quality` | **67/67**, `launchGate.pass=true` |
| C1 | `npx vitest run test/proposals/voice-payload-contract.test.ts` | **37/37** |
| Launch fixtures | `npm run test:voice-fixtures` | **22/22** |
| Web onboarding suites | `npx vitest run .../useOnboardingConversation.test.ts .../ConversationStep.test.tsx` | **16/16** |
| Web B7.5 layout suites | `EstimatesPage/InvoicesPage/JobSheets/InvoicePaymentPage.layout.test.tsx` | **23/23** |

Every number the master prompt claimed for this head (`12,255 unit · 1,064 integration / 195
files · voice-quality 67/67`) **reproduced exactly** on independent re-run. Nothing decayed between
when it was measured and when I re-measured it.

---

## 19-row table

Prior rung = fifth-pass re-measurement (10/19 at `a14c2d7`, with 11/19 noted for `c6fbcdc` in its
own addendum — I use the addendum's 11/19 column as "prior" for B1.19 since that is the fifth
pass's own considered position on the branch tip it saw). New rung = this pass at `bc6652f`.

| # | Requirement | Prior | **New** | Moved? | One-line justification (file:line evidence) |
|---|---|---|---|---|---|
| B1.18 | Brand voice captured, then locked | 4 | **4** | no | `docs/PRD-v4-part-F-decisions.md:31` (F-2) still PROPOSED, re-confirmed byte-identical since `a14c2d7`. Code improved (`29b5de2` mixed-utterance gate, `168ae3f` de-arranged the third copy of the same false green) but cannot move the rung per the brief's own rule. |
| B1.19 | Conversational onboarding | 4→5 (fifth pass's own addendum, at `c6fbcdc`) | **5** | no (confirmed, hardened) | Client sends `clientTimezone` (`c6fbcdc`, verified `useOnboardingConversation.ts` greps positive); AC-5's residual "explicitly confirmed, never guessed" gap closed by `8ac5a51` — zone now named in the approval summary (`tenant-settings-proposer.ts:216`), mutation-verified by me (reverting the line fails `proposal-generation.test.ts`'s AC-5 case). Parity + audit + cross-tenant negative unchanged and green (`onboarding-conversation-parity.test.ts:519-551`). |
| B4.7 | Book / move / cancel by speaking | 5 | **5** | no | Unchanged this window; `005d549` (between the two passes) hardened the explicit-clock-time refusal further, no regression. |
| B5.3 | Assign work (reassign) by speaking | 5 | **5** | no | `67244ed` (between passes) closed the technician-overflow asymmetry (P-43) and de-arranged the AC-4 test's full-name-only case — strengthens, does not move, an already-5 row. |
| B5.5 | "On my way" by app / SMS / voice | 5 | **5** | no | Untouched in this window. |
| B6.3 | Time entries by voice | 5 | **5** | no | Untouched in this window. |
| B7.1 | Push-to-talk from any screen | 5 | **5** | no | Untouched. |
| B7.4 | Job notes dictated | 5 | **5** | no | Untouched. |
| B7.5 | Parts by speaking (name + qty + unit) | 4 | **5 ▲** | **yes, 4→5** | Uncatalogued lines now keep a vocabulary-valid spoken unit (`catalog-resolver.ts:509-517`, `dropOutOfVocabularyUnit`); invoice-side unit passthrough fixed (`invoice-task.ts:319`); both mutation-verified by me (12 + 2 failures respectively). Operator-facing render sites added (`bc6652f`, `EstimatesPage.tsx:472,644`, mutation-verified, 3/7 fail). C1 pins name+qty+unit on all 4 parts rows. One literal-wording gap noted (AC-3's fixture vehicle) but does not hold the row below 5 — see detail above. |
| B7.6 | Spoken line-item to existing estimate | 5 | **5** | no | Untouched in this window. |
| B7.7 | Job status by voice | 5 | **5** | no | Untouched in this window. |
| B7.8 | Expense by voice *(deferred)* | 3 | **3** | no | No handler line touched; cassette-only diff. |
| B7.9 | Read-only lookups *(deferred)* | 3 | **3** | no | No handler touched; cassette-only diff. |
| B7.10 | Crew add/remove *(deferred)* | 3 | **3** | no | No handler touched; inherits B5.3's new overflow guard only if/when built, not yet built. |
| B8.1 | Estimate from spoken description | 5 | **5** | no | Untouched in this window. |
| B8.10 | Nudge by voice | 5 | **5** | no | Untouched in this window. |
| B9.1 | Invoice from a spoken sentence | 4 | **4** | no | `docs/PRD-v4-part-F-decisions.md:12` (F-1) still PROPOSED. No code touched this window. |
| B9.4 | Batch invoice *(deferred)* | 3 | **3** | no | No touch. |
| B9.12 | Reminder + late fee *(deferred)* | 3 | **3** | no | No touch. |

▲ = moved up. Nothing moved down.

---

## Integrity checks

### 1 · D-013 — INTACT, re-verified against `origin/main` at this HEAD

```
git diff origin/main...HEAD --stat -- packages/api/src/routes/assistant.ts \
  packages/api/src/ai/voice-turn/create-voice-turn-processor.ts \
  packages/api/src/ai/tasks/proposal-approval-task.ts \
  packages/api/src/proposals/surface.ts
```
→ **empty**. All four are byte-identical to `origin/main`.

`workers/voice-action-router.ts` IS modified on the branch (B5.5's `en_route` branch, from a prior
pass). Grepped its diff for `isVoiceApproval|isVoiceEdit|ownerSession|RV-071|RV-225|
approve_proposal|reject_proposal|edit_proposal` — the only matches are the router's own comments
citing the gate it sits **before** (`voice-action-router.ts:1423-1434`,
`isVoiceApprovalIntent` imported at `:29`, gate fires at `:1434`), never a change to the gate
logic itself.

### 2 · S1 allowlist — byte-identical, 8 entries

`packages/api/src/proposals/surface.ts` diff against `origin/main` is empty (same command as
above). Read the file directly at HEAD: `S1_ALLOWED_PROPOSAL_TYPES` contains exactly
`create_customer, create_appointment, create_booking, create_job, reschedule_appointment,
draft_estimate, callback, voice_clarification` — 8 entries. `reassign_appointment`,
`update_estimate`, `update_invoice`, `update_job`, `send_estimate_nudge`, `update_brand_voice` are
all named in the file's own exclusion comment as deliberately excluded. This is the fact that makes
B7.5's AC-3 literal-fixture gap a non-issue (see above): those intents are operator-surface only,
by design, and do not belong in the S1-facing corpus.

### 3 · Held-commit audit

```
git log --oneline --grep='HELD:' 5b5538d..bc6652f
```
Ten commits carry a `[HELD:` label: three from before the fifth pass (`370c0fe8`, `abff9c7`,
`4db3e13`, all `[HELD: auth]`; `b5595dc`, `[HELD: money-contract]`) plus **four new since the
fifth pass**, all correctly labeled and correctly scoped to money-touching code:

- `267c4ad` `[HELD: money-contract]` — the vocabulary-check unit narrowing + invoice unit
  passthrough (verified: touches `catalog-resolver.ts`, `edit-action-grounding.ts`,
  `invoice-task.ts` — all reach a line item that flows into money math's neighboring fields,
  correctly held even though `unit` itself is descriptive-only).
- `d9aee4d` `[HELD: money-contract]` — public invoice unit exposure.
- `0d18e53` `[HELD: money-gate]` — P-40, the $0 placeholder-template approval gate. Read the diff:
  a real money defect (a $0 default price could silently install and bill zero), correctly held.
- `5c959f7` `[HELD: money-integrity]` — P-42, the pack-seeding advisory lock. Read the diff: fixes
  a genuine concurrent-duplicate-catalog-row race, correctly held.

I checked every non-doc, non-HELD commit in the `a14c2d7..bc6652f` window for money/RLS/auth
content it should have been held for and was not (`218b520`, `29b5de2`, `168ae3f`, `8ac5a51`,
`67244ed`, `005d549`, `c6fbcdc`, `bc6652f`): none touch a payment/refund/RLS-policy/permission-
check path. `29b5de2` is a drafting-gate change (brand voice), correctly unlabeled.
`218b520`'s `app.ts`/`onboarding-conversation.ts` change is a session-scoped advisory lock for
conversation-turn concurrency (P-43) and a schedule-payload validation gate (P-41) — neither is
money movement, RLS, or auth; correctly unlabeled.

**`ea46e5a` remains the one known unlabeled money-contract commit**, from before the fifth pass
(adds `unit: catalogUnitSchema.optional()` to `lineItemSchema` with no `[HELD:` marker, while its
DB-column sibling `b5595dc` was labeled). Already recorded by hash in the run log and by the fifth
pass; no new instance of this class of miss found in this window's commits — the corrective rule
the run adopted ("label on which object you touched, not which field") held for all four newly
held commits, and `5c959f7`'s own commit message explicitly cites `ea46e5a` as the reason the rule
exists.

**No RLS change anywhere**: `git diff origin/main...HEAD | grep -iE 'POLICY|ROW LEVEL SECURITY|
FORCE'` over migrations returns nothing. **No new migration on this branch at all since the fifth
pass** (`git log --oneline 5b5538d..bc6652f -- 'packages/api/migrations/*'` is empty — `b5595dc`'s
migration 265 predates the fifth pass and is the only one on the branch).

### 4 · Voice-action catalog / launch fixtures — consistent

`docs/reference/voice-action-catalog.md` documents `update_brand_voice` (§B1.18) and `en_route`
(§ the non-proposal set) exactly matching `INTENT_TO_PROPOSAL_TYPE` and the deliberate omission
list; both contract tests green (`intent-classifier.launch-fixtures.test.ts` +
`launch-slots.test.ts`, 22/22; `voice-payload-contract.test.ts`, 37/37).

---

## False greens hunted, and not found (this pass)

Per the brief's method, I read the new tests added since the fifth pass for the two named species
(fixture arranged to pass; contract assertion frozen against moved behavior). Two were already
present in this window's commits — I found and mutation-verified both independently before the
concurrent `ca92e91` commit landed and retroactively numbered them "ninth and tenth" in the run
log: `brand-voice-task.test.ts`'s "positive control" (fixed by `29b5de2`) and
`update-brand-voice-voice-execution.test.ts:97` (fixed by `168ae3f`) both asserted
`missingFieldsFor === []` for a mixed brand-voice payload that the execution handler would
silently half-apply — the same defect pinned as correct behaviour in two files. I did not find an
eleventh. What I checked specifically, and why each one clears:

1. **`onboarding-conversation-seasonal-schedule-gate.test.ts` (P-41).** Scripted LLM responses
   speak an ordinary, realistic conversation ("$120 an hour", "we work Saturdays in summer");
   nothing is planted to match a query artificially — the gate fires on a real top-level schema
   key (`workingHours`), not a synthetic token. Not an arrangement.
2. **`onboarding-pack-seed-concurrency.test.ts` (P-42).** Genuine `Promise.all` race against real
   Postgres, asserting zero duplicate catalog rows — the kind of test that cannot be faked by
   seeding, since the race either produces duplicates or it doesn't.
3. **`entity-resolution.test.ts`'s de-arranged AC-4 case (`67244ed`).** Now speaks bare "Carlos"
   (`:798`, `:812`) for the first-name-only case, keeping the identical-full-name case
   ("Carlos Vega", `:857`, `:871`) as a separate, honestly-labeled test rather than silently
   dropping the original claim. Not an arrangement; the two cases test two different things now.
4. **`update-brand-voice-voice-execution.test.ts` (`168ae3f`).** This commit *removes* the tenth
   false green (a `toEqual([])` assertion pinning the mixed-payload bug as correct — the same bug
   `29b5de2`'s `brand-voice-task.test.ts` fix removed as the ninth), it does not introduce a new
   one — verified the replacement (`editProposal` unblocking the gate via the real schema key, then
   re-asserting `missingFieldsFor` is empty) exercises a real unblock path rather than asserting a
   synthetic success.
5. **`spoken-parts-edit-unit-execution.test.ts`'s rewrite (`267c4ad`).** Deliberately hands the
   scripted LLM reply a **hallucinated** `estimateId` alongside the spoken reference, so the
   assertion that the resolver's id wins can only pass if resolution genuinely beats the model —
   the exact discipline decision #11 established after the first three false greens. Each test
   seeds its own customer with a distinct surname and an ordinary, non-matching `customerMessage`
   — I checked this is not planted (`'AC service'` / `'Thanks for having us out...'` neither
   contains the surname).

I did not find an eleventh false green in this window. That is a statement about *this window's
commits*, not a re-litigation of the ten already recorded and fixed, and not a guarantee that a
more adversarial pass with more time would not find one elsewhere in the ~180-file diff against
`origin/main` that predates this window.

---

## Tree state and decay

- **Tree state at measurement:** the working tree was clean throughout — every `git status --short`
  I ran, including the final one, is empty. **HEAD advanced by one commit while I was writing**:
  `ca92e91`, from a concurrent session, landed between my gate re-runs and my final `git status`
  check. Diffed it against `bc6652f` immediately (`git diff bc6652f..ca92e91 --stat`): touches only
  `projects/rivet-voice-19/run-log.md`, no source. All source-level findings, mutation tests, and
  gate re-runs in this document were performed at `bc6652f`, before that commit landed, and remain
  valid against the current tip `ca92e91` because nothing between the two changed source or tests.
- **Nothing in source decayed while I measured.** Every gate number matched the master prompt's own
  claimed figures exactly on independent re-run (unit 12255, integration 1064/195 files,
  voice-quality 67/67, C1 37/37, launch fixtures 22/22), all executed before `ca92e91` landed.
- **One pre-existing housekeeping item, not from this pass:** a detached-HEAD git worktree
  (`.../scratchpad/mutation-p44b`, pinned at `5c959f7`) was already present in this session's
  scratchpad directory before I started, with uncommitted modifications to
  `onboarding-conversation.ts` and `app.ts` and an untracked test file — leftover mutation-testing
  scaffolding from an earlier pass in this run that was not cleaned up per the worktree-removal
  discipline the brief requires. It does not touch the main tree (confirmed `git status --short`
  on `/home/user/Serviceos` is empty throughout) and its content matches what became commit
  `218b520` (P-43), so nothing is at risk of shipping unreviewed — but it is exactly the kind of
  leftover the brief's worktree instructions exist to prevent, and I flag it rather than silently
  ignore it. I did not delete it, since removing another session's worktree is outside this
  read-only pass's mandate and the instruction is to report tree state, not to remediate it.
- **My own two mutation worktrees** (`wt/mutate1`, `wt/mutate2`) were created, used, reverted
  file-by-file (`git checkout --`), and removed (`git worktree remove --force`) in this pass;
  `git worktree list` at the end shows only the main tree and the pre-existing `mutation-p44b`
  worktree described above.

---

## Commands run (all re-runnable)

```bash
git rev-parse HEAD; git status --short; git log --oneline a14c2d7..bc6652f
git show 267c4ad d9aee4d bc6652f 8ac5a51 29b5de2 168ae3f 67244ed 218b520 0d18e53 5c959f7 --stat

git diff origin/main...HEAD --stat -- packages/api/src/routes/assistant.ts \
  packages/api/src/ai/voice-turn/create-voice-turn-processor.ts \
  packages/api/src/ai/tasks/proposal-approval-task.ts packages/api/src/proposals/surface.ts   # empty
git diff origin/main...HEAD --name-only -- packages/api/src packages/web/src \
  | grep -iE "expense|crew|late-fee|payment-reminder|batch-invoice|lookup"                    # cassettes only
git diff origin/main...HEAD --name-status -- packages/api/src/ai/voice-quality/corpus/cassettes \
  | awk '{print $1}' | sort | uniq -c                                                          # 66 M, 0 A
git log --oneline --grep='HELD:' 5b5538d..bc6652f
git diff a14c2d7..bc6652f -- docs/PRD-v4-part-F-decisions.md                                   # empty

cd packages/api
npx tsc --project tsconfig.build.json --noEmit          # exit 0
npx vitest run                                          # 1064 files / 12255 tests
npm run test:integration                                # 195 files / 1064 tests, exit 0
npm run voice-quality                                   # 67/67, launchGate.pass=true
npx vitest run test/proposals/voice-payload-contract.test.ts   # 37/37
npm run test:voice-fixtures                             # 22/22
cd ../web && npx vitest run src/hooks/useOnboardingConversation.test.ts \
  src/components/onboarding/v2/steps/ConversationStep.test.tsx   # 16/16
npx vitest run src/components/estimates/EstimatesPage.layout.test.tsx \
  src/components/invoices/InvoicesPage.layout.test.tsx \
  src/components/jobs/JobSheets.layout.test.tsx \
  src/components/customer/InvoicePaymentPage.layout.test.tsx     # 23/23

# Mutation tests — DETACHED WORKTREES ONLY, pinned to bc6652f, removed and verified gone
WT=.../wt/mutate1; git worktree add --detach "$WT" HEAD
ln -s .../node_modules "$WT/node_modules"; ln -s .../packages/api/node_modules "$WT/packages/api/node_modules"
#  (a) dropOutOfVocabularyUnit -> unconditional strip (remove safeParse check)
#      => catalog-resolver.test.ts + edit-action-grounding.test.ts + voice-payload-contract.test.ts: 12 failed
#  (b) invoice-task.ts: remove `...(typeof li.unit === 'string' ? { unit: li.unit } : {})`
#      => P5-003A.test.ts + voice-payload-contract.test.ts (create_invoice row): 2 failed
#  (c) tenant-settings-proposer.ts: revert summary suffix to '' (pre-8ac5a51)
#      => proposal-generation.test.ts AC-5 case: 1 failed
git worktree remove --force "$WT"

WT2=.../wt/mutate2; git worktree add --detach "$WT2" HEAD; ln -s .../node_modules "$WT2/node_modules"
ln -s .../packages/web/node_modules "$WT2/packages/web/node_modules"
#  (d) EstimatesPage.tsx: remove the unit <span> from both render sites (:472, :644)
#      => EstimatesPage.layout.test.tsx: 3 of 7 failed
git worktree remove --force "$WT2"

git worktree list   # main tree + one pre-existing, unrelated worktree only
```

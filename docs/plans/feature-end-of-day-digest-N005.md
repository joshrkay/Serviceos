---
module: digest
tags: [digest, N-005, reporting, correction-loop, sms]
problem_type: feature-completion
story: N-005 / P5-020
status: design
---

# Design: Complete the End-of-Day Digest (N-005 / P5-020)

The digest is the product's "dashboard" (PRD §5, line 149; §9 amendment,
lines 1101/1111). Verification found it half-built: the payload has no
"quotes sent" figure and neither reflection section ("what I wasn't sure
about today" / "what I learned today"), and it ships disabled by default.
This doc specifies exactly what to add so another agent can implement it.

Allowed files (per PRD line 714): `packages/api/src/digest/**`,
`packages/api/src/workers/digest.*` (i.e. `daily-digest-worker.ts`),
`packages/api/migrations/*digest*` (in this repo migrations live in
`packages/api/src/db/schema.ts`). Implementation will also need the digest
route, the web view, `proposals/proposal.ts` (one new repo method +
in-memory impl), `estimates/estimate.ts` (one new list option), and the
migration-immutability snapshot. Flag those as necessary companions in the
PR description even though they sit just outside the literal Allowed list.

---

## 1. Current state vs N-005 gap

### What exists (working)

| Capability | Evidence |
|---|---|
| Payload composition over tenant repos | `computeDigestPayload` — `packages/api/src/digest/digest-service.ts:417-536` |
| Money-in / jobs-done / tomorrow / approvals / overdue / unbilled / feedback | `DailyDigestPayload` fields — `digest-service.ts:73-106` |
| Deterministic fallback narrative | `buildFallbackNarrative` — `digest-service.ts:208-248` |
| SMS render with greedy char budget + one-tap links | `renderDigestSms` — `digest-service.ts:310-384` |
| Idempotent storage + double-send guards | `insertIfAbsent` / `setSmsDispatchId` — `digest-service.ts:553-588`; worker guards `daily-digest-worker.ts:18-33,318-322,409-429` |
| Tenant-tz send-window gating | `checkDigestDue` — `daily-digest-worker.ts:123-161`; `digest_time` default `18:00`, bucketed in tenant tz |
| Cross-tenant sweep w/ failure isolation | `runDailyDigestSweep` — `daily-digest-worker.ts:220-269` |
| Web view (mobile-first, F-4 safe) | `DigestPage.tsx` — `packages/web/src/pages/digest/DigestPage.tsx` |
| Read API | `GET /api/digests/:date` — `packages/api/src/routes/digests.ts:38-76` |
| `daily_digests` table (JSONB payload) | migration `162_create_daily_digests` — `schema.ts:4055-4072` |
| Digest settings columns | migration `163_tenant_settings_digest` — `schema.ts:4078-4086` |
| N-009 correction loop + `correction_lessons` + `findAppliedForDay` | `learning/corrections/correction-lesson.ts:39-57,103-110`; migration `185_correction_lessons` — `schema.ts:4575-4607` |

### What is missing (the N-005 gap)

Against the acceptance criteria (PRD §9, lines 716-734):

1. **"Quotes sent (count, pipeline value)"** (line 719) — NOT in payload.
   `computeDigestPayload` fetches `estimateRepo` into `DigestComputeDeps`
   (`digest-service.ts:397`) but never queries sent estimates.
2. **"What I wasn't sure about today"** (lines 722-723) — NOT present.
   No proposal-by-day confidence query; the payload only carries the top-3
   *pending* approvals, not the day's fired confidence markers + outcomes.
3. **"What I learned today"** (lines 724-725) — NOT present, even though
   its data source `CorrectionLessonRepository.findAppliedForDay` already
   exists (`correction-lesson.ts:48,103`) and the repo is already
   instantiated in `app.ts:1293-1295`. It is simply not wired into the
   digest.
4. **Enablement** — `digest_enabled` defaults `false`
   (`schema.ts:4080`); the sweep hard-returns when it is not `true`
   (`daily-digest-worker.ts:277-280`). The primary owner surface is off
   for every tenant.
5. **Retry-on-failure "up to 3 times"** (line 730) — partially met by the
   stored-but-unsent retry loop (`daily-digest-worker.ts:327-331`, retries
   every sweep until local midnight) but there is **no explicit attempt
   counter / cap of 3**, and no dead-letter after the cap.
6. **SMS 320-char soft limit + split** (PRD §12, lines 1245-1246) — current
   render uses a single message with `DIGEST_SMS_MAX_CHARS = 480`
   (`digest-service.ts:262`) and hard-truncates rather than splitting.

Acceptance criteria already met: deterministic/regenerable composition
(pure `computeDigestPayload`), "wasn't sure about omitted if zero"
(designed below as section omission), delivery within the window
(`checkDigestDue`).

---

## 2. Target payload shape

Add three fields to `DailyDigestPayload` (`digest-service.ts:73-106`). All
three are **optional** so pre-existing stored digest snapshots keep
deserializing (same discipline as the existing optional `feedback` field,
`digest-service.ts:98-105`) and so empty reflection sections are omitted
per the "omit if zero items" criterion.

```ts
export interface DigestQuotesSent {
  count: number;
  /** Sum of estimate totals.totalCents for estimates sent in today's window. */
  pipelineValueCents: number;
}

/** One proposal whose confidence marker fired today + what the owner did. */
export interface DigestUnsureItem {
  proposalId: string;
  proposalType: string;
  summary: string;
  /** The marker level that fired: 'low' | 'very_low'. */
  confidence: string;
  /** Optional confidenceFactors from the proposal, capped/trimmed for SMS. */
  factors?: string[];
  /**
   * Outcome derived from the proposal's status AT GENERATION TIME:
   *   draft | ready_for_review        -> 'pending'
   *   approved | executing            -> 'approved'
   *   executed                        -> 'executed'
   *   rejected                        -> 'rejected'
   *   expired                         -> 'expired'
   *   undone                          -> 'undone'
   *   execution_failed                -> 'failed'
   */
  outcome: 'pending' | 'approved' | 'executed' | 'rejected' | 'expired' | 'undone' | 'failed';
}

export interface DigestLearnedItem {
  lessonId: string;
  /** labor_rate_changed | part_price_changed | banned_phrase | scope_reclassified */
  lessonType: string;
  /** Human-readable line straight from correction_lessons.summary. */
  summary: string;
}

export interface DailyDigestPayload {
  // ...existing fields (digest-service.ts:73-106)...
  /** Quotes sent today (PRD line 719). Absent on pre-N005 stored digests. */
  quotesSent?: DigestQuotesSent;
  /** "What I wasn't sure about today". OMITTED when zero (PRD line 733). */
  unsureAbout?: DigestUnsureItem[];
  /** "What I learned today". OMITTED when zero (graceful degradation, §4). */
  learnedToday?: DigestLearnedItem[];
}
```

Caps (new constants next to `DIGEST_TOP_APPROVALS`, `digest-service.ts:113`):
`DIGEST_MAX_UNSURE = 10`, `DIGEST_MAX_LEARNED = 10`. The web view shows the
full lists it received; the SMS shows counts + top items (see §3).

### Data-source queries

**quotesSent** — estimates whose `sentAt` falls inside today's tenant-tz
window. `EstimateListOptions` (`estimates/estimate.ts:136-160`) has
`sentBefore` but no lower bound. Add a `sentFrom?: Date` (and reuse the
window's `end` via a `sentTo?: Date`) option, mirroring the existing
`sentBefore` pattern, implemented in `pg-estimate.ts` as
`sent_at >= $ AND sent_at < $`. Then:

```ts
const sentToday = await deps.estimateRepo.findByTenant(tenantId, {
  sentFrom: today.start,
  sentTo: today.end,
});
const quotesSent = {
  count: sentToday.length,
  pipelineValueCents: sentToday.reduce((s, e) => s + e.totals.totalCents, 0),
};
```
Do **not** filter by `status: 'sent'` — an estimate sent today then
accepted/rejected the same day still counts as a quote sent (its `sentAt`
persists). `totals.totalCents` is integer cents (`estimate.ts:19`,
`DocumentTotals`), so pipeline value stays integer-cents throughout.

**unsureAbout** — proposals whose confidence marker fired today. "Marker
fired" reuses the single source of truth already in the codebase:
`isBlockingConfidence(payload._meta.overallConfidence)` (`digest-service.ts:125`,
values `low`/`very_low` from `AUTO_APPROVE_BLOCKING_CONFIDENCE_LEVELS`).
Add a new repo method (interface `ProposalRepository`,
`proposals/proposal.ts:534`):

```ts
/**
 * Proposals created in [from, to) whose _meta.overallConfidence is a
 * blocking level ('low' | 'very_low'). Drives the digest "what I wasn't
 * sure about today". Newest first, capped at `limit`.
 */
findConfidenceMarkedForDay(
  tenantId: string, from: Date, to: Date, limit?: number,
): Promise<Proposal[]>;
```
Pg impl: `WHERE tenant_id = $1 AND created_at >= $2 AND created_at < $3
AND payload->'_meta'->>'overallConfidence' IN ('low','very_low')
ORDER BY created_at DESC LIMIT $4`. Add the same to
`InMemoryProposalRepository` (filter + `extractOverallConfidence`). Map each
row: `confidence` = the marker, `factors` = `proposal.confidenceFactors`
(`proposal.ts:123`), `outcome` = status→outcome table above. Scope by
`createdAt` (the day the marker fired), not `updatedAt`, so the item lands
in the digest for the day the AI was unsure. The outcome reflects the
proposal's status when the digest is generated — see determinism note in §3.

**learnedToday** — already available, no new query:
```ts
const lessons = await deps.correctionLessonRepo.findAppliedForDay(tenantId, date);
const learnedToday = lessons.slice(0, DIGEST_MAX_LEARNED).map((l) => ({
  lessonId: l.id, lessonType: l.lessonType, summary: l.summary,
}));
```
`findAppliedForDay` already excludes reverted lessons and orders
oldest→newest (`correction-lesson.ts:42-48,103-110`), so a lesson the
owner undid the same day never appears — matching "auditable and
reversible" without extra work.

`DigestComputeDeps` (`digest-service.ts:394-406`) gains
`correctionLessonRepo: CorrectionLessonRepository`. It is already
constructed in `app.ts:1293-1295`; thread it into the digest sweep's
`computeDeps`. `estimateRepo` is already present (`digest-service.ts:397`).

Sections are omitted (field left `undefined`) when their array/count is
zero, so the "omit if zero" criterion and pre-N005 backward-compat both
fall out of `undefined` handling.

---

## 3. Generation & delivery

### `computeDigestPayload` changes
Add `estimateRepo.findByTenant({sentFrom,sentTo})`,
`proposalRepo.findConfidenceMarkedForDay(...)`, and
`correctionLessonRepo.findAppliedForDay(...)` to the existing `Promise.all`
(`digest-service.ts:431-450`). Assemble the three optional fields; set each
to `undefined` when empty. No change to the money/jobs/tomorrow math — the
dashboard-parity guarantee (`digest-service.ts:5-11`) is untouched.

### `runDailyDigestSweep` changes
No structural change to the sweep loop. The only worker change is threading
`correctionLessonRepo` through `computeDeps` and the SMS split/retry work
below. `processTenant` (`daily-digest-worker.ts:271-363`) already computes
→ stores → sends; the new fields flow through `record.payload` unchanged.

### Enablement decision (recommend)
`digest_enabled` default is `false` (`schema.ts:4080`), gated at
`daily-digest-worker.ts:277-280`. **Recommendation: flip the effective
default to ON for activated tenants that have an `owner_phone`, but keep
the SMS itself gated behind `digestChannel` and phone presence** (already
enforced at `daily-digest-worker.ts:390-407`). Rationale: the digest is
"the dashboard" (PRD line 1111) — a dashboard that is off by default is not
a dashboard. Mechanics in §5/§7 (new migration flips the column default and
backfills; the always-generate/optionally-send seam already exists via
`digestChannel: 'none'`, `daily-digest-worker.ts:390-392`). This is a
customer-facing/SMS-cost decision — see Open Questions.

### SMS render (320-char soft limit, split)
PRD §12 (lines 1245-1246) requires a 320-char soft limit, splitting when
longer; the current single-message 480 hard cap (`digest-service.ts:262`)
does not split. Design:

- Introduce `DIGEST_SMS_SOFT_LIMIT = 320`. Change `renderDigestSms` (or add
  `renderDigestSmsSegments`) to return `string[]` segments, each ≤320 chars.
  Segment 1 = head (`[Rivet] Day: … Tomorrow: …`) + quotes-sent line +
  counts; subsequent segments carry approval one-tap links, then the
  reflection summaries ("Unsure: N flagged — …", "Learned: N — …"), then the
  deep link in the **final** segment. Prefix each with `(k/n)`.
- One-tap URLs are long; keep the existing greedy budgeting
  (`digest-service.ts:354-384`) but let overflow spill into the next
  segment instead of collapsing to `+N more`, so links survive the split.
- Reflection sections in SMS are compact: `Unsure: 3 flagged (2 approved, 1
  rejected).` and `Learned: labor rate now $145; 1 more.` — full detail
  lives on the web view. Omit each line entirely when its array is absent.
- Delivery: `sendDigestSms` (`daily-digest-worker.ts:384-517`) sends each
  segment in order via `delivery.sendSms`. Idempotency key becomes
  `daily_digest:<date>:<k>of<n>` so a mid-split crash re-sends only unsent
  segments and the provider dedupes per segment. The single `daily_digests`
  row still owns one `sms_dispatch_id` (the first segment's dispatch) for
  the double-send guard; emit one dispatch row per segment
  (`entityType='daily_digest'`) so the `findByEntity` retry logic at
  `daily-digest-worker.ts:412` still holds.
- Reconcile the `DIGEST_SMS_MAX_CHARS = 480` constant: keep it as the
  per-segment hard ceiling (a segment must never exceed one
  concatenated-SMS unit) and use 320 as the soft split threshold.

### Web view updates (`DigestPage.tsx`)
Mirror the three new optional fields in the local `DigestPayload` interface
(`DigestPage.tsx:44-56`) and render three new `SectionCard`s (component at
`DigestPage.tsx:95-108`):
- **Quotes sent** — count + `formatCurrency(pipelineValueCents)`, next to
  the existing money row (`DigestPage.tsx:245-258`).
- **What I wasn't sure about today** — list of `unsureAbout` items:
  proposal type + summary + a colored outcome pill (pending/approved/
  rejected/etc). Only render the card when `unsureAbout?.length`.
- **What I learned today** — list of `learnedToday` summaries with a
  lesson-type badge. Only render when `learnedToday?.length`.
Keep the existing mobile contract: `min-h-11` tap targets, no 320px
overflow (CLAUDE.md; header comment `DigestPage.tsx:5-7`).
`GET /api/digests/:date` (`routes/digests.ts`) needs no change — it returns
`record.payload` verbatim, so the new fields pass through automatically.

### Deterministic / regenerable
Composition is a pure function of the day's rows (`computeDigestPayload` is
pure over repos). `quotesSent` and `learnedToday` are stable given the same
underlying rows. **Caveat for `unsureAbout.outcome`:** it reads each
proposal's *current* status, so regenerating after an owner acts on a
proposal yields a newer outcome. This is acceptable and intended — the
stored `daily_digests.payload` snapshot is the source of truth for what was
sent, and regeneration reflects "state as of regeneration". Document this in
the field doc-comment and pin it with the regeneration test in §6.

### Retry-on-failure (up to 3) — PRD line 730
Current behavior retries a stored-but-unsent row every sweep until local
midnight (`daily-digest-worker.ts:29-33,327-331`) with no explicit cap. Add
an explicit attempt counter:
- Add `send_attempts INT NOT NULL DEFAULT 0` to `daily_digests` (migration
  §5). Increment on each send attempt in `sendDigestSms`; once it reaches
  3, stop retrying and log a structured `error` (dead-letter) instead of
  re-attempting. This makes "retry up to 3 times" explicit and bounded
  rather than "retry until midnight", and gives observability into digests
  that never delivered.

---

## 4. Dependencies & sequencing

| Dependency | Status | Action |
|---|---|---|
| N-009 correction loop (`correction_lessons`, `findAppliedForDay`) | **EXISTS** (`correction-lesson.ts`, migration 185) and repo already built in `app.ts:1293` | Just wire `correctionLessonRepo` into `DigestComputeDeps` |
| Confidence markers on proposals | **EXISTS** as `payload._meta.overallConfidence` (`auto-approve.ts:118`, `proposal.ts:449-455`) — there is **no** `proposals.confidence_markers` column; the PRD's phrase maps to this `_meta` marker | Query via new `findConfidenceMarkedForDay` |
| Estimates / `sentAt` | **EXISTS** (`estimate.ts:28`, migration 049) | Add `sentFrom/sentTo` list option |
| Money-dashboard parity helpers | **EXISTS** (`digest-service.ts:29-35`) | Unchanged |

**Graceful degradation (PRD line 733 + §12 "populate correctly"):** each
reflection section is independent. If `findConfidenceMarkedForDay` returns
nothing, `unsureAbout` is omitted; if no correction lessons applied,
`learnedToday` is omitted; if the correction repo is the in-memory stub
(no data), `learnedToday` is simply empty→omitted. The digest never fails
over a missing section — same posture as the LLM-narrative fallback
(`daily-digest-worker.ts:365-382`). No hard ordering dependency remains;
N-009 is already merged, so N-005 can ship immediately.

---

## 5. Data model changes

All strictly additive. Migration keys must be **lexicographically greater
than every existing key** and appended in order (immutability test
`migration-immutability.test.ts:25-29`). Registry max is `234`
(`schema.ts:4387`; snapshot ends at `234_tenant_settings_vapi_webhook_secret`,
`migration-immutability.test.ts:387`); reserve 235/236 for in-flight fixes
and take **237+**.

- **`237_daily_digests_send_attempts`** — retry cap counter (§3):
  ```sql
  ALTER TABLE daily_digests
    ADD COLUMN IF NOT EXISTS send_attempts INT NOT NULL DEFAULT 0;
  ```
- **`238_proposals_confidence_marker_index`** — supports
  `findConfidenceMarkedForDay` (partial expression index; additive):
  ```sql
  CREATE INDEX IF NOT EXISTS idx_proposals_tenant_created_confidence
    ON proposals (tenant_id, created_at)
    WHERE payload->'_meta'->>'overallConfidence' IN ('low','very_low');
  ```
- **`239_estimates_tenant_sent_at_index`** — supports the quotes-sent-today
  range scan (additive):
  ```sql
  CREATE INDEX IF NOT EXISTS idx_estimates_tenant_sent_at
    ON estimates (tenant_id, sent_at) WHERE sent_at IS NOT NULL;
  ```
- **`240_tenant_settings_digest_enabled_default`** *(decision-gated, §7)* —
  flip default + backfill activated tenants that can receive SMS:
  ```sql
  ALTER TABLE tenant_settings ALTER COLUMN digest_enabled SET DEFAULT true;
  UPDATE tenant_settings ts SET digest_enabled = true
    WHERE ts.digest_enabled = false
      AND ts.owner_phone IS NOT NULL
      AND ts.activated_at IS NOT NULL;   -- confirm column via 146_tenant_settings_activated_at
  ```
  Do **not** mutate `163_tenant_settings_digest` in place — that would trip
  the immutability test (`migration-immutability.test.ts:425-436`).

**Payload JSONB:** the three new payload fields need **no** migration —
`daily_digests.payload` is JSONB (`schema.ts:4060`) and the additions are
optional.

**Immutability snapshot (mandatory):** every new migration must (a) be
added to the `MIGRATIONS` map in `schema.ts`, and (b) get a
`[key, sha256]` entry appended to `SNAPSHOT` in
`migration-immutability.test.ts:54-388`, regenerated with the tsx snippet
at `migration-immutability.test.ts:38-49`. The "every live migration is in
the snapshot" test (`:442-454`) fails the build otherwise.

---

## 6. Test plan

Unit / handler-level (mocked repos), same-commit per CLAUDE.md:

1. **Bad-day-simulation digest assertion (PRD §12, line 1242).** Compose a
   day with (a) a proposal carrying `_meta.overallConfidence: 'very_low'`
   created today and later `rejected`, and (b) a `correction_lessons` row
   applied today (`labor_rate_changed`, summary "labor rate is $145 going
   forward"). Assert `payload.unsureAbout` contains the proposal with
   `outcome: 'rejected'` and `payload.learnedToday` contains the lesson
   summary. This is the headline acceptance test.
2. **Section omission (line 733).** Zero confidence-marked proposals →
   `unsureAbout` undefined; zero applied lessons → `learnedToday` undefined;
   both absent from SMS and web.
3. **quotesSent math.** Two estimates sent today (one later accepted) → count
   2, `pipelineValueCents` = sum of `totals.totalCents`; an estimate sent
   yesterday is excluded. Integer-cents only (no float).
4. **Outcome mapping.** Table test over every `ProposalStatus`
   (`proposal.ts:15-29`) → expected `outcome`.
5. **Delivery-window + retry (line 730).** Extend
   `daily-digest-worker.test.ts`: assert `checkDigestDue` window unchanged;
   assert `send_attempts` increments per failed send and that the worker
   stops retrying + dead-letter-logs after 3.
6. **SMS split.** A digest that renders >320 chars produces ≥2 segments,
   each ≤320 (and ≤480 hard), `(k/n)` prefixed, deep link only in the final
   segment, one-tap links preserved (not collapsed). A small digest stays a
   single segment. Ties to PRD §12 line 1245.
7. **Deterministic regeneration.** `computeDigestPayload` called twice over
   identical rows returns byte-identical `quotesSent`/`learnedToday`;
   `unsureAbout.outcome` is documented as generation-time (assert it tracks
   a status change between the two calls).
8. **Web contract.** jsdom class-contract test for the two new
   `SectionCard`s: `min-h-11` tap targets, renders/omits by presence, no
   320px overflow (pattern: `e2e/estimate-approval-mobile.spec.ts`).
9. **DB-touching integration test (Docker-gated, `test/integration/`,
   CLAUDE.md).** Pin the real columns/queries: run
   `findConfidenceMarkedForDay` and the `sentFrom/sentTo` estimate query
   against a real Postgres so the new SQL (JSONB expression predicate,
   `sent_at` range) can't ship against nonexistent columns — the entity-
   resolver lesson in CLAUDE.md ("mocked Pool shipped nonexistent columns").
10. **Migration immutability.** Runs automatically; the PR must include the
    regenerated snapshot entries for 237-240.

---

## 7. Rollout

- **Payload + web + reflection sections:** ship unconditionally. They are
  additive and self-omitting; no flag needed (a tenant with the digest off
  simply never generates one).
- **SMS split + retry cap:** ship with the payload work; covered by the
  worker tests. Behind no flag — it is strictly better behavior.
- **Enablement (the load-bearing decision):** recommend a phased default
  flip.
  1. Migration 240 flips the column default so **new** tenants get the
     dashboard on.
  2. Backfill **existing activated tenants with an `owner_phone`** to
     `digest_enabled = true`. Because delivery is separately gated by
     `digestChannel` and phone presence (`daily-digest-worker.ts:390-407`),
     a tenant with no phone still just stores the web digest.
  3. Optionally stage the backfill behind the per-tenant feature-flag table
     (`159_create_tenant_feature_flags`) to ramp cohorts before the global
     flip.
  Turning the digest on sends real SMS at a real per-message cost and must
  respect any messaging-consent posture — hence the owner decision below.

---

## 8. Effort & risks

**Effort: M** (matches the PRD's `[M]`). Breakdown: payload fields +
queries (S), correction-loop + estimate wiring (S, mostly plumbing since
N-009 exists), SMS split/retry (M — the genuinely new logic), web cards
(S), migrations + snapshot (S), tests incl. one integration test (M).

**Risks**
- *SMS split correctness / cost* — multi-segment sending is the highest-risk
  change (segment idempotency, per-segment dispatch rows, carrier
  concatenation). Mitigation: keep the single-row double-send guard on
  segment 1, one dispatch row per segment, test #6.
- *Default-on backfill blast radius* — flipping `digest_enabled` sends SMS to
  every eligible existing tenant on the next 6-9pm sweep. Mitigation: gate
  on `owner_phone`+`activated_at`, optional cohort ramp via feature flags.
- *Outcome non-determinism* — `unsureAbout.outcome` reads live status;
  regeneration can differ. Mitigation: documented + tested as intended
  (snapshot is source of truth).
- *Confidence-marker coverage* — only proposals whose handler stamped
  `_meta.overallConfidence` low/very_low appear. Handlers that never stamp a
  marker won't surface. Mitigation: acceptable — that is exactly the
  auto-approve-blocking signal; note it so expectations are calibrated.
- *Migration-number collisions on merge* — the repo has a history of
  renumbering (e.g. 173/177/221/229 duplicates in the snapshot). Mitigation:
  take 237-240, regenerate the snapshot at merge time.

---

## Open questions (need an owner decision)

1. **Default-on vs opt-in.** Do we flip `digest_enabled` to true and
   backfill existing activated+phone tenants (recommended), or keep it
   opt-in and only surface an in-app "turn on your daily digest" prompt?
   This is an SMS-cost and messaging-consent call, not a technical one.
2. **`unsureAbout` scope — created-today vs resolved-today.** Design scopes
   by `createdAt` (the day the AI was unsure). Confirm the owner wants "the
   markers that fired today" rather than "proposals I acted on today".
3. **"What the owner did" fidelity.** Outcome is derived from proposal
   *status*; a proposal the owner *edited* then approved reads as
   `approved`, not `edited`. Is status-level outcome sufficient, or should
   we mine `proposal_sms_events` (edit_session_opened/edit_request,
   `schema.ts:4121`) to distinguish an edit? Recommend status-level for v1.
4. **SMS 320 soft-split vs one richer message.** PRD §12 says 320 + split;
   the digest currently intentionally runs at 480 single-message. Confirm we
   move the digest to the 320-split model rather than exempting it as a
   known long-form message.

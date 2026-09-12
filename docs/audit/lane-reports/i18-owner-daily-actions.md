# Lane report — I18 owner-daily-actions inventory (§5.0c a + b)

**Invariant:** I18 — *"No feature ships that adds admin work to the owner's
day."* PRD §5 row I18; built per **§5.0c (a)** (pinned inventory + contract
test) and **(b)** (budget assertion). §5.0c **(c)**, the SMS-only e2e day, was
explicitly out of scope and is not started.

**Ticket:** #995 rung map → child #1001 ("build §5.0c (a)+(b)"), re-dispatched
after the #1021 lane left it unstarted.

**Branch:** `cloud/i18-owner-daily-actions`, cut from `origin/main` at
`137dc559e`.

**Artifacts:**

| | |
|---|---|
| Inventory | `docs/reference/owner-daily-actions.md` |
| Contract test | `packages/api/test/invariants/i18-owner-daily-actions.contract.test.ts` |
| Product code touched | none — `packages/api/src` and `packages/web/src` are untouched |

---

## 1. The honest number

**Under this derivation the owner's normal day costs one forced web action,
plus a six-action one-time activation.**

| Count | |
|---|---|
| Owner-only routes the booted app serves | **53** |
| …classified `daily` (the day's work forces it) | **2** |
| …classified `onboarding` (forced once, before the tenant can operate) | **6** |
| …classified `occasional` (administration no normal day forces) | **45** |
| Reachable off the web (SMS keyword / one-tap / voice intent) | **4** |
| `ownerRequiredDailyWebActions` — `daily` ∧ unreachable | **1** |
| `ownerRequiredOnboardingWebActions` — `onboarding` ∧ unreachable | **6** |
| Reviewed exemption list (required ∧ unreachable, with a written reason) | **7** |

The single daily web action is `POST /api/attachments/:id/visibility` — the
owner-only call on whether a field photo is visible to the customer in the
portal (RV-005). The six onboarding actions are business identity, vertical
pack, phone claim, subscription checkout, Stripe Connect onboarding, and voice
go-live.

**That is a good number, and part of why it is good is that the derivation is
narrow. This is the finding, and it should not be read as a clean bill of
health.** §5.0c specifies "every `role: owner` route", so the derived set is
routes a **dispatcher and technician cannot reach**. In the ICP — a 1–3-truck
shop — the owner is frequently the *only* user, so they personally perform a
large amount of work that is not owner-*only* (approvals, invoicing,
scheduling, the money dashboard) and that therefore never enters this
inventory. **The inventory is a lower bound on I18's real surface.** Widening
the derivation to "every authenticated mutation an owner performs in a normal
day" is a materially larger piece of work and is not what was built here; it is
the obvious next rung for this invariant and is flagged rather than silently
absorbed. Both the doc and the test header state this limit in place.

The number that will actually do work over time is the **direction of travel**:
a PR that adds an owner-only surface with no SMS, one-tap or voice on-ramp now
breaks the build and has to argue for itself in
`docs/reference/owner-daily-actions.md`.

---

## 2. Definition used

Written into both the doc and the test's header, so neither can drift from it
silently.

**Derived set** — every **owner-only** route the booted app serves. A route is
owner-only when the guard chain Express actually runs for it **admits `owner`
and refuses both `dispatcher` and `technician`**.

**Required on a normal day** — each row carries a `cadence`:

- **`daily`** — the ordinary flow of a day's jobs and calls forces the owner
  through it. The trigger is *the work* (a job photo arrives; a job uses a part
  that is not in the price book), not a decision to reconfigure the business.
- **`onboarding`** — the tenant cannot operate until the owner does it, once.
  Forced, but paid once rather than every day.
- **`occasional`** — owner-only administration that no normal day forces:
  configuration, cleanup, deletions, team management, optional features.

`daily` + `onboarding` are the **required** set I18 governs: each must either
be reachable off the web (with the channel named) or carry an
`exemption_reason` — I18's own reviewed exemption list. `occasional` rows are
still listed, with a one-line `why`, because the test accounts for **every**
owner-only route and fails on any it cannot find in the doc.

Including `onboarding` in the required set is the deliberately **inclusive**
reading. A normal day for an established tenant contains no onboarding, so
excluding it would have been defensible — and would have shrunk
`ownerRequiredOnboardingWebActions` from 6 to nothing. §5.0c's own wording
("onboarding steps") counts them, and shrinking a definition to flatter a row
is the failure mode this lane was warned about, so they are counted and kept in
a separate budget rather than folded into the daily one.

---

## 3. Derivation — which code enumerations, and why it is not a grep

Everything below runs against the app the deploy boots. No fixture route table,
no mocked registry, no grep result standing in for a wiring.

### 3.1 Owner-only routes — executed guards, not source text

`createApp()` is booted hermetically (no Postgres, no Clerk instance, no AI
key — the identical boot `test/app/route-manifest.test.ts` uses) and its real
Express layer stack is walked. Express 4 makes `app.router` throw, so `_router`
is the only way in — the same note `src/app-route-manifest.ts` carries.

For every route the guards Express would actually run are collected — the
router-level `use` middleware registered **ahead** of it (matching Express's own
ordering semantics) plus the route's own layer stack — and each is **executed**
against a synthetic request for `owner`, `dispatcher` and `technician` in turn.
A guard is *recognised* as a role guard only by the refusal strings
`requireRole` and `requirePermission` emit (`'Insufficient role'` /
`'Insufficient permissions'` — `packages/api/src/middleware/auth.ts:332`,
`:300`); recognition merely decides what is safe to probe. Whether it is
owner-only is then decided by **what it does**.

This matters because **the owner gate is not one mechanism**:

- 13 call sites use `requireRole('owner')` (`grep -rn "requireRole(" src` — 13
  lines, of which 4 files carry owner-only calls);
- far more routes are owner-only because they demand a permission only `owner`
  holds in `ROLE_PERMISSIONS` (`src/auth/rbac.ts:74`) — `settings:update`,
  `tenant:manage`, `attachments:visibility`, `audit:view`, `estimates:delete`,
  `vertical_training_assets:approve`, and the rest of the owner-minus-
  (dispatcher ∪ technician) difference.

A source-text derivation would have had to re-implement that set difference and
would have missed anything composed differently. Executing the guards settles
both mechanisms uniformly, and it is what makes "a doc-comment is not a wiring"
a *provable* claim rather than a hope — see negative control NC2, where a
handler containing the guards' own refusal strings in a comment is correctly
not counted, because running it does not admit the owner.

### 3.2 Reachability channels — resolved against code

| `reached_via` | Resolved against |
|---|---|
| `voice_intent:<intent>` | `SUPPORTED_INTENTS` (`src/ai/orchestration/intent-classifier.ts:278`) **∩** `INTENT_TO_PROPOSAL_TYPE` (`src/proposals/voice-intent-map.ts`, re-exported from `src/workers/voice-action-router.ts:472`). The intersection is deliberate: a `lookup_*` intent is real and speakable but **read-only**, so it can never stand in for performing an action. Pinned by NC4. |
| `keyword:<token>` | the inbound-SMS keyword registry **as the booted app populated it**. `src/sms/inbound-dispatch.ts` exports no "list registered keywords", so *registration is used as the oracle*: `registerKeywordHandler` throws `duplicate keyword registration` unless `overwrite` is set, so a throw means the token is already claimed by a real handler. Each token is probed exactly once (a probe that does not throw claims the token) and the registry is reset in `afterAll`. |
| `one_tap:<path>` | a route the booted app actually mounts — `/public/proposals/one-tap-approve` and `/public/proposals/one-tap-undo` (`src/routes/one-tap-approve.ts`, `src/routes/one-tap-undo.ts`). |
| `none` | nothing. Only legal with `sms_reachable: false`, and the test asserts that pairing in both directions. |

Four rows claim a channel, all four voice: `add_catalog_item`,
`update_catalog_item`, `create_standing_instruction`, `update_brand_voice`.
No owner-only route is reachable by SMS keyword or one-tap today — the
keyword and one-tap resolvers are nonetheless exercised by controls NC4/NC5
against the live registry and the live mount table, so they are proven to work
rather than merely present.

---

## 4. Commands and raw RED/GREEN output

Command, unchanged across every run:

```
cd packages/api && npx vitest run test/invariants/i18-owner-daily-actions.contract.test.ts
```

Strict TDD: **every one of the 18 assertions was first written with a
deliberately wrong expectation and run RED**, over three passes (17 at the
time; the 18th, NC7, was added in review — §9). Pass 2 exists
because 6 assertions happened to be written correctly the first time; pass 3
exists because two `expect` calls in pass 2 short-circuited on their first
sub-assertion, leaving the rest of those two tests un-RED.

### RED — pass 1 (11 failed | 6 passed)

```
 ❯ test/invariants/i18-owner-daily-actions.contract.test.ts (17 tests | 11 failed) 142ms
     × derives a non-vacuous owner-only route set from the booted app 3ms
     × lists every owner-only route in code (no undocumented owner surface) 4ms
     × lists no route the code does not serve (no rotted doc row) 1ms
     × resolves every sms_reachable: true claim against a real channel 2ms
     × puts every unreachable required action in the reviewed exemption list 1ms
     × holds the owner-required daily web-action budget 2ms
     × holds the owner-required onboarding web-action budget 1ms
     × holds the owner-only route budget 1ms
     × rejects a reached_via claim no channel actually reaches 1ms
     × resolves a claim every channel really does reach 1ms
     × does not parse a route mentioned in the doc outside the machine-readable block 1ms

⎯⎯⎯⎯⎯⎯ Failed Tests 11 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  … > derives a non-vacuous owner-only route set from the booted app
AssertionError: expected 53 to be greater than 400
    389|     expect(derived.length).toBeGreaterThan(400);

 FAIL  … > lists every owner-only route in code (no undocumented owner surface)
AssertionError: expected [] to not deeply equal []
    400|     expect(missingFromDoc).not.toEqual([]);

 FAIL  … > lists no route the code does not serve (no rotted doc row)
AssertionError: expected [] to not deeply equal []
    406|     expect(stale).not.toEqual([]);

 FAIL  … > resolves every sms_reachable: true claim against a real channel
AssertionError: expected 4 to be +0 // Object.is equality
    418|     expect(claimed.length).toBe(0);

 FAIL  … > puts every unreachable required action in the reviewed exemption list
AssertionError: expected [] to not deeply equal []
    439|     expect(unreviewed.map((r) => r.route)).not.toEqual([]);

 FAIL  … > holds the owner-required daily web-action budget
AssertionError: expected [ { …(6) } ] to have a length of +0 but got 1

 FAIL  … > holds the owner-required onboarding web-action budget
AssertionError: expected [ { …(6) }, { …(6) }, { …(6) }, …(3) ] to have a length of +0 but got 6

 FAIL  … > holds the owner-only route budget
AssertionError: expected [ Array(53) ] to have a length of 4 but got 53

 FAIL  … > rejects a reached_via claim no channel actually reaches
AssertionError: expected false to be true // Object.is equality
    529|     expect(channelReaches('voice_intent:definitely_not_an_intent', …)).toBe(true);

 FAIL  … > resolves a claim every channel really does reach
AssertionError: expected true to be false // Object.is equality
    540|     expect(channelReaches('voice_intent:add_catalog_item', …)).toBe(false);

 FAIL  … > does not parse a route mentioned in the doc outside the machine-readable block
AssertionError: expected [ …(53) ] to include 'GET /api/nonexistent'

 Test Files  1 failed (1)
      Tests  11 failed | 6 passed (17)
```

Pass 1's failures already carry the real answers: **53** derived routes,
`missingFromDoc` and `stale` both `[]` (doc and code agree exactly),
`unreviewed` `[]` (every required unreachable row already carries a reason),
**4** reachability claims, daily budget **1**, onboarding budget **6**.

### RED — pass 2 (8 failed | 9 passed): the 6 that passed in pass 1, inverted

```
 ❯ test/invariants/i18-owner-daily-actions.contract.test.ts (17 tests | 8 failed) 136ms
     × gives every row a cadence and a reason 2ms
     × leaves reached_via as none wherever sms_reachable is false 4ms
     × keeps the budget block in the doc equal to the derived counts 4ms
       × catches a planted owner-only route that is not in the doc 3ms
       × does not count a route that only mentions the guard in a comment 1ms
       × does not count a route reachable by a non-owner role 1ms
       × rejects a reached_via claim no channel actually reaches 1ms
       × resolves a claim every channel really does reach 1ms

 FAIL  … > gives every row a cadence and a reason
AssertionError: POST /api/attachments/:id/visibility cadence: expected [ 'configuration-only' ] to include 'daily'

 FAIL  … > leaves reached_via as none wherever sms_reachable is false
AssertionError: POST /api/attachments/:id/visibility: expected 'none' to be 'some-channel'

 FAIL  … > keeps the budget block in the doc equal to the derived counts
AssertionError: expected { ownerOnlyRoutes: 53, daily: 2, …(4) } to deeply equal { ownerOnlyRoutes: 54, daily: 2, …(4) }
  {
    "daily": 2,
    "occasional": 45,
    "onboarding": 6,
-   "ownerOnlyRoutes": 54,
+   "ownerOnlyRoutes": 53,
    "ownerRequiredDailyWebActions": 1,
    "ownerRequiredOnboardingWebActions": 6,
  }

 FAIL  … > negative controls > catches a planted owner-only route that is not in the doc
AssertionError: expected [ 'GET /api/planted-surface/planted' ] to deeply equal []

 FAIL  … > negative controls > does not count a route that only mentions the guard in a comment
AssertionError: expected [] to deeply equal [ Array(1) ]
- [ "GET /api/planted-surface/comment-only" ]
+ []

 FAIL  … > negative controls > does not count a route reachable by a non-owner role
AssertionError: expected [] to deeply equal [ 'GET /api/planted-surface/shared' ]

 FAIL  … > negative controls > rejects a reached_via claim no channel actually reaches
AssertionError: expected false to be true // Object.is equality
    528|     expect(channelReaches('voice_intent:definitely_not_an_intent', mounted)).toBe(true);

 FAIL  … > negative controls > resolves a claim every channel really does reach
AssertionError: expected true to be false // Object.is equality
    539|     expect(channelReaches('voice_intent:add_catalog_item', mounted)).toBe(false);

 Test Files  1 failed (1)
      Tests  8 failed | 9 passed (17)
```

### RED — pass 3 (2 failed | 15 passed): the channel sub-assertions pass 2 short-circuited past

```
 ❯ test/invariants/i18-owner-daily-actions.contract.test.ts (17 tests | 2 failed) 118ms
       × rejects a reached_via claim no channel actually reaches 4ms
       × resolves a claim every channel really does reach 1ms

 FAIL  … > rejects a reached_via claim no channel actually reaches
AssertionError: expected false to be true // Object.is equality
    531|     expect(channelReaches('voice_intent:lookup_invoices', mounted)).toBe(true);

 FAIL  … > resolves a claim every channel really does reach
AssertionError: expected true to be false // Object.is equality
    541|     expect(channelReaches('keyword:Y', mounted)).toBe(false);

 Test Files  1 failed (1)
      Tests  2 failed | 15 passed (17)
```

Pass 3 is the one that proves the two subtle resolvers: `lookup_invoices` is a
real `SUPPORTED_INTENTS` member and still resolves to **false** (lookup-only,
read-only), and `keyword:Y` resolves to **true** against the registry the app
booted — so the SMS probe is live, not vacuously negative.

### GREEN

```
 Test Files  1 passed (1)
      Tests  17 passed (17)
   Duration  10.50s
```

After the §9 review fix, on the same command:

```
 Test Files  1 passed (1)
      Tests  18 passed (18)
   Duration  11.57s
```

### Neighbouring suites (no interference from the keyword-registry probe)

```
cd packages/api && npx vitest run test/invariants test/app/route-manifest.test.ts \
  test/sms test/proposals/sms test/ai/voice-action-catalog.contract.test.ts

 Test Files  24 passed (24)
      Tests  320 passed (320)   (321 after NC7 — §9)
```

### Build verification

```
cd packages/api && npx tsc --project tsconfig.build.json --noEmit
→ clean (no output)
```

`npx tsc --noEmit` on the default tsconfig reports **pre-existing** errors in
other test files (customer-calling, sentiment-classifier, …), none in
`test/invariants/` — `npx tsc --noEmit | grep "invariants/"` returns nothing.
Those pre-existing errors are untouched by this lane.

`git status --porcelain` is empty on the branch.

---

## 5. Negative controls (§8.0)

| | Control | What it plants | Assertion |
|---|---|---|---|
| NC1 | planted owner-only route not in the doc | a real `express.Router()` with a real `requireRole('owner')` guard, mounted at `/api/planted-surface/planted` | derivation finds it, and the doc-comparison the real contract makes reports it as `missingFromDoc` — proving that assertion is not vacuous where it matters |
| NC2 | **a comment-only mention is not a wiring** | a handler whose source contains `requireRole('owner')` *and* both guard refusal strings, in a comment, with no guard | derivation returns `[]`. String matching alone would count this route; executing it does not admit the owner, so it is correctly excluded |
| NC3 | a route open to a non-owner role | `requireRole('owner', 'dispatcher')` | derivation returns `[]` — "owner-only" means owner-*only* |
| NC4 | a `reached_via` claim no channel reaches | `voice_intent:definitely_not_an_intent`; `voice_intent:lookup_invoices` (real intent, lookup-only); `keyword:zzz-not-a-registered-keyword`; `one_tap:/public/proposals/not-mounted`; bare `none`; unknown prefix `telepathy:just-know` | every one resolves **false** |
| NC5 | the positive side, so NC4 is not trivially true | `voice_intent:add_catalog_item`; `keyword:Y`; `one_tap:/public/proposals/one-tap-approve`; `one_tap:/public/proposals/one-tap-undo` | every one resolves **true**, against the live registry and live mount table |
| NC6 | doc prose is not inventory | the doc's closing paragraph names `POST /api/settings/` and `GET /api/nonexistent` outside the machine-readable markers | the parser does not yield `GET /api/nonexistent` |
| NC7 | **the chain is owner-only, not one guard** | `requireRole('owner','dispatcher')` then `requireRole('owner','technician')` — neither guard alone refuses both non-owner roles, but the chain admits only `owner` | the route **is** derived. Added after review; see §9 |
| — | non-vacuity floor | — | `derived.length > 40`, and it contains one route owner-gated by each mechanism: `PUT /api/onboarding/identity` (`requireRole('owner')`) and `PUT /api/settings/` (`requirePermission('settings:update')`) |

---

## 6. Judgment calls

Every one of the 53 rows carries a one-line `why` in the doc. The calls worth
naming here are the ones a reviewer might land differently:

1. **`POST /api/attachments/:id/visibility` → `daily`.** The most debatable
   row, and the only thing in `ownerRequiredDailyWebActions`. Field photos land
   on jobs every day and portal visibility is an owner-only decision (RV-005,
   `attachments:visibility`), so the *day* triggers it — but the owner is not
   strictly forced through it: a photo nobody publishes breaks nothing.
   Classified `daily` on the inclusive reading, because the alternative empties
   the daily budget entirely and makes the row look better than the product is.
2. **`POST /api/catalog/items/` → `daily`, reachable.** An uncatalogued line
   caps AI confidence below the auto-approve threshold (the catalog-resolver
   rule in CLAUDE.md / §5), so a job using a new part pushes the owner to add
   it that day. Voice reaches it (`add_catalog_item`), so it costs no web
   action — and it is what keeps the inventory from being an all-exempt list
   that proves nothing.
3. **`PUT /api/catalog/items/:id` → `occasional`, not `daily`.** Price
   *corrections* are triggered by supplier prices, not by the day's jobs. It is
   voice-reachable either way, so the classification does not move a budget.
4. **Onboarding counted as required.** See §2 — the inclusive reading, kept in
   its own budget so it cannot be confused with a daily cost.
5. **`POST /api/billing/connect/onboarding` → `onboarding`, not
   `occasional`.** Card payments are half of the product's time-to-cash metric;
   an owner could technically operate on checks. Counted as required — the
   non-shrinking direction.
6. **`POST /api/voice/go-live` → `onboarding`.** Not one of the 7 wizard steps
   in `OnboardingStepIdSchema`, but the tenant answers no calls until it is
   called, so it is the last forced step of activation.
7. **`POST /api/onboarding/{conversation/turn, calendar/choose}` and
   `PUT /api/onboarding/voice` → `occasional`.** These are wizard *features*,
   not steps: they are absent from `OnboardingStepIdSchema`
   (`signup, identity, pack, phone, billing, ai_check, test_call`), the
   built-in scheduler is the calendar default, and voice presets ship with a
   default. `POST /api/onboarding/billing/cancel` is likewise a recovery path,
   not a step.
8. **`POST /api/dnc/` → `occasional`.** An SMS `STOP` already writes the DNC
   list automatically through the compliance keyword handler, so the web route
   covers only a verbal opt-out request.
9. **`POST /api/vertical-training-assets/:id/approve` → `occasional`.** It is a
   review queue, which sounds daily; assets arrive rarely, so it is not.
10. **`POST /api/voice/pause` → `occasional`.** Discretionary — the owner
    chooses to pause the agent; no normal day forces it.

---

## 7. The reviewed exemption list (7)

Required (`daily` or `onboarding`) and reachable by no channel. Reasons are
carried in the doc row, abbreviated here.

| Route | Cadence | Reason |
|---|---|---|
| `POST /api/attachments/:id/visibility` | daily | No SMS/voice on-ramp exists for per-attachment portal visibility, and the decision needs the photo on screen. Accepted as a web action until a one-tap "show customer" link rides the attachment notification. |
| `PUT /api/onboarding/identity` | onboarding | One-time activation; collecting a business identity over SMS is worse than the wizard, and the cost is paid once. |
| `POST /api/onboarding/pack` | onboarding | One-time activation; a vertical-pack pick is a list selection, not a spoken action. |
| `POST /api/onboarding/phone/claim` | onboarding | One-time activation, and claiming a DID commits recurring spend — an on-screen confirmation is wanted. |
| `POST /api/onboarding/billing/checkout-session` | onboarding | One-time activation; a hosted Stripe checkout redirect cannot happen over SMS. |
| `POST /api/billing/connect/onboarding` | onboarding | One-time activation; Stripe's hosted Connect onboarding is a browser flow by construction. |
| `POST /api/voice/go-live` | onboarding | One-time activation, deliberately a considered on-screen act — the owner is handing their phone line to an AI. |

---

## 8. Scope

Built: §5.0c **(a)** and **(b)**.

Not built, and not started: §5.0c **(c)**, the SMS-only e2e day — out of scope
per the lane brief.

Not touched: `packages/api/src`, `packages/web/src`, money, RLS, auth, the
supervisor gate. The change is two new files (one doc, one test) plus this
report.

No rung is stated in this report. O-1…O-9 and Q12 are not answered here.

### Follow-ups this lane surfaced but did not take

- **The derivation's ceiling.** "Owner-only route" ≠ "action the owner
  performs". Raising I18's coverage means widening the derived set toward
  owner-performed authenticated mutations; that is a separate ticket, and until
  it exists the budget numbers should be quoted with the lower-bound caveat
  attached.
- **No owner-only route is reachable by SMS keyword or one-tap.** All four
  reachable rows are voice. If I18 is meant to hold on the *SMS* channel
  specifically — the invariant's own wording leads with SMS — that gap is
  visible now and was not before.

---

## 9. Review round 1 — a real defect in the derivation (xhawk-ai, PR #1073)

**Finding (Medium, correct):** `isOwnerOnly` asked whether **any single guard**
in the chain was owner-only, rather than whether **the chain** is. A route
guarded by

```ts
requireRole('owner', 'dispatcher'), requireRole('owner', 'technician')
```

admits only `owner` at runtime — dispatcher fails the second guard, technician
fails the first — yet neither guard *alone* refuses both non-owner roles, so the
original predicate returned `false` and the route dropped out of the derived
set.

**Why it mattered more than its severity label.** The failure direction is a
**false negative**: an owner-only route silently missing from the derived set
needs no row in the inventory, so the divergence check never fires and the
budget never moves. That is precisely the hole the invariant exists to close —
undocumented owner work passing the build. A false *positive* would merely have
demanded an extra doc row.

**Verified before fixing, RED first.** The composed route was planted as a new
negative control against the unmodified predicate:

```
 FAIL  … > negative controls > counts a route made owner-only by the chain, not by one guard
AssertionError: expected [] to deeply equal [ 'GET /api/planted-surface/composed' ]
- [ "GET /api/planted-surface/composed" ]
+ []
```

**Fix.** Reaching a handler means passing every guard in order, so a role
reaches the route iff **all** guards admit it, and is refused iff **at least
one** refuses it:

```ts
const chainAdmits = (role: string): boolean =>
  guards.every((guard) => guardAdmits(guard, role));
return chainAdmits('owner') && NON_OWNER_ROLES.every((role) => !chainAdmits(role));
```

**Result — no number in this report changed.** The real app's derived set is
still **53**, and every budget still holds, because no route in the app today is
owner-only by composition; the `toHaveLength(53)` assertion passing after the
change is the proof. The fix is pure hardening against the next route that is.

```
 Test Files  1 passed (1) · Tests 18 passed (18)
npx tsc --project tsconfig.build.json --noEmit → clean
neighbouring suites → 24 files, 321 tests passed
```

**One caveat the fix surfaced and the code now records.** `guards` includes
router-level `use` middleware registered ahead of a route *without* checking
that the `use` mount path covers it. Under the old `some` semantics that was a
false-positive risk; under `every` it would also be a false-negative risk. It is
inert today — `grep -rn "\.use(.*requireRole\|\.use(.*requirePermission" src`
returns nothing, every role guard in the app is attached per-route — so the
guard set is exact. A path-scoped `router.use('/admin', requireRole('owner'))`
would need the mount comparison added first; that is noted in `isOwnerOnly`'s
comment rather than built speculatively.

### CI note

The first check run on this branch reported every required job as `cancelled`
at 19:34:25–28Z, ~85s in, while all jobs were still `queued` — no test body
ran. Neither `pr-checks.yml` nor `e2e.yml` declares a `concurrency` group, and
the *newer* runs died while an older run for the superseded commit stayed
queued, so it was not a supersede-cancel. Re-run once (the legitimate "died
before any test body ran" case): `playwright`, `mobile-typecheck`,
`corpus-integrity` and `voice-quality-cassette-drift` all went green, so the
cancellation was transient rather than an account limit.

---

## 10. Review round 2 — a channel claim is not bound to its action (Codex, PR #1073)

**Finding (P2, correct):** `channelReaches` takes only the `reached_via` string
— it never sees the row's route. It answers *"does this channel exist?"*, not
*"does this channel perform THIS row's action?"*. A row could name a real but
unrelated channel (marking some other daily route
`voice_intent:add_catalog_item`), stay green, and drop itself out of
`ownerRequiredDailyWebActions`. Same failure direction as §9: a row escapes the
budget while the build stays green.

**What was closed, and what honestly cannot be.** Uniqueness is now enforced —
no two rows may claim the same channel, so a row cannot help itself to an
on-ramp another row already owns, which is the realistic drift (copy-paste, or
reaching for the nearest plausible intent). New assertion plus a negative
control planting Codex's literal example; both RED first:

```
 FAIL  … > binds each channel claim to exactly one action
AssertionError: expected [] to not deeply equal []

 FAIL  … > negative controls > catches two rows claiming the same channel
AssertionError: expected [ Array(1) ] to have a length of +0 but got 1
```

then GREEN, 20/20.

The **general** case is not closed and this report does not pretend it is.
Proving that voice intent X performs the same business action as HTTP route Y
needs a route → action → channel map, and no such map exists in this codebase:
a route reaches its action through an Express handler, an intent through a
proposal type and an execution handler, and the two universes are joined
nowhere. Manufacturing one would mean inventing a correspondence rather than
deriving it — the opposite of what this lane is for. **The per-row route ↔
channel binding is therefore human-reviewed, and that is now a stated ceiling**
recorded in three places: `duplicateChannelClaims`'s comment, the test header's
KNOWN LIMITS block, and `docs/reference/owner-daily-actions.md` under
Reachability channels. There are four such bindings today, listed in §1.

Closing it properly would mean giving each owner-only route an explicit action
identity that both a route and a channel can be mapped onto — a real piece of
design work, and the second follow-up this lane has surfaced without taking.

```
 Test Files  1 passed (1) · Tests 20 passed (20)
npx tsc --project tsconfig.build.json --noEmit → clean
neighbouring suites → 24 files, 323 tests passed
```

---

## 11. Review round 3 — the inventory was incomplete in two ways (Codex, PR #1073)

Two findings, both correct, both verified against source before acting. Together
they mean the earlier claim *"every owner-only route the booted app serves"* was
true of the app **as this test booted it** and not of the app **as it deploys**
— the honest word for which is incomplete. One real production route was
missing.

### 11.1 DB-gated routers never mounted

`createApp()` guards ~20 mounts behind `if (pool)` / `if (<pool-backed repo>)`.
Deleting `DATABASE_URL` for the hermetic boot meant those routers never entered
the walker at all, so any owner-only route among them was invisible — and
future DB-gated owner routes could be added without touching the budget.

Fixed by booting **with** a `DATABASE_URL`. `pg.Pool` connects lazily, so
constructing it opens no socket, and this test only walks the router stack, so
no query is ever issued against it. Boot logs a connection refusal from the
pack-seeding path and carries on; the router table is complete.

**On its own this changed no number** — the extra routers contain no
*guard-gated* owner-only route, so the executed-guard arm still derived 53. It
matters because it removes the blind spot, and because the route the next
finding is about lives in exactly that set.

### 11.2 Owner checks inside the handler

`PATCH /api/entity-aliases/:id/deactivate` is owner-only — its router's own
header says *"Owner-only revoke path for learned tenant aliases"* — but it
enforces that with `req.auth!.role !== 'owner'` **inside** the handler
(`routes/entity-aliases.ts:24`), and `asyncRoute` wraps the handler in a
function whose source contains neither refusal string. So it never entered
`guards`, and the executed-guard arm could not see it even once mounted.

It cannot be probed by execution either: the handler reaches a repository and
throws for unrelated reasons (a missing `canonicalUserId`, a non-UUID param), so
*"did it admit the owner?"* is not answerable by running it. The honest fix is
therefore a **second arm, declared rather than executed, and labelled as weaker
evidence** — with both ends nailed down so the declaration cannot rot:

- the route must still be **mounted** by the booted app (it cannot be fictional
  or outlive a deleted route);
- its source must still contain the check (it cannot outlive the check moving
  into a middleware guard — and if it does move, the test demands the
  declaration be deleted so the route is not counted twice);
- a source scan asserts the exact set of files with `req.auth.role` owner
  comparisons, so a **new** one fails the build rather than slipping in.

**The conditional/unconditional distinction matters and is encoded.**
`routes/users.ts` also compares `req.auth!.role` to `'owner'`, but as
`targetId !== actor.id && req.auth!.role !== 'owner'` — a technician reaches
those routes for their **own** record. That is self-service with an owner
escalation, not an owner-only action, so it correctly stays out of the
inventory; the scan's pinned list annotates it as such rather than leaving a
future reader to re-derive the judgment.

### 11.3 What changed in the numbers

| | Before | After |
|---|---|---|
| Owner-only routes | 53 | **54** |
| `cadence: occasional` | 45 | **46** |
| `ownerRequiredDailyWebActions` | 1 | **1** (unchanged) |
| `ownerRequiredOnboardingWebActions` | 6 | **6** (unchanged) |

The new row is `PATCH /api/entity-aliases/:id/deactivate`, classified
`occasional`: revoking a learned alias is a correction to what the AI inferred,
not a step in a normal day. **The headline I18 numbers are unchanged** — the
owner's day still costs one forced web action — but the inventory is one route
more honest, and the count of what the derivation can no longer hide is what
actually moved.

RED before GREEN, as the contract catching its own blind spot:

```
 FAIL  … > lists every owner-only route in code (no undocumented owner surface)
AssertionError: expected [ Array(1) ] to deeply equal []
+ [ "PATCH /api/entity-aliases/:id/deactivate" ]

 FAIL  … > holds the owner-only route budget
AssertionError: expected [ Array(54) ] to have a length of 53 but got 54
```

```
 Test Files  1 passed (1) · Tests 22 passed (22)
npx tsc --project tsconfig.build.json --noEmit → clean
neighbouring suites → 24 files, 325 tests passed
```

### 11.4 The lesson worth carrying

Three review rounds found three holes, and all three failed in the **same
direction**: a real owner-only surface not entering the derived set, so no doc
row was demanded, no divergence fired, and the budget stayed flattering. A
completeness claim is the hard part of a pin like this — asserting that what you
found is *all* there is. §8.0's negative controls test that the machinery
catches what it looks at; they cannot test what the machinery never looks at.
The three arms now in place (executed guards, declared in-handler, and a scan
that fails on a new gating style) each close one such blind spot, and the KNOWN
LIMITS block in the test header names what is still open rather than implying
nothing is.

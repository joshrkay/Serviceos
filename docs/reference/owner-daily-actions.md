# Owner daily actions — what the owner must do in a web or mobile session

**Audience:** product + engineering. **Source of truth:** the code, not this
file. The table below is pinned to the code by
`packages/api/test/invariants/i18-owner-daily-actions.contract.test.ts` — if an
owner-only route is added, removed, or changes its reachability, that test
fails until this file is updated. (Same shape, and the same reason, as
`docs/reference/voice-action-catalog.md`: `docs/remaining-features.md` rotted
because it was prose with no test behind it.)

This file exists to make invariant **I18** falsifiable — PRD §5 row I18, built
per PRD §5.0c (a) + (b):

> **I18** — No feature ships that adds admin work to the owner's day.
> **Given** any owner-role action required on a normal day, **then** it is
> reachable by SMS, one-tap or voice — or is in a reviewed exemption list.

---

## What counts as an owner action here

**The derived set is every owner-only route the booted app serves.** A route is
owner-only when the guard chain Express actually runs for it admits `owner` and
refuses **both** `dispatcher` and `technician`. That is decided by *executing*
the mounted guards against each role, not by reading source — see the contract
test's header for the mechanism.

**Known limit of this derivation, stated rather than hidden.** In the ICP (a
1–3-truck shop) the owner is frequently the *only* user, so they personally
perform plenty of actions that are not owner-*only* — approvals, invoicing,
scheduling — and those do not appear here because a dispatcher could do them
too. This inventory is therefore a **lower bound** on I18's real surface, which
is what §5.0c specifies ("every `role: owner` route"). Widening the derivation
to "every authenticated mutation" is a larger piece of work and is not what
this file claims to be.

## What counts as "required on a normal day"

Each row carries a `cadence`:

- **`daily`** — the ordinary flow of a day's jobs and calls forces the owner
  through it. The trigger is the work itself (a job photo arrives, a job uses a
  part that isn't in the price book), not a decision to reconfigure the
  business.
- **`onboarding`** — the tenant cannot operate until the owner does it, once.
  Forced, but paid once rather than every day.
- **`occasional`** — owner-only administration that no normal day forces:
  configuration, cleanup, deletions, team management, optional features. The
  `why` column carries the one-line reason for each such judgment.

`daily` and `onboarding` rows are the **required** set that I18 governs. Each
must either be reachable off the web (`sms_reachable: true`, with the channel
named in `reached_via`) or carry an `exemption_reason` — the reviewed exemption
list the invariant allows. `occasional` rows are not required on a normal day,
so I18 makes no demand of them; they are listed because the contract test
accounts for **every** owner-only route in code and fails on any it cannot find
here.

### Reachability channels

`reached_via` is resolved against code, not taken on trust:

| Prefix | Resolved against |
|---|---|
| `voice_intent:<intent>` | `SUPPORTED_INTENTS` (`ai/orchestration/intent-classifier.ts`) **and** `INTENT_TO_PROPOSAL_TYPE` (`proposals/voice-intent-map.ts`) — a lookup-only intent does not count, because it cannot perform an action |
| `keyword:<token>` | the inbound-SMS keyword registry as the booted app populated it (`sms/inbound-dispatch.ts`) |
| `one_tap:<path>` | a route the booted app actually mounts (`routes/one-tap-approve.ts`, `routes/one-tap-undo.ts`) |
| `none` | nothing — only legal with `sms_reachable: false` |

---

## Budgets (PRD §5.0c (b))

| Budget | Count |
|---|---|
| Owner-only routes in code | **53** |
| `cadence: daily` | **2** |
| `cadence: onboarding` | **6** |
| `cadence: occasional` | **45** |
| `ownerRequiredDailyWebActions` — `daily` ∧ not reachable | **1** |
| `ownerRequiredOnboardingWebActions` — `onboarding` ∧ not reachable | **6** |

A PR that raises `ownerRequiredDailyWebActions` has to edit the number in the
contract test, which is the point: adding an owner-only, non-SMS-reachable
daily surface breaks the build and the fix is a reviewed line in this file.

<!-- BEGIN machine-readable: owner-daily-actions-budget -->

```json
{
  "ownerOnlyRoutes": 53,
  "daily": 2,
  "onboarding": 6,
  "occasional": 45,
  "ownerRequiredDailyWebActions": 1,
  "ownerRequiredOnboardingWebActions": 6
}
```

<!-- END machine-readable: owner-daily-actions-budget -->

---

<!-- BEGIN machine-readable: owner-daily-actions -->

| route | cadence | why | sms_reachable | reached_via | exemption_reason |
|---|---|---|---|---|---|
| `POST /api/attachments/:id/visibility` | daily | Field photos land on jobs every day; whether the customer sees one in the portal is an owner-only call (RV-005) that recurs with the work. | false | none | Reviewed: no SMS/voice on-ramp exists for per-attachment portal visibility, and the decision needs the photo on screen. Accepted as a web action until a one-tap "show customer" link rides the attachment notification. |
| `POST /api/catalog/items/` | daily | An uncatalogued line caps AI confidence below the auto-approve threshold (catalog-resolver rule), so a job using a new part pushes the owner to add it that day. | true | voice_intent:add_catalog_item | |
| `PUT /api/onboarding/identity` | onboarding | Step `identity` of the 7-step wizard: business name, hours, timezone, owner phone. Nothing else works until it is set — an unset timezone makes booking refuse (I10). | false | none | Reviewed: one-time activation. Collecting a business identity over SMS is a worse experience than the wizard, and the cost is paid once, not daily. |
| `POST /api/onboarding/pack` | onboarding | Step `pack`: seeds `catalog_items` and `estimate_templates`. Without a price book the AI cannot ground a quote. | false | none | Reviewed: one-time activation; a vertical pack pick is a list selection, not a spoken action. |
| `POST /api/onboarding/phone/claim` | onboarding | Step `phone`: claims the DID customers call. The voice product does not exist without it. | false | none | Reviewed: one-time activation, and claiming a specific number commits recurring spend — a deliberate on-screen confirmation is wanted here. |
| `POST /api/onboarding/billing/checkout-session` | onboarding | Step `billing`: mints the trial subscription checkout. `POST /api/voice/go-live` refuses with `BILLING_REQUIRED` until a subscription is active. | false | none | Reviewed: one-time activation, and the checkout itself is a hosted Stripe redirect that cannot happen over SMS. |
| `POST /api/billing/connect/onboarding` | onboarding | Stripe Connect onboarding. Until it is done the tenant cannot take card payments, which is half of the time-to-cash metric. | false | none | Reviewed: one-time activation; Stripe's hosted onboarding is a browser flow by construction. |
| `POST /api/voice/go-live` | onboarding | Flips the tenant's voice agent live. Until it is called the AI answers nothing, so it is the last forced step of activation. | false | none | Reviewed: one-time activation. Deliberately a considered on-screen act — the owner is handing their phone line to an AI. |
| `DELETE /api/billing/connect` | occasional | Disconnects Stripe payouts — teardown, never part of a working day. | false | none | |
| `DELETE /api/catalog/items/:id` | occasional | Price-book cleanup; the day's work adds items, it does not delete them. | false | none | |
| `DELETE /api/dnc/:phone` | occasional | Removes a number from the do-not-call list — a correction, on request. | false | none | |
| `DELETE /api/estimates/:id` | occasional | Cleanup. The daily path is draft → approve → send, not delete. | false | none | |
| `DELETE /api/notes/:id` | occasional | Cleanup of a note the day already captured. | false | none | |
| `DELETE /api/settings/packs/:packId` | occasional | Vertical-pack configuration. | false | none | |
| `DELETE /api/settings/voice-approval-pin` | occasional | Security configuration for the spoken money/irreversible challenge. | false | none | |
| `GET /api/evaluation/shadow-comparisons` | occasional | Internal AI-evaluation surface; not part of running the business. | false | none | |
| `GET /api/settings/packs/` | occasional | Configuration read. | false | none | |
| `PATCH /api/job-forms/templates/:id` | occasional | Job-form template configuration. | false | none | |
| `PATCH /api/settings/language` | occasional | One-time language preference. | false | none | |
| `PATCH /api/standing-instructions/:id/deactivate` | occasional | Retires a standing instruction — a change of policy, not a day's work. | false | none | |
| `PATCH /api/users/:id` | occasional | Team-member administration (role, display name, field-serve flag). | false | none | |
| `POST /api/agreements/:id/cancel` | occasional | Service-agreement cancellation; customer-initiated and infrequent. | false | none | |
| `POST /api/agreements/:id/run-now` | occasional | Manual override of the scheduled agreement runner. | false | none | |
| `POST /api/attachments/:id/archive` | occasional | Attachment cleanup. | false | none | |
| `POST /api/billing/end-trial-now` | occasional | Ends the trial early — a one-time subscription act. | false | none | |
| `POST /api/billing/portal-session` | occasional | Opens the Stripe customer portal for payment method / cancellation. | false | none | |
| `POST /api/customers/:id/archive` | occasional | CRM housekeeping. | false | none | |
| `POST /api/dnc/` | occasional | Manual do-not-call entry. An SMS `STOP` already writes the list automatically, so the web route covers only verbal requests. | false | none | |
| `POST /api/job-custom-fields/defs` | occasional | Custom-field schema configuration. | false | none | |
| `POST /api/job-custom-fields/defs/:fieldDefId/archive` | occasional | Custom-field schema cleanup. | false | none | |
| `POST /api/job-forms/templates` | occasional | Job-form template configuration. | false | none | |
| `POST /api/job-forms/templates/:id/archive` | occasional | Job-form template cleanup. | false | none | |
| `POST /api/locations/:id/archive` | occasional | Service-location housekeeping. | false | none | |
| `POST /api/marketing/campaigns` | occasional | Optional growth feature; no normal day requires a campaign. | false | none | |
| `POST /api/marketing/campaigns/:id/send` | occasional | Optional growth feature. | false | none | |
| `POST /api/onboarding/billing/cancel` | occasional | Clears a pending checkout the owner abandoned — a recovery path, not a required step. | false | none | |
| `POST /api/onboarding/calendar/choose` | occasional | Calendar-provider pick. Not one of the 7 wizard steps; the built-in scheduler is the default. | false | none | |
| `POST /api/onboarding/conversation/turn` | occasional | The conversational variant of the wizard. An alternative path through onboarding, not an additional required step. | false | none | |
| `POST /api/settings/brand-voice/rollback` | occasional | Reverts a brand-voice change — a correction path. | false | none | |
| `POST /api/standing-instructions/` | occasional | Creates a persistent agent instruction — a policy change. Listed as occasional rather than daily even though voice can reach it. | true | voice_intent:create_standing_instruction | |
| `POST /api/users/invitations` | occasional | Team growth; rare in a 1–3-truck shop. | false | none | |
| `POST /api/vertical-training-assets/` | occasional | Uploads a training asset for review. | false | none | |
| `POST /api/vertical-training-assets/:id/activate` | occasional | Training-asset lifecycle. | false | none | |
| `POST /api/vertical-training-assets/:id/approve` | occasional | Training-asset review queue; assets arrive rarely, not daily. | false | none | |
| `POST /api/vertical-training-assets/:id/archive` | occasional | Training-asset lifecycle. | false | none | |
| `POST /api/voice/pause` | occasional | Pauses the voice agent. Discretionary — the owner chooses it, the day does not force it. | false | none | |
| `PUT /api/catalog/items/:id` | occasional | Price correction, triggered by supplier prices rather than by the day's jobs. Voice can reach it. | true | voice_intent:update_catalog_item | |
| `PUT /api/onboarding/voice` | occasional | Voice preset + greeting. Not one of the 7 wizard steps; presets ship with a default. | false | none | |
| `PUT /api/settings/` | occasional | The general settings write. Configuration, by definition. | false | none | |
| `PUT /api/settings/brand-voice/` | occasional | Brand-voice configuration. Voice can reach it (`update_brand_voice` is `manual` class — owner-only, never auto-approved). | true | voice_intent:update_brand_voice | |
| `PUT /api/settings/capabilities/:key` | occasional | Per-tenant capability flags (#1011). Configuration. | false | none | |
| `PUT /api/settings/packs/:packId/activate` | occasional | Vertical-pack activation. | false | none | |
| `PUT /api/settings/voice-approval-pin` | occasional | Security configuration for the spoken challenge. | false | none | |

<!-- END machine-readable: owner-daily-actions -->

---

## Reading the result honestly

Under this derivation the owner's day costs **one** forced web action
(`POST /api/attachments/:id/visibility`) plus a **six**-action one-time
activation. That is a genuinely good number for I18 — and it is good partly
because the derivation is narrow: most of what an owner does all day is not
owner-*only*, so it never enters this table (see "Known limit" above). The
number to watch is the direction of travel: every PR that adds an owner-only
surface with no SMS, one-tap or voice on-ramp has to come here and argue for
it.

Prose elsewhere in this file — including this paragraph, which mentions
`POST /api/settings/` and `GET /api/nonexistent` — is not part of the
inventory. Only rows inside the machine-readable markers are parsed.

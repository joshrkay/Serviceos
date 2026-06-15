# feat: CRM, Communication & Multi-Location — Jobber Parity Roadmap

**Created:** 2026-06-15
**Depth:** Deep
**Status:** plan

## Summary

A sequenced program to bring ServiceOS's **CRM (customer record), customer
communication, and multi-location** capabilities to feature parity with
Jobber — delivered the AI/voice way and inside the proposal/approval trust
model. Research confirmed the platform is already broad (185 migrations,
full customer/lead/conversation/portal stack); the gaps are **depth** items,
not missing domains. This plan closes the verified record-level CRM gaps
(multiple contacts, tags/custom fields, billing address), completes the
two-way communication loop (capture-all inbound SMS → threaded inbox →
owner reply), adds CRM lifecycle depth (equipment registry, LTV
segmentation, bounded re-engagement), and — as an explicit reversal of a
prior PRD non-goal — introduces a real **business-location (branch)**
construct below the tenant.

## Problem Frame

The ICP is the 1–5 person shop going independent; Jobber is the direct
head-to-head (`docs/competitive-gap-analysis.md`). A prospect comparing the
two will check off a feature grid: *can I store a billing contact separate
from the site contact? tag my VIPs? text a customer back and see the whole
thread? track the furnace I installed? run two branches under one login?*
Today several of those answer "no" or "partial," even though the underlying
infrastructure to support them already exists. This plan turns those into
"yes" without drifting into ServiceTitan's enterprise surface.

## Requirements

- **R1.** Multiple contacts per customer, each with a role (primary /
  billing / site), usable by B2B/property-manager accounts. (Jobber: client
  has multiple contacts.)
- **R2.** Persisted customer **tags** and tenant-defined **custom fields**
  (the `tags` field exists in the contract but is never stored). (Jobber:
  client tags + custom fields.)
- **R3.** A **billing/mailing address** distinct from service addresses, and
  verified parity for multiple service properties per customer. (Jobber:
  billing address + multiple properties.)
- **R4.** **Two-way conversational SMS**: arbitrary inbound customer texts
  that no feature keyword claims are captured into a customer-threaded
  conversation instead of being dropped.
- **R5.** A **unified communication inbox** surface where the owner reads
  SMS + email + voice history per customer and replies, with the existing AI
  "suggest reply" draft. (Jobber: client communication / two-way texting.)
- **R6.** An owner-authored **outbound reply** path (free-text SMS/email)
  that is audited and DNC/consent-gated.
- **R7.** **Equipment / installed-asset registry** tied to a customer's
  property, with history and a voice lookup. (Jobber: equipment/asset; PRD
  §6 in-scope.)
- **R8.** Read-only **customer LTV + lifecycle segmentation** aggregates.
- **R9.** **Bounded re-engagement / win-back** outreach as approval-gated
  proposals (never a marketing-automation platform — explicit PRD non-goal).
- **R10.** A **business-location (branch)** entity below the tenant: assign
  jobs/appointments and staff to a branch, scope a branch manager's
  visibility, and roll reporting up per branch. (Overrides a prior PRD
  non-goal — see Key Decisions.)

## Key Technical Decisions

- **Multi-location "branches" reverses a standing PRD non-goal — gate it.**
  `docs/competitive-gap-analysis.md` and `docs/stories/crm-parity-dispatch-order.md`
  both list "Multi-location aggregation … PRD out-of-scope (V1 / ever)."
  Jobber itself barely supports true multi-branch (its strength is *multiple
  properties per client*, which we already have). The user has explicitly
  chosen to build both senses. **Decision:** treat branches (U10–U12) as
  Phase 4, gated on a formal decision-log reversal (`docs/decisions.md`)
  before any code. (Alternative: keep it a non-goal and satisfy
  "multi-location" with properties-per-customer only — rejected because the
  user explicitly asked for business branches.)

- **Tenant stays the RLS security boundary; branch is an application-level
  filter.** A branch is *not* a new isolation boundary — all branches share
  one tenant. Per-branch visibility is enforced by a user→branch membership
  + role check in queries, not by RLS. (Alternative: per-branch RLS —
  rejected: massive policy surface, breaks owner cross-branch views, and a
  branch is an org convenience, not a trust boundary like tenant.)

- **Owner-authored replies are direct mutations; AI-initiated outreach goes
  through proposals.** The human-approval gate exists to keep *AI* from
  acting unilaterally. An owner typing a reply and pressing send is the human
  — so U6 is a direct authenticated, audited, DNC-gated send (like sending an
  estimate by hand). AI-drafted proactive messages (U9 re-engagement, and the
  existing "suggest reply" draft) remain owner-confirmed; proactive ones are
  `send_message`-style proposals that **never auto-approve** (comms proposals
  are already hard-blocked from auto-approval in `proposals/auto-approve.ts`).

- **Custom fields = tenant-defined schema + per-customer values, not a free
  JSONB blob.** A `customer_custom_field_defs` (tenant) + `customer_custom_field_values`
  (customer) pair keeps fields typed, validatable, and segmentable.
  (Alternative: a single JSONB column on `customers` — rejected: can't
  enumerate fields for the editor UI or segment on them reliably.)

- **Billing address: a typed `service_locations` row, not new columns.**
  Add an `address_type`/`is_billing` flag to `service_locations` rather than
  bolting billing columns onto `customers`. Reuses existing geocoding,
  notes, and RLS; keeps one address model. (Alternative: billing columns on
  `customers` — rejected: duplicates the address shape and its validation.)

- **Reuse the existing comms rails; do not build a rules/workflow engine.**
  Inbound routing (`sms/inbound-dispatch.ts`), DNC enforcement
  (`compliance/dnc.ts` + `stop-reply.ts`, already enforced on every outbound
  send via `send-service.ts`), the dispatch audit ledger
  (`notifications/dispatch-repository.ts`, which logs **both** SMS and
  email), conversations/messages tables, and the sweep-worker pattern all
  exist. Re-engagement (U9) is a narrow sweep worker, not a generic
  automation builder (PRD non-goal).

## Scope Boundaries

**In scope:** customer-record CRM depth (R1–R3), two-way communication loop
+ unified inbox (R4–R6), CRM lifecycle/intelligence (R7–R9), and
business-branch multi-location (R10), plus the properties-per-customer
parity check.

**Non-goals:**
- Marketing-automation platform / campaign builder / A/B testing (bounded
  re-engagement only — PRD non-goal).
- Per-branch RLS isolation, route optimization across branches, payroll.
- Self-service portal as a daily destination (keep token-scoped &
  transactional).
- ServiceNow-style case/ticket/SLA/CMDB management (anti-persona).

### Deferred to follow-up work / cross-listed (already tracked elsewhere)
- **QuickBooks Online sync** (P15-001) — accounting, not CRM; tracked in the
  dispatch order. UI stub exists; backend missing.
- **Membership plans** (P20-001), **referral program** (P15-005),
  **live online booking** (P20-002) — customer-relations-adjacent revenue
  features already ranked in `docs/stories/crm-parity-dispatch-order.md`;
  reference, don't re-spec here.
- **Review-request automation** — already shipped (post-job `feedback-send`
  worker, review-gating); no work needed.
- **Executive dashboard** (P10-002) — partially overlaps U8/U12; keep
  lightweight per "the digest is the dashboard."

## Repository invariants touched

- **Integer cents** — U8 LTV/segmentation aggregates sum money; all in cents.
- **UTC storage / tenant-timezone render** — U10 branches each carry a
  timezone; reminders/reports render in the *branch* timezone where a branch
  is set, else tenant timezone.
- **`tenant_id` + RLS on every entity** — every new table (`customer_contacts`,
  `customer_tags`, `customer_custom_field_defs/_values`, `equipment`,
  `business_locations`) carries `tenant_id` with RLS FORCEd. Branch is an
  app-level filter *within* the tenant boundary, never a substitute for it.
- **Audit events on every mutation** — contact/tag/custom-field/equipment/
  branch writes and every outbound message emit audit events via the existing
  `audit/` ledger.
- **LLM gateway** — U5 "suggest reply" and U9 draft copy route through
  `packages/api/src/ai/gateway`; no direct provider SDK use.
- **Zod proposals, never auto-executed** — U9 re-engagement messages are
  typed proposals requiring human approval; comms proposals stay
  auto-approve-blocked.
- **Catalog resolver / entity resolver** — not central here, but any voice
  path that references a customer/equipment by free text (U7 voice lookup)
  resolves through the entity resolver; ambiguity → one-tap
  `voice_clarification`.

## High-Level Technical Design

Four phases, dependency-ordered. Phases 1–3 are independently shippable and
carry no PRD-reversal risk; Phase 4 is gated.

```mermaid
graph TD
  subgraph P1[Phase 1 — Customer record parity]
    U1[U1 Multiple contacts]
    U2[U2 Tags + custom fields]
    U3[U3 Billing addr + props parity]
  end
  subgraph P2[Phase 2 — Communication loop]
    U4[U4 Capture-all inbound SMS] --> U5[U5 Unified inbox surface]
    U5 --> U6[U6 Owner reply send path]
  end
  subgraph P3[Phase 3 — CRM lifecycle]
    U7[U7 Equipment registry]
    U2 --> U8[U8 LTV + segmentation]
    U8 --> U9[U9 Bounded re-engagement]
  end
  subgraph P4[Phase 4 — Branches (PRD-override, gated)]
    G[Decision-log reversal] --> U10[U10 Branch foundation]
    U10 --> U11[U11 Branch visibility + roles]
    U10 --> U12[U12 Per-branch reporting]
  end
```

## Implementation Units

### U1. Multiple contacts per customer (P13-001)
- **Goal:** Store N contacts per customer, each typed by role, so B2B and
  property-manager accounts can separate the decision-maker, the site
  contact, and the bill-to.
- **Requirements:** R1
- **Dependencies:** none
- **Files:**
  - `packages/api/src/db/schema.ts` (new migration `186_customer_contacts`:
    `customer_contacts` — id, tenant_id, customer_id FK, name, role enum
    (`primary`|`billing`|`site`|`other`), phone, email, is_primary, notes,
    created_at/updated_at; RLS FORCE).
  - `packages/shared/src/contracts/customer.ts` (extend with `Contact` schema
    + `contacts` on Customer detail).
  - `packages/api/src/customers/customer.ts` + `pg-customer.ts` (repo CRUD).
  - `packages/api/src/routes/customers.ts` (nested `/:id/contacts` CRUD).
  - `packages/web/src/pages/customers/CustomerDetail.tsx` +
    `CustomerEdit.tsx` (contacts editor).
  - Tests: `packages/shared/src/contracts/customer.test.ts` (schema),
    `packages/api/src/customers/customer.test.ts` (repo logic),
    `packages/api/test/integration/customer-contacts.test.ts` (DB).
- **Approach:** Mirror the existing `service_locations` one-to-many pattern
  (per-customer child rows, `is_primary`, archive flag). Enforce exactly one
  primary contact per role at the repo layer. Surface contacts on the
  customer detail and feed the B2B account context
  (`ai/agents/customer-calling/b2b-account-context.ts`).
- **Patterns to follow:** `service_locations` migration + repo; `notes`
  nested-route shape in `routes/notes.ts`.
- **Test scenarios:**
  - Happy path: create customer → add billing + site contacts → list returns
    both with roles.
  - Edge: adding a second `is_primary` contact demotes the first; archive a
    contact excludes it from active list.
  - Error/perms: cross-tenant contact insert rejected by RLS; invalid role
    rejected by Zod.
  - Integration (DB): real columns exist and FK cascade on customer archive
    behaves (pin columns — mocked-DB tests are not sufficient).
- **Verification:** A property-manager customer shows distinct primary,
  billing, and site contacts; the voice B2B context reads them.

### U2. Customer tags + custom fields (P13-003)
- **Goal:** Persist tags and tenant-defined custom fields so customers can be
  segmented (prerequisite for U8/U9) and enriched like Jobber.
- **Requirements:** R2
- **Dependencies:** none (but unblocks U8, U9)
- **Files:**
  - `packages/api/src/db/schema.ts` (migration `187_customer_tags_custom_fields`:
    `customer_tags` (tenant_id, customer_id, tag, unique per (tenant,customer,tag));
    `customer_custom_field_defs` (tenant_id, key, label, type enum
    text|number|date|select, options jsonb, sort_order);
    `customer_custom_field_values` (tenant_id, customer_id, field_def_id,
    value); all RLS FORCE).
  - `packages/shared/src/contracts/customer.ts` (wire the existing `tags`
    field to persistence; add `customFields`).
  - `packages/api/src/customers/customer.ts` + `pg-customer.ts`,
    `packages/api/src/routes/customers.ts` (tags + field-def + value endpoints).
  - `packages/web/src/pages/customers/` (tag chips + custom-field editor) and
    the customer list filter.
  - Tests: `packages/shared/src/contracts/customer.test.ts`,
    `packages/api/src/customers/customer.test.ts`,
    `packages/api/test/integration/customer-tags-custom-fields.test.ts`.
- **Approach:** Tags are a simple join table with a unique constraint
  (idempotent add). Custom fields use the def/value split from Key Decisions
  so the editor can enumerate fields and U8 can segment on typed values.
  Validate a value against its def's type/options at write time.
- **Patterns to follow:** the contract already declares
  `tags: z.array(z.string()).optional()` — make it real; reuse the customer
  list enrichment plumbing that currently fakes tags client-side.
- **Test scenarios:**
  - Happy path: add tags `["vip","net-30"]`, filter customer list by `vip`.
  - Edge: duplicate tag add is a no-op; deleting a field def cascades/blocks
    values per chosen rule; select-type value not in options is rejected.
  - Integration (DB): tag uniqueness + value↔def FK enforced; list filter
    query returns only tenant rows.
- **Verification:** Tag a customer VIP, filter the list to VIPs, and a custom
  "Gate code" field persists and renders.

### U3. Billing address + multiple-properties parity (R3)
- **Goal:** Let a customer have a billing/mailing address distinct from
  service addresses, and confirm multiple service properties reach Jobber
  parity (multiple addresses, one primary, per-property access notes).
- **Requirements:** R3
- **Dependencies:** none
- **Files:**
  - `packages/api/src/db/schema.ts` (migration `188_service_location_address_type`:
    add `address_type` enum (`service`|`billing`|`both`) / `is_billing` to
    `service_locations`).
  - `packages/api/src/customers/pg-customer.ts` (billing-address resolution
    helper used by invoice/estimate rendering).
  - `packages/api/src/notifications/send-service.ts` + `templates.ts`
    (recipient/address resolution uses billing address where present — verify
    only; no behavior change if absent).
  - `packages/web/src/pages/customers/CustomerDetail.tsx` (label billing vs
    service; "set as billing").
  - Tests: `packages/api/src/customers/customer.test.ts`,
    `packages/api/test/integration/customer-billing-address.test.ts`.
- **Approach:** Reuse `service_locations` (Key Decisions) — one address model.
  Default: primary service location is also billing unless a billing-typed row
  exists. This is the *light* sense of "multi-location" (properties per
  customer), already largely built; the only true gap is the billing/service
  distinction.
- **Patterns to follow:** existing `service_locations.is_primary` handling.
- **Test scenarios:**
  - Happy path: customer with 3 properties + 1 billing address; invoice
    renders the billing address, job uses the service property.
  - Edge: no billing row → falls back to primary service location; archiving
    the billing row reverts the fallback.
  - Integration (DB): `address_type` column exists; billing-resolution query
    returns the right row per tenant.
- **Verification:** An invoice shows the billing address while the visit shows
  the service property.

### U4. Capture-all inbound SMS → customer thread (R4)
- **Goal:** Stop dropping unclaimed inbound customer texts. Any inbound SMS no
  feature keyword/fallback claims is persisted to a customer-scoped
  conversation thread.
- **Requirements:** R4
- **Dependencies:** none (composes with existing inbound dispatcher)
- **Files:**
  - `packages/api/src/sms/inbound-capture.ts` (new: a *last-resort*
    `FallbackHandler`/resume-style handler that resolves the sender phone to a
    customer, opens/append a `conversations`/`messages` row, emits
    `sms.inbound.captured` audit).
  - `packages/api/src/app.ts` (register it after existing
    fallback/recovery/negotiation handlers so it never pre-empts them).
  - `packages/api/src/conversations/*` (append message via existing repo).
  - Tests: `packages/api/src/sms/inbound-capture.test.ts` (unit, mocked repo),
    `packages/api/test/integration/inbound-sms-capture.test.ts` (DB:
    phone→customer resolution + message persisted).
- **Approach:** Register as the final handler in the documented chain
  (`sms/inbound-dispatch.ts`: keyword → fallback → recovery → negotiation →
  **capture**). STOP/START already short-circuit upstream
  (`compliance/stop-reply.ts`), so opt-outs never reach capture. Resolve the
  phone via the entity resolver / customer phone index; unknown numbers create
  a lightweight lead-linked thread, not a silent drop. Handler must never
  throw (dispatcher contract).
- **Patterns to follow:** `RecoveryResumeHandler` registration and the
  failure-isolation pattern in `sms/inbound-dispatch.ts`; phone normalization
  in `compliance/dnc.ts`.
- **Test scenarios:**
  - Happy path: known customer texts "is the tech still coming?" → appended to
    their conversation; appears on the timeline.
  - Edge: STOP still routes to opt-out, never captured; unknown number creates
    a new thread; empty/media-only message handled.
  - Integration (DB): inbound row resolves to the correct tenant's customer
    and the message persists with channel=sms.
- **Verification:** A customer's free-text reply shows up in their thread and
  on the unified timeline instead of vanishing.

### U5. Unified communication inbox surface (R5)
- **Goal:** One per-customer place to read SMS + email + voice history and
  compose a reply, with the existing AI "suggest reply" draft.
- **Requirements:** R5
- **Dependencies:** U4
- **Files:**
  - `packages/web/src/pages/inbox/InboxPage.tsx` *(net-new triage surface;
    distinct from the existing approval-queue "InboxPage" — name carefully to
    avoid collision, e.g. `CommsInboxPage`)* and a thread view reusing
    `components/customers/CommunicationTimeline.tsx` / `ConversationThread`.
  - `packages/api/src/routes/conversations.ts` (list open threads across
    customers; per-thread fetch) — reuse existing
    `POST /api/conversations/:id/suggest-reply`.
  - Tests: `packages/web` jsdom class-contract test for the thread composer
    (≥44px tap targets, no 320px overflow) +
    `e2e/comms-inbox-mobile.spec.ts` (Playwright viewport), per CLAUDE.md
    mobile rules.
- **Approach:** Reads only — aggregation already exists
  (`customers/timeline.ts` threads cross-channel; `suggest-reply-task.ts`
  drafts). This unit is the *surface*: a list of threads needing a reply +
  the composer. The "✨ Suggest reply" action already exists; wire it here.
- **Patterns to follow:** existing `ConversationThread` rendering and the
  estimate-approval mobile test pattern (`e2e/estimate-approval-mobile.spec.ts`).
- **Test scenarios:**
  - Happy path: open inbox → thread list shows customers with unread inbound;
    open one → full cross-channel history renders.
  - Edge/mobile: 320px no horizontal overflow; composer + send button ≥44px.
  - Error: suggest-reply gateway failure degrades to manual compose (no
    blocking error).
- **Verification:** Owner reads a customer's whole SMS+email+voice thread on a
  phone and can start a reply.

### U6. Owner-authored outbound reply send path (R6)
- **Goal:** Send a free-text SMS/email reply from the inbox, audited and
  consent-gated — the missing outbound half of two-way messaging.
- **Requirements:** R6
- **Dependencies:** U5
- **Files:**
  - `packages/api/src/routes/conversations.ts`
    (`POST /api/conversations/:id/messages` — authenticated owner send).
  - `packages/api/src/notifications/send-service.ts` (add a generic
    conversational-message send that reuses delivery providers + the dispatch
    ledger; channel chosen by customer `preferred_channel`).
  - `packages/api/src/conversations/*` (persist the outbound message).
  - Tests: `packages/api/src/notifications/send-service.test.ts` (DNC gate +
    dispatch-row written), `packages/api/test/integration/conversation-reply-send.test.ts`.
- **Approach:** Human-authored → direct mutation (Key Decisions), not a
  proposal. Must pass the **same DNC/consent gate** every outbound send uses
  (`DncRepository` check in `send-service.ts`), write a `message_dispatches`
  row (channel sms|email — the ledger already logs both), append the outbound
  `messages` row, and emit an audit event. Quiet-hours/jurisdiction checks
  reused from the SMS template path.
- **Patterns to follow:** `send-service.ts` estimate/invoice send (token,
  recipient resolution, dispatch row, allSettled multi-channel); DNC gate
  already wired there.
- **Test scenarios:**
  - Happy path: owner replies via SMS → dispatch row `sent`, message appended,
    audit emitted.
  - Edge: customer on DNC → send blocked with a clear reason, no dispatch row;
    no `preferred_channel` → defaults sensibly.
  - Error: provider failure marks dispatch `failed`, surfaces to UI, doesn't
    duplicate on retry (idempotency key).
  - Integration (DB): dispatch + message rows persist under the right tenant.
- **Verification:** A reply sent from the inbox reaches the customer, is
  logged, and is suppressed for opted-out numbers.

### U7. Equipment / installed-asset registry (P13-002)
- **Goal:** Track installed equipment per property (e.g., "the Smiths' furnace,
  installed 2019") to power repair-vs-replace and customer-history answers.
- **Requirements:** R7
- **Dependencies:** none (U1 nice-to-have for contact linkage)
- **Files:**
  - `packages/api/src/db/schema.ts` (migration `189_equipment`: `equipment` —
    tenant_id, customer_id, service_location_id, type, make, model, serial,
    installed_at, warranty_expires_at, notes, archived; RLS FORCE).
  - `packages/api/src/equipment/equipment.ts` + `pg-equipment.ts` (new domain).
  - `packages/api/src/routes/equipment.ts` (CRUD scoped to customer/location).
  - `packages/api/src/ai/skills/lookup-equipment.ts` (voice/assistant lookup)
    + register in the skills/voice router.
  - `packages/shared/src/contracts/equipment.ts`.
  - `packages/web/src/pages/customers/CustomerDetail.tsx` (equipment panel).
  - Tests: `packages/shared/src/contracts/equipment.test.ts`,
    `packages/api/src/equipment/equipment.test.ts`,
    `packages/api/test/integration/equipment.test.ts`,
    `packages/api/src/ai/skills/lookup-equipment.test.ts` (mocked gateway/repos).
- **Approach:** Greenfield domain mirroring an existing per-customer entity
  (notes/locations). The voice lookup resolves the customer/property through
  the entity resolver (ambiguity → `voice_clarification`), then reads
  equipment. Feeds future repair-vs-replace estimates and agreement upsells.
- **Patterns to follow:** `notes`/`service_locations` repo + route shape;
  `ai/skills/lookup-catalog.ts` for a read-only skill; entity resolver wiring
  precedent in `ai/resolution/`.
- **Test scenarios:**
  - Happy path: register a furnace on a property → appears on customer detail;
    voice "what furnace do the Smiths have?" returns it.
  - Edge: ambiguous customer reference → one-tap clarification, not a guess;
    archived equipment excluded.
  - Integration (DB): real columns (serial/installed_at) pinned; tenant
    isolation enforced.
- **Verification:** Equipment shows on the customer record and is answerable
  by voice.

### U8. Customer LTV + lifecycle segmentation (P16-001/002)
- **Goal:** Read-only aggregates — lifetime revenue, last-service recency,
  job count, lifecycle segment (new / active / lapsing / dormant) — to drive
  U9 and exec views.
- **Requirements:** R8
- **Dependencies:** U2 (tags/fields enrich segments)
- **Files:**
  - `packages/api/src/reports/customer-ltv.ts` + `pg-customer-ltv.ts` (new
    read-model aggregator).
  - `packages/api/src/customers/timeline-service.ts` or a new
    `customers/segmentation.ts` (derive segment from recency/frequency).
  - `packages/api/src/routes/customers.ts` (expose LTV/segment on detail +
    list enrichment).
  - Tests: `packages/api/src/reports/customer-ltv.test.ts` (pure math on
    fixtures), `packages/api/test/integration/customer-ltv.test.ts` (DB:
    integer-cents sums, tenant isolation — high isolation bar per dispatch
    order).
- **Approach:** Pure aggregation over invoices/payments/jobs in **integer
  cents**. Segment thresholds are derived, configurable later. No writes —
  this is a read model feeding U9 and U12.
- **Patterns to follow:** `reports/pg-money-dashboard.ts`,
  `revenue-by-source` aggregation style.
- **Test scenarios:**
  - Happy path: customer with 4 paid invoices → correct cents LTV + "active".
  - Edge: zero-history customer → "new", LTV 0; refunded/credited amounts
    handled (no float drift).
  - Integration (DB): cross-tenant rows never bleed into an aggregate.
- **Verification:** Customer detail shows lifetime value and a lifecycle
  segment that matches the underlying invoices.

### U9. Bounded re-engagement / win-back (P16-003)
- **Goal:** Surface lapsed customers and *propose* (never auto-send) a
  brand-voiced re-engagement message — found money for an owner who never
  follows up.
- **Requirements:** R9
- **Dependencies:** U8
- **Files:**
  - `packages/api/src/workers/re-engagement-worker.ts` (sweep: find customers
    in "lapsing/dormant" segment with no open thread → raise a
    `send_message`-style proposal).
  - `packages/api/src/proposals/contracts.ts` (+ `/contracts/`: typed
    re-engagement message payload) and an execution handler reusing U6's send.
  - `packages/api/src/proposals/auto-approve.ts` (assert comms stay
    auto-approve-blocked — already true; add a test).
  - Tests: `packages/api/src/workers/re-engagement-worker.test.ts` (mocked
    repos/gateway: selection + proposal raised, idempotency),
    `packages/api/src/proposals/auto-approve.test.ts` (comms never
    auto-approve).
- **Approach:** Narrow sweep worker on the existing P0-009 pattern with a
  per-customer idempotency ledger (one ask per dormancy window). Copy drafted
  via the LLM gateway; output is a **proposal** the owner approves. Hard
  bounded — no audience builder, no cadences beyond a single dormancy nudge
  (PRD non-goal guardrail).
- **Patterns to follow:** `daily-digest-worker` / `estimate-reminder-worker`
  sweep + idempotency-ledger pattern; `feedback-send` DNC-gated proposal.
- **Test scenarios:**
  - Happy path: a 120-day-dormant customer → one re-engagement proposal in the
    queue; owner approves → U6 send fires.
  - Edge: customer with an open thread or on DNC is skipped; re-running the
    sweep doesn't duplicate (idempotency).
  - Error: gateway draft failure logs and skips, never blocks the sweep.
- **Verification:** Dormant customers generate a single approval-gated nudge;
  nothing sends without a tap.

### U10. Business-location (branch) foundation (R10) — **gated**
- **Goal:** Introduce a branch entity below the tenant and let jobs,
  appointments, and staff be assigned to one.
- **Requirements:** R10
- **Dependencies:** **Decision-log reversal of the multi-location non-goal in
  `docs/decisions.md` must land first** (see Key Decisions).
- **Files:**
  - `docs/decisions.md` (record the reversal + rationale before code).
  - `packages/api/src/db/schema.ts` (migration `190_business_locations`:
    `business_locations` — tenant_id, name, address, timezone, phone,
    is_active; add nullable `business_location_id` FK to `jobs`,
    `appointments`, and a `user_business_locations` membership table; RLS
    FORCE, all keyed by tenant_id).
  - `packages/api/src/locations/business-location.ts` + `pg-business-location.ts`
    (new domain) and `packages/api/src/routes/business-locations.ts` (CRUD).
  - `packages/shared/src/contracts/business-location.ts`.
  - `packages/web/src/pages/settings/` (manage branches) + a branch picker in
    job/appointment create.
  - Tests: `packages/shared/src/contracts/business-location.test.ts`,
    `packages/api/src/locations/business-location.test.ts`,
    `packages/api/test/integration/business-locations.test.ts` (DB: FK +
    nullable assignment + tenant isolation).
- **Approach:** Branch is **optional** — null `business_location_id` means
  "whole business" (single-location tenants are unaffected, zero migration
  pain). Tenant remains the RLS boundary (Key Decisions); branch is a column.
  Each branch carries a timezone so reminders/reports can render in branch
  time. **Naming discipline:** `business_locations` ≠ `service_locations`
  (customer addresses) — call out in code comments to prevent confusion.
- **Patterns to follow:** an existing optional-FK additive migration (e.g.
  `appointment_type` 182); tenant-scoped repo pattern in `customers/`.
- **Test scenarios:**
  - Happy path: create two branches, assign a job to branch A and a user to
    branch A → reads back correctly.
  - Edge: existing rows keep `business_location_id` null and behave exactly as
    before (no regression for single-location tenants).
  - Integration (DB): FK integrity, nullable default, cross-tenant isolation
    pinned with real columns.
- **Verification:** A tenant can define branches and tag jobs/appointments/
  staff to them, with single-location tenants unchanged.

### U11. Per-branch visibility + roles (R10) — **gated**
- **Goal:** A branch manager sees and acts only within their branch; the owner
  sees all — enforced at the query layer, not RLS.
- **Requirements:** R10
- **Dependencies:** U10
- **Files:**
  - `packages/api/src/users/*` (add a `branch_manager` role / branch
    membership; extend the auth/tenant context with the caller's branch set).
  - `packages/api/src/middleware/tenant-context.ts` (attach branch scope to
    the request).
  - Job/appointment/customer-list repos (`pg-job.ts`, `pg-appointment.ts`,
    list queries) — apply an optional branch filter when the caller is
    branch-scoped.
  - Tests: `packages/api/src/users/branch-scope.test.ts` (scope derivation),
    `packages/api/test/integration/branch-visibility.test.ts` (DB: a
    branch-manager query returns only branch rows; owner sees all).
- **Approach:** Application-level filter keyed off the caller's branch
  membership; owner/admin bypass. Critically, this is a **visibility** filter
  *inside* the tenant boundary — RLS still guarantees cross-tenant isolation
  (Key Decisions). Mutations check branch membership before write.
- **Patterns to follow:** existing role checks (`owner|dispatcher|technician`)
  and `middleware/tenant-context.ts` request augmentation.
- **Test scenarios:**
  - Happy path: branch-manager lists jobs → only branch A's; owner → all.
  - Edge: a job with null branch is visible to owner; access rule for
    branch-managers to unassigned rows defined and tested.
  - Error/perms: branch-manager attempting to mutate branch B's job is denied
    (and the denial is audited).
  - Integration (DB): the filter is enforced in SQL, not just the app layer
    (mocked-DB not sufficient — pin it).
- **Verification:** A branch manager logs in and sees only their branch; the
  owner sees the whole business.

### U12. Per-branch reporting rollups (R10) — **gated**
- **Goal:** Filter and roll up money/operational reporting by branch so an
  owner can compare locations.
- **Requirements:** R10
- **Dependencies:** U10 (U8 for the LTV/segment dimension)
- **Files:**
  - `packages/api/src/reports/pg-money-dashboard.ts` + `revenue-by-source`
    (add an optional `business_location_id` group/filter).
  - `packages/api/src/reports/customer-ltv.ts` (optional branch dimension).
  - `packages/web/src/pages/` reporting views (branch selector).
  - Tests: `packages/api/src/reports/*.test.ts` (per-branch aggregation math
    in cents), `packages/api/test/integration/branch-reporting.test.ts` (DB:
    rollup sums per branch + tenant isolation).
- **Approach:** Additive group-by on the existing money read-models; null
  branch rolls into an "Unassigned/All" bucket. Integer cents throughout;
  render times in each branch's timezone.
- **Patterns to follow:** `reports/pg-money-dashboard.ts` aggregation;
  `revenue-by-source` grouping.
- **Test scenarios:**
  - Happy path: two branches with different invoices → correct per-branch
    revenue totals; total equals tenant total.
  - Edge: null-branch rows land in "Unassigned"; empty branch reports zero.
  - Integration (DB): sums match underlying invoices per branch, no
    cross-tenant bleed.
- **Verification:** The owner sees revenue/job KPIs broken out per branch that
  reconcile to the business total.

## Risks & Dependencies

- **PRD-reversal risk (Phase 4).** U10–U12 contradict a documented non-goal
  and Jobber doesn't even set a high bar here. Mitigation: gate on the
  `docs/decisions.md` reversal; keep branch optional so single-location
  tenants are untouched; ship Phases 1–3 first (all clear of this risk).
- **Inbox naming collision (U5).** An approval-queue "InboxPage" already
  exists. Mitigation: name the comms surface distinctly (`CommsInboxPage`).
- **Two conflicting "location" concepts (U10).** `service_locations`
  (customer addresses) vs `business_locations` (branches). Mitigation:
  explicit naming + code comments; never overload one for the other.
- **Migration ordering.** New migrations start at `186` (latest is `185`);
  keep them additive and independently reversible.
- **DB-touching units need real integration tests** (U1, U2, U3, U4, U6, U7,
  U8, U10, U11, U12) — mocked-DB tests have previously shipped nonexistent
  columns (entity resolver); pin real columns per CLAUDE.md.

## Open Questions (deferred to implementation)

- **U2 custom-field deletion semantics:** cascade values vs block delete while
  values exist — decide during build.
- **U4 unknown-number policy:** create a lead-linked thread vs hold for review
  — confirm against lead-intake conventions in `routes/leads.ts`.
- **U11 branch-manager access to unassigned (null-branch) rows:** visible vs
  hidden — pick the least-surprising default during build and test it.
- **U10 customer↔branch relationship:** customers stay tenant-wide (shared)
  in this plan; if per-branch customer ownership is later required, that's a
  follow-up, not in R10's "jobs/appointments/staff" scope.
- Exact new proposal-type name for U9 (`send_message` vs `send_reengagement`)
  and final segment thresholds (U8) — resolve against existing contract
  naming.

## Sources & Research

- `docs/competitive-gap-analysis.md` — ICP framing + Jobber head-to-head
  (note: multi-location listed as a non-goal there; this plan reverses it per
  user direction).
- `docs/competitive-analysis.md` — verified build-status corrections (review
  automation, on-my-way, tiered estimates already shipped).
- `docs/stories/crm-parity-dispatch-order.md` — story IDs (P13-00x, P15-00x,
  P16-00x, P20-00x) and the cross-listed/deferred items.
- Code verification this session: `compliance/stop-reply.ts` +
  `sms/inbound-dispatch.ts` (STOP **is** enforced; inbound dispatcher chain),
  `notifications/dispatch-repository.ts` (logs SMS **and** email),
  `db/schema.ts` (no `customer_contacts`/`customer_tags`/`custom_fields`/
  branch tables; latest migration `185`).

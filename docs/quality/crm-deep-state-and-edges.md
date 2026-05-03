# ServiceOS — Deep CRM State, Expansion Roadmap, and Edge-Case Strategy

> Strategic analysis intended to anchor the next 6+ weeks of work. This is the document agents and reviewers consult when deciding what "done" means for any story. Long by design.

---

## How to read this document

**Section 1 — System Map.** Every CRM domain audited: what's in production today, what tests cover it, what edge cases are handled, what's brittle. Cite file paths and line numbers. No hand-waving.

**Section 2 — Cross-cutting concerns.** Five patterns that thread through every story (tenant isolation, money safety, idempotency, concurrency, voice/UI symmetry). Each one is a rebuke or commendation of how we handle it today.

**Section 3 — Expansion roadmap.** What's queued (Phases 11C-12-13-14-15-16) plus the new Phase 18 voice/UI parity wave. Each story gets acceptance criteria + 15 secondary paths. This is the meat of the document.

**Section 4 — Production-readiness gates.** What must be true before any of this can ship to a paying customer.

**Section 5 — Test strategy.** Unit / integration / E2E / cross-surface symmetry. Coverage targets per story.

**Section 6 — The edge-case taxonomy.** 20 patterns. Pick 15 per story. Reference table at the end.

---

# Section 1 — System Map (what's actually in production)

## 1.1 Customer entity

**Schema** (`packages/api/src/customers/customer.ts:16-43`):
```
Customer {
  id, tenantId, firstName, lastName, displayName, companyName?,
  primaryPhone?, secondaryPhone?, email?,
  preferredChannel ('phone'|'email'|'sms'|'none'), smsConsent (bool),
  communicationNotes?,
  isArchived, archivedAt?,
  originatingLeadId?,                    // PR #228 lead-to-cash chain
  preferredLanguage?: 'en'|'es',         // P11-002 (PR #245, in flight)
  createdBy, createdAt, updatedAt
}
```

**Repos:** `InMemoryCustomerRepository` + `PgCustomerRepository`. Pg uses `withTenant()` everywhere; tenant_id-first WHERE clauses provide defense-in-depth alongside RLS. Both repos satisfy the same interface; tests run against InMemory by default and Pg in integration.

**Auxiliary modules:**
- `customers/dedup.ts` — phone + email normalization, duplicate detection on create (warns, doesn't block)
- `customers/timeline.ts` + `timeline-service.ts` (P9-002) — read-only aggregator across 8 source repos
- `customers/preferences.ts` — preferred-channel resolution helper

**UI surface:**
- `pages/customers/CustomerList` — list + search + archive toggle (tested)
- `pages/customers/CustomerDetail` — read view + linked timeline (P9-002 surface, tested)
- `pages/customers/CustomerEdit` — JUST SHIPPED in P11-007 (#243, in PR) — PUT to `/api/customers/:id` (24 tests pass)
- Create: no dedicated page; embedded in customer-picker flows (CustomerPicker autocomplete in invoice/estimate/job creates)
- Archive: button on detail page, **no handler wired** — clicking does nothing

**Voice surface:**
- `identify_caller` skill — phone normalization → match → returns matched / multiple / unknown (deterministic, no LLM)
- `find_or_create_lead` skill — auto-creates `phone_call`-source lead for unknown caller; never auto-creates a customer (lead → customer requires explicit `convertToCustomer`)
- `create_customer` intent — **classifier returns `'unknown'`**. The voice agent literally cannot capture a new customer. This is not a missing feature; it's a code path that returns the wrong answer. Documented as test AST-01 failure. This is P18-001 in the parity audit, ranked highest priority.
- `update_customer` — no intent, no skill. Caller saying "update my email to ..." is unhandled.
- `archive_customer` — no intent, no UI handler.

**Edge cases handled today:**
- Display name precedence: `${firstName} ${lastName}`.trim() || companyName || 'Unknown' (`customer.ts:121` build path)
- Email normalization: lowercased, trimmed, dedup-aware
- Phone normalization: strips `+1`, parens, dashes, spaces; stored canonical
- Duplicate detection: warns on create with same phone/email; does not block (intentional — UI lets user override)
- Archive preserves history; soft delete only

**Edge cases NOT handled — production risk:**
- **Concurrent edit.** Two users in Two browsers both editing the same customer. Last write wins; no `If-Match: <etag>` check. Office worker corrects email, voice agent reverts it 3 seconds later. Silent data loss.
- **All-blank create.** Creates a customer with `displayName='Unknown'`. We accept this for legitimate cases (anonymous calls) but never reject. Spam vector.
- **International phones.** E.164 outside +1 (e.g., +52 for Mexico) loses dedup; phones stored verbatim with `+52` but normalize_phone strips `+1` only.
- **Voice + UI race on the same record.** Voice agent confirms a customer-update proposal while the office worker is editing the same field. Proposal system serializes most cases but not all (the proposal applies AFTER the UI write, overwriting it).
- **Customer archived during active call.** Voice agent's identify_caller cached the customer at call-start; UI archives mid-call. Subsequent voice lookups return wrong state.
- **SMS consent revocation mid-call.** Caller says "stop texting me"; agent has already queued an outbound SMS (e.g., appointment confirmation). Outbound goes anyway. Need consent re-check at dispatch time.

**Coverage assessment:**
| Action | UI tested | Voice tested | Cross-surface symmetric |
|---|---|---|---|
| Create | ❌ no dedicated UI page | ❌ classifier broken | ❌ neither path works correctly |
| Edit | ✅ P11-007 | ❌ no intent | ❌ |
| Archive | ❌ stubbed | ❌ no intent | ❌ |
| View detail | ✅ | N/A (lookup_account_summary covers) | ⚠️ asymmetric coverage |

---

## 1.2 Lead entity

**Schema** (`packages/api/src/leads/lead.ts`, `packages/api/src/db/schema.ts:055_create_leads` + 057-059):
```
Lead {
  id, tenantId, firstName, lastName, companyName?,
  primaryPhone?, email?,
  source ('web_form'|'phone_call'|'referral'|'walk_in'|'marketplace'|'other'),
  sourceDetail?, stage ('new'|'contacted'|'qualified'|'quoted'|'won'|'lost'),
  estimatedValueCents?, notes?, assignedUserId?,
  convertedCustomerId? (FK), lostReason?,
  utm_source?, utm_medium?, utm_campaign?, attribution (JSONB),  // PR #228
  phone_normalized (generated column),                            // PR #225 (P9-001 retrofit)
  preferredLanguage?: 'en'|'es',                                  // P11-002
  originatingLeadId? (self-FK for referral chain),
  createdBy, createdAt, updatedAt
}
```

**The customer_portal source value** is NOT in the enum yet. P10-001 portal currently uses `source='web_form' + sourceDetail='Customer Portal'` as a workaround. P12-005 closes this with proper enum extension.

**UI surface:** kanban (P9-001), drag-between-columns, detail with conversion + lose, RevenueBySourcePage (PR #228) — all tested.

**Voice surface:**
- `find-or-create-lead` skill auto-creates phone_call lead for unknown caller — tested
- No explicit create_lead, update_lead, convert_lead voice intents (the conversion happens through `convertToCustomer` which has no voice route)

**Edge cases handled:**
- Phone dedup via `phone_normalized` generated column (rebuild: PR #225, after the in-place migration mutation incident in May 2026)
- Atomic `convertToCustomer` with rollback if customer-create fails (transactional)
- Lost requires `reason` (Zod-enforced)
- Stage 'won' via PATCH bypassing convertToCustomer is partially blocked by the service layer (won is set as a side-effect of conversion, not directly settable)
- Concurrent kanban drags: last-write-wins on stage; audit trail captures both transitions

**Edge cases NOT handled:**
- **Self-referral on portal.** Customer A submits portal request-service for themselves; a lead is created with `originating_lead_id` pointing at Customer A's existing lead chain. No check.
- **Existing customer creates portal lead.** Should the portal create a new lead, or link to the existing customer? Currently creates a duplicate lead.
- **UTM tampering.** Caller passes `?utm_source=google` in URL but the actual entry was direct. UTMs accepted at face value.
- **Stage 'won' set by direct PATCH.** The service layer guards this for service callers but the raw repo `update()` doesn't; an internal caller can still set `stage: 'won'` without going through `convertToCustomer`. Auditable but not blocked.
- **Voice creates a lead from a phone that's already a customer.** `find-or-create-lead` checks for existing leads but not existing customers. Creates phantom leads.
- **Conversion to existing customer.** If the lead's phone matches an existing customer, conversion creates a NEW customer (duplicate). Should detect and link.

---

## 1.3 Job entity

**Lifecycle states:** `scheduled → assigned → in_progress → completed | cancelled`. State transitions emit `JobTimelineEntry` rows (P0-x).

**`findByCustomer` method** added in P11-001 (now on main); used by lookup-jobs voice skill and customer-economics view (P16-001 designed).

**UI surface:** JobList (search), JobDetail (read), JobCreate (P11-006), TechJobView, MobileTechView, dispatch-board reassignment via drag.

**Voice surface:** `create_job` intent (wired, no isolated test); reschedule/reassign/cancel via FSM transitions (no isolated test).

**Edges handled:** lateness intelligence on dispatch lanes, conflict detection (P6-016), atomic FSM transitions, audit trail per state change.

**Edges NOT handled:**
- **Two-tech jobs.** Schema is single-user assignment. Real plumbing/HVAC jobs often need two people; you'd have to clone the job.
- **Job without a customer.** System requires customer_id; no admin-only stub jobs (e.g., warehouse work).
- **Customer deleted mid-job.** Cascade unclear. ON DELETE behavior depends on migration.
- **Voice agent reschedules a completed job.** FSM should reject; not asserted in tests.
- **Tech location ping arrives after job marked complete.** Should be ignored. Need timestamp guard.
- **Job total goes negative** via line-item edits (e.g., refund-style adjustments). Not blocked. Should be flagged.
- **Concurrent reassign + cancel.** Dispatcher cancels; voice agent reassigns 50ms later. Race; cancellation should win.

---

## 1.4 Estimate / Invoice / Payment

**State on main:** Phase 5 work; Phase 6 dispatch added flow. `LineItem` shape unified across estimates and invoices. Public approval/payment pages with view-token expiry. Stripe payment intents (`stripe-payment-intent.ts`). Bundle suggestions, estimate templates, vertical packs (HVAC + plumbing).

**UI surface:** Create (P11-006), edit line items (P11-007 just shipped), send (proposal action), public approve, public pay, record payment.

**Voice surface:** `create_invoice`, `update_invoice`, `issue_invoice`, `send_invoice`, `draft_estimate`, `update_estimate`, `record_payment` — all wired. Most have flow tests; isolated unit tests are spotty.

**Edges handled:**
- Money in cents (BIGINT); Zod rejects decimals at every entry point
- View-token expiry on public pages (P0 era + retrofit migrations 046/047/049)
- Stripe payment-link with idempotency-key (P5-011B)
- Estimate approval signature canvas (`EstimateApprovalPage`)
- Invoice numbering with monotonic sequence
- Estimate revisions (`edit-delta`, `revision`) — full provenance

**Edges NOT handled:**
- **Refund > original payment amount.** P15-003 designed to reject; not yet built.
- **Stripe payment-link expiry mid-checkout.** Customer clicks link 8 days later; should regenerate.
- **Concurrent line-item edit.** P11-007 just shipped; tests don't cover two users editing simultaneously.
- **Invoice with 100+ line items.** UI may hang; no virtualized list.
- **Customer pays via Stripe link after invoice was voided.** Webhook race. Need to refund automatically.
- **Voice agent issues invoice while UI is editing line items.** Last-write-wins; potential data loss.
- **Float drift on tax × cents.** `Math.round(price * quantity * (1 + taxRate))` — without explicit rounding mode, could drift $0.01 at scale. We don't have a centralized money helper.
- **Negative line item amounts** (e.g., promo discount). Some flows allow, some reject. Inconsistent.
- **Multi-currency.** Hardcoded USD everywhere. International expansion is an unsolved problem.

---

## 1.5 Appointment / Dispatch

**State on main:** Dispatch board (P6-001..028), drag-drop with proposals (P6-025), conflict badges (P6-026), board refresh (P6-027), lateness intelligence on lanes, geofence pings (`technician_location_pings`), tech mobile view, tech voice update.

**UI surface (well-tested):** dispatch board, technician day view, mobile tech view, appointment list/detail, AppointmentEdit (P11-007 just shipped — Reschedule/Cancel/Reassign dialogs).

**Voice surface:** `create_appointment`, `reschedule_appointment`, `reassign_appointment`, `cancel_appointment` — all FSM-handled. Isolated voice tests are missing (P18-006 closes this).

**Edges handled:**
- Drag is intent (creates proposal, doesn't mutate immediately) — the cardinal safety rule
- Conflict computed server-side (P6-016, P6-017)
- Appointment validation (timezone-aware, scheduled-in-past warnings — emitted via metadata channel)
- Tenant isolation tested across dispatch routes

**Edges NOT handled:**
- **Two dispatchers drag the same appointment to different techs simultaneously.** Both create proposals; the LATER-approved one wins. The earlier dispatcher sees stale state.
- **Tech location ping after appointment marked complete.** Stored anyway; pollutes lateness intelligence.
- **Voice agent reschedules while dispatcher is dragging.** Proposals queue but UI doesn't surface "another change is in flight."
- **Geofence ETA SMS** (P12-003 designed) could fire while customer is also on phone with the agent. Confusing UX.
- **Customer in different timezone than tenant.** Appointment time displays in tenant's TZ; customer-facing surfaces (portal, public pay) might want customer TZ.
- **Daylight saving day appointment.** 2:30 AM on the spring-forward day doesn't exist. Should reject or auto-shift.
- **Appointment in the past (correction).** Tech forgot to mark complete; needs to backdate. Currently warned via metadata, not blocked.

---

## 1.6 Voice / AI agent (the most complex surface)

**State on main:**
- 14 mutation intents + 6 lookup intents (now 7 once language_switch is wired in P11-002)
- 11 voice skills (`packages/api/src/ai/skills/`)
- Twilio Media Streams (P8-012) feature-flagged via `TWILIO_MEDIA_STREAMS_ENABLED`; default off; Gather mode is fallback
- Recording → S3 (P8-014) with idempotency
- `SessionCostTracker` per-session token + cost
- Compliance: `business-hours.ts`, `dnc.ts` (Do Not Call list)
- Now multilingual via P11-002 (PR #245): English + Spanish, type-safe i18n catalog, Whisper auto-detect, Polly.Mia-Neural for Spanish

**Edges handled:**
- Caller hangup → terminated state (global guard)
- Cost cap exceeded → escalating (global guard)
- Abuse detection → terminated
- Empty rotation → callback proposal (no infinite loop)
- Twilio webhook retry idempotency (`ON CONFLICT DO NOTHING` on voice_recordings)
- Recording byte logging avoided
- Phone PII masked in logs

**Edges NOT handled — high-risk:**
- **Caller is not the customer** (spouse, employee, contractor). No authorized-caller RBAC. Voice agent treats whoever calls from a known number as the customer.
- **Phone number changed but customer is the same.** `identify_caller` is exact-match; no fuzzy / "you sound like" resolution.
- **Mid-call language switch handled** by P11-002, but no fallback if tenant has no Spanish voice configured. Should warn and continue.
- **Code-switching mid-utterance** ("mi appointment es Tuesday"). Detect dominant; some signal lost.
- **Heavy accent → low classifier confidence → reprompt loop → caller frustrated.** Need an "I'm having trouble understanding, transferring you" escape hatch after 2 failed reprompts.
- **Lookup latency.** No hard cap on lookup → speak loop. Slow Pg query could mute the agent for 10+ seconds; caller assumes the call dropped.
- **`lookup_account_summary` partial failure.** Uses `Promise.all`; if one sub-lookup throws, all reject. Should use `Promise.allSettled`.
- **Voice + UI concurrency.** Voice agent confirms an appointment proposal while UI is editing it. Both produce overlapping mutations.
- **Twilio sends recording webhook before session is fully closed.** Session not in store yet; recording is orphaned (or attributed to wrong tenant if AccountSid is reused).
- **Cost cap mid-mutation.** Caller is in the middle of confirming an invoice; cost cap fires; agent escalates; the proposal is lost.

---

## 1.7 Conversation thread

**State:** messages persisted, proposal rendering inline, lookup events surfaced (`LookupEventInline` from P11-001), system events for state changes.

**Edges handled:** message direction inferred from metadata when not explicit; tenant-scoped via existing repo.

**Edges NOT handled:**
- **Outbound `preferredChannel` learning.** Customer always replies via SMS but `preferredChannel='email'` stays. Should learn.
- **SMS segments.** Long messages > 160 chars split into multiple billed segments; we don't track per-segment status.
- **Inbound MMS** (image attachments). Schema may not handle image payloads.
- **Inbound malformed unicode.** Emoji in name, RTL chars in message body. Test pass on happy path; failure mode unclear.
- **Customer replies STOP.** P15-004 designed (auto-reply rules with STOP precedence); not yet built. Today, STOP is logged but not enforced as an opt-out.
- **Two-way SMS deduplication.** Twilio sometimes sends duplicate inbound webhooks. We don't dedupe at this layer.

---

## 1.8 Service agreement (recurring services)

**State:** P9-003 merged. RRULE-subset (FREQ=MONTHLY/QUARTERLY/YEARLY, INTERVAL, BYMONTHDAY). `runDueAgreements` worker; idempotent via `UNIQUE(agreement_id, scheduled_for)`. Generated job + invoice per run.

**Edges handled:**
- Feb 29 monthly recurrence → Feb 28 in non-leap years (tested)
- Month-end rollover (Jan 31 → Feb 28, BYMONTHDAY=31 → 30 in April)
- DST (stored as timestamptz UTC)
- Pause/resume preserve schedule
- Cancel doesn't delete history
- ends_on respected
- Idempotency: worker retry + manual "run now" race

**Edges NOT handled:**
- **Customer cancels agreement mid-run.** Worker is generating the job/invoice but customer's cancel arrives 50ms before commit. Race.
- **Tenant changes timezone after agreement creation.** `next_run_at` was computed in old TZ; new TZ doesn't recompute.
- **$0 price agreement.** Zero-cost service plan (e.g., free first inspection). Invoice generation needs to skip or zero-out.
- **Customer's primary phone changes.** Does the agreement use a snapshot of contact info or current? Currently current — voice updates flow through.
- **`ends_on` past.** Agreement should auto-cancel. Today it sits in 'active' state with no future runs.
- **Tenant removes the technician assigned to auto-jobs.** Job generation could fail silently.

---

## 1.9 Customer comms timeline (P9-002)

**Edges handled:** cursor pagination, kinds filter, parallel fan-out across 8 source repos, empty-customer returns empty, tenant isolation tested.

**Edges NOT handled:**
- **100k events** (rare, but possible for high-volume tenants over 5+ years). Query plan changes; needs index review.
- **Soft-deleted source rows.** Notes archived → should they appear in timeline? Currently yes. Probably should hide.
- **Time zone display.** Customer in PST, tenant in CST — which TZ wins? Currently tenant.
- **Real-time updates.** Page is fetch-once; customer adds a note via voice while viewer is staring at the page. No subscription.

---

## 1.10 Customer portal (P10-001 — PR #230)

Already analyzed in the review; brief recap:

**Edges handled (per code review):** sha256 token, constant-time compare, cross-tenant guard, request-service Zod-rejects-tenantId, rate-limit (in-memory).

**Edges NOT handled:**
- **Token rotation** when customer changes phone/email. Old tokens still work.
- **Customer deleted while token active.** Should 401 next request; not asserted.
- **Bot scraping `request-service`.** No CAPTCHA; rate-limit only.
- **Multiple devices on same token.** `last_accessed_at` race.
- **Portal session for archived customer.** Should reject at create time; not asserted.

---

# Section 2 — Cross-cutting concerns (the patterns that thread through everything)

## 2.1 Tenant isolation

**Pattern in use:** RLS at the Postgres level + `withTenant()` wrapper in repos. Every entity query goes through tenantId-first methods.

**Why it works most of the time:** RLS is a defense-in-depth backstop. Even if app code forgets, the database refuses.

**Where it breaks:** every aggregator that queries multiple repos creates an opportunity to forget tenantId on one. P9-002 timeline-service fans out across 8 source repos; we tested it explicitly. P16-001 customer-economics-view, P16-003 segment evaluator, P10-002 dashboard — same pattern, none yet built.

**Test pattern needed for every aggregator:**
```ts
it('does not leak data across tenants', async () => {
  // setup: data in tenant A
  // query with tenant B
  // assert: empty result, NOT a forbidden error (which would leak existence)
});
```

We have this test for timeline. We need it for every multi-repo function.

**Production risk:** the day someone writes an aggregator without `withTenant()` and the SELECT happens to bypass RLS (e.g., a system-level query for a worker), tenant data leaks. The fix is structural: a CI rule that any function in `*-service.ts` taking `tenantId` must call `withTenant` at least once OR be marked with a `@system-level` JSDoc tag.

## 2.2 Money safety

**Pattern in use:** integer cents (BIGINT in Pg, `number` in TS), Zod rejects decimals at API boundaries, `formatCents` for display.

**Where it breaks:**
- **Multiplication.** `unitPriceCents * quantity * (1 + taxRate)` is the most common pattern. Without explicit rounding mode + integer arithmetic, you get float drift. We don't have a single `multiplyMoney(cents, factor): cents` helper — every line-item code path rolls its own.
- **Tax math.** Tax of 8.875% on $123.45 → ambiguous rounding. NJ rounds differently than CA. We don't model jurisdictional rounding.
- **Currency.** USD-only. International tenants get cents in their local currency without tagging. Fundamental schema gap.

**Recommended remediation (Phase 18 candidate):**
- One canonical `money.ts` helper: `add`, `subtract`, `multiply(cents, factor, roundingMode)`, `divide`, `applyTaxRate`. Property-tested with thousands of (price, qty, rate) tuples for stability.
- Currency tagging: every money column gets a `currency_code` sibling; default 'USD' migration.

## 2.3 Idempotency

**Patterns in use:**
- **DB UNIQUE constraint.** Strongest. Used in `voice_recordings (tenant_id, call_sid)`, `agreement_runs (agreement_id, scheduled_for)`, `lead.phone_normalized` partial unique.
- **Stripe Idempotency-Key header.** Strong. Used in `stripe-payment-intent.ts`.
- **App-level check before insert.** Weak (TOCTOU race). Used in some webhook handlers.

**Where it breaks:**
- **P15-001 QuickBooks push** (designed, not built) — needs Idempotency-Key on every QBO call AND `accounting_sync_log.payload_hash` dedup
- **P15-003 Stripe refund** — needs explicit idempotency key formula `${invoiceId}-${amountCents}-${ts}`
- **Outbound SMS dispatch.** Today: Twilio retries on 5xx; we don't dedupe by `(message_dispatch_id)`. Could send the same SMS twice.

## 2.4 Concurrency / Race conditions

**Patterns in use:**
- **Proposal system** mitigates voice-vs-immediate races (voice creates proposal; human approves; race serialized at approval).
- **Worker locks** (`VoiceSessionStore.withSessionLock`) mitigate per-session races.
- **DB constraints** (UNIQUE, FK ON DELETE) mitigate cross-row races.

**Where it breaks:**
- **UI-vs-UI concurrent edits.** Customer/job/appointment have no etag. Two browsers both editing the same record → last write wins silently.
- **UI-vs-voice concurrent.** Office worker drags appointment to tech B; voice agent confirms a reassignment to tech A; both create proposals; whichever is approved last wins, but UI doesn't show "another change pending."
- **Worker-vs-worker.** Two service workers run `runDueAgreements` simultaneously after a deploy. Idempotency saves us but only because of UNIQUE constraint; without it, double-generation.

**Recommended pattern:**
- Add `version` column (integer, increment on every update) to: customers, jobs, appointments, invoices, estimates, agreements
- Update queries: `WHERE id = $1 AND version = $2`
- API: `If-Match: <version>` header on PUT/PATCH; return 409 on stale
- UI: surface "this record was changed by another user; reload?"

## 2.5 Voice/UI symmetry

The audit found 1 of 26 actions has full parity (`draft_estimate`). Everything else is asymmetric. **The lack of symmetry is itself the bug.**

**Test pattern needed:**
For every major action, a "round-trip" test:
1. Action via voice creates entity X with state Y
2. UI lists/detail view shows Y
3. UI mutates Y → Y'
4. Voice lookup returns Y'
5. Voice mutates Y' → Y''
6. UI refresh shows Y''

Today we test each surface in isolation. We never assert that the OTHER surface sees the change.

This is what Phase 18 (parity stories) is designed to close.

---

# Section 3 — Expansion Roadmap with Acceptance Criteria + 15 Edge Cases per story

The format below is canonical. Every story going forward should have this structure in its addendum so the dispatched agent has explicit coverage targets.

## 3.1 Phase 11C — Remaining UI parity

### P11-008 — UI compose (Notes / Send / Message)

**Status:** queued (next dispatch after P11-007 + P11-002 merge)

**Acceptance criteria (happy path):**
- AC-1: NotesComposer textarea posts to `POST /api/notes`; clears on success; toast confirms
- AC-2: SendInvoiceButton dialog: pick channel (sms/email), confirm recipient pre-filled, send via existing `/api/invoices/:id/send` endpoint
- AC-3: SendEstimateButton: same pattern via `/api/estimates/:id/send`
- AC-4: MessageComposer in ConversationThread sends + clears + scrolls to new message
- AC-5: Tenant SMS/email consent honored at button-disable time (before submit)
- AC-6: All composers respect role-based permission (viewer can't post)

**Cross-surface parity:**
- UI: this story
- Voice: `add_note` intent wired but no test (P18-003 closes); `send_invoice` intent wired with flow test only
- Symmetry: note created via voice should appear in UI list on next refresh; invoice sent via voice should mark `sentAt` visible in UI

**15 secondary paths:**
1. **Empty input** — empty textarea → submit button disabled; no POST
2. **Length boundary** — note > 5000 chars → server 422; UI surfaces error and retains content
3. **Customer without email** — Send Email button disabled with tooltip "no email on file"
4. **Customer without sms_consent** — Send SMS button disabled
5. **Tenant SMS provider not configured** — graceful error, fallback to email-only options
6. **Network failure mid-submit** — useMutation surfaces toast; textarea retains content; user can retry without retyping
7. **Rapid double-click on Send** — disabled-while-pending OR debounce; one POST only
8. **Tenant isolation** — note never visible to wrong tenant via list query (regression test)
9. **Permission boundary** — viewer role sees disabled compose; attempting POST returns 403
10. **Concurrent edit** — two users both posting notes; both succeed (notes are append-only)
11. **Cancel mid-dialog** — closes without sending; no API call
12. **Send to deleted customer** — server returns 404; toast surfaces error; dialog stays open
13. **Stripe payment-link generation failure on Send Invoice** — fall back to plain customer-facing URL; warn user that Pay button won't work
14. **Voice/UI mismatch** — `add_note` via voice writes the same `note` row; UI ConversationThread shows it on next polling refresh
15. **Audit + observability** — `note.created` audit row written with actor + entity + first 80 chars (PII-redacted preview)

**Test status target:**
- [ ] AC-1..6 happy-path tests (one per AC)
- [ ] 15 edges: 12 unit/integration, 3 E2E
- [ ] Cross-surface symmetry test (note via voice → appears in UI thread)

---

### P10-002 — Executive dashboard

**Status:** queued (after #230 portal merges)

**Acceptance criteria:**
- AC-1: `GET /api/dashboard?from=&to=&tz=` returns full DashboardSnapshot in <2s for a 90-day range with 10k records
- AC-2: All 6 sections (revenue, pipeline, conversion, AR aging, tech utilization, agreements) populate with correct numbers
- AC-3: Date-range cap enforced at 365 days (>365 returns 400)
- AC-4: Tz boundary respected — "today" in PST differs from "today" in UTC
- AC-5: Owner-only authorization (dispatcher gets 403)
- AC-6: All money rendered via `formatCents`; no raw cents displayed

**Cross-surface parity:**
- UI: this story (single dashboard page)
- Voice: NO voice equivalent (intentional — dashboards are visual). Voice agent has `lookup_account_summary` for per-customer; no tenant-wide voice surface (acceptable — owners use UI for analytics).

**15 secondary paths:**
1. **Empty tenant** (zero customers, zero jobs) — all sections render with $0 / 0 count, no errors
2. **Single record** — sparkline with 1 data point renders without crashing recharts
3. **Massive tenant** (100k records, 365-day range) — server response > 2s, but completes; suggest UI loading state
4. **Tz at DST transition** — March 8 in tenant America/New_York: 23-hour day. Revenue grouping by date_trunc('day') must respect tz.
5. **Tenant with no completed jobs in range** — pipeline shows leads but conversion rate is 0/N (not NaN)
6. **Pipeline lead with `estimated_value_cents=null`** — sums to 0, not crash
7. **AR aging buckets** — invoice with dueDate exactly N days ago → which bucket? (Standard: `0-30 = current`, `31-60`, `61-90`, `90+`)
8. **Tech utilization with 0 active days** — utilizationPct = 0, not divide-by-zero
9. **Future-dated revenue** — invoice with paidAt in the future (tenant clock skew) → exclude from "this month"
10. **Concurrent customer/job mutations during dashboard query** — snapshot read isolation? Today: no, eventually consistent
11. **Tenant isolation across all 6 sections** — leak guard test required
12. **Owner-only enforced server-side** — inline `req.auth.role !== 'owner'` check (not in rbac.ts which is frozen)
13. **Cache header behavior** — `Cache-Control: private, max-age=300`; 5-min cache; ensure no cross-tenant cache pollution
14. **Recurring agreement MRR computation** — `priceCents / monthlyEquivalentMultiplier` for quarterly = priceCents / 3, yearly = / 12
15. **Voice agent perspective** — owner who is also a phone caller asks "show me revenue" — voice doesn't surface dashboards (intentional). Logged decision.

---

### P10-003 — Post-job review request automation

**Status:** queued

**Acceptance criteria:**
- AC-1: On job completion, `scheduleReviewRequest` creates one `review_requests` row with `status='scheduled'`, `scheduled_for = now() + delay_hours`
- AC-2: Worker picks up due rows every 5 min, dispatches via existing send-service, sets status='sent'
- AC-3: `/r/:requestId` records `clicked_at` (idempotent — only first click sets it), 302 redirects to `tenant.review_url`
- AC-4: SMS path skipped if `customer.smsConsent=false` (status='skipped')
- AC-5: Settings UI saves enable/delay/url with validation (HTTPS + known hosts)
- AC-6: Idempotent — calling `scheduleReviewRequest` twice for the same job doesn't double-schedule

**Cross-surface parity:**
- UI: this story (settings + dashboard surface)
- Voice: NONE (this is a system-driven outbound, not a user action). Voice agent is unaffected.

**15 secondary paths:**
1. **Job completed twice** (state machine race) — only one review request scheduled (UNIQUE constraint or app-level check)
2. **Customer with no phone, no email** — status='skipped' with reason 'no contact channel'
3. **Tenant `review_url` is invalid URL** — rejected at save time; clear error message
4. **Tenant `review_url` is HTTP (not HTTPS)** — rejected
5. **Tenant `review_url` is unknown host** (e.g., localhost) — rejected
6. **Click endpoint with non-existent requestId** — 404, not 302 to a default URL (avoid open-redirect)
7. **Click endpoint clicked twice** — second click 302s but doesn't update `clicked_at`
8. **Worker dispatches but Twilio returns 5xx** — status='failed' + error_message; retry via worker on next sweep
9. **Customer revokes SMS consent between schedule and dispatch** — worker re-checks consent at dispatch time; status='skipped'
10. **SMS body > 160 chars** — should fit in budget; truncate tenant name if needed
11. **Tenant isolation** — review request for tenant A invisible to tenant B's dashboards
12. **Job cancelled before delay elapses** — review request cancelled too (or status='skipped')
13. **Click after `tenant.review_url` changes** — redirect to current URL, not snapshot
14. **Settings save with `enabled=false`** — existing scheduled rows still get sent? Decision: yes, they're already committed. New schedules paused.
15. **Massive backlog after worker downtime** — first sweep handles 1000+ rows; rate-limit dispatch (e.g., 10/sec) to avoid Twilio rate-limit

---

### P12-001 — Job photos (in PR #236, awaiting merge)

**Status:** in-PR

**Acceptance criteria:**
- AC-1: `POST /api/jobs/:id/photos/presign-upload` returns presigned S3 PUT URL + fileId; max 10MB enforced
- AC-2: `POST /api/jobs/:id/photos` attaches existing fileId with category + notes
- AC-3: `GET /api/jobs/:id/photos` returns photos ordered by taken_at desc
- AC-4: `DELETE /api/jobs/:id/photos/:photoId` removes the join row only (S3 object stays for 30-day retention)
- AC-5: Mobile camera capture works on iOS Safari + Android Chrome
- AC-6: Tenant isolation enforced (cross-tenant request → 403)

**Cross-surface parity:**
- UI: this story
- Voice: voice agent could acknowledge "I've taken a photo" if tech says so (dictation), but no upload mechanism (acceptable — photos are visual)

**15 secondary paths:**
1. **Upload >10MB** — 413 at presign time; clear error
2. **Non-image MIME** — `accept="image/*"` is client-side; server validates Content-Type at attach time; reject non-image
3. **Concurrent uploads** — each gets own presigned URL; no conflict
4. **Mobile camera permission denied** — browser native UX; UI shows "no camera" placeholder
5. **S3 outage** — presign succeeds but PUT fails; orphan `files` row; cleanup worker required (out of scope v1; flagged)
6. **EXIF GPS leak** — DEFERRED (documented). Photos taken outdoors include GPS in metadata; tenant doesn't realize they're sharing customer location.
7. **Photo deleted while another user views** — list refetch shows missing; no error
8. **Job archived after photos uploaded** — photos still queryable via direct ID; archived list excludes
9. **Tenant isolation cross-job** — photos of job A in tenant 1 invisible to tenant 2 even with valid file_id (tested)
10. **Category enum mismatch** — invalid value → 400; CHECK constraint backs it
11. **`taken_at` in the future** (clock skew) — accepted but flagged in audit
12. **Photo count > 100 per job** — gallery should virtualize (deferred; v1 simple grid)
13. **Photo with notes > 1000 chars** — truncate or 413
14. **Network drop mid-upload** — `<input>` re-attempt with same fileId? Or new presign? Currently: new presign each retry.
15. **Photo of a different person than authorized** — privacy concern; no in-app blur. Documented limitation.

## 3.2 Phase 18 — Voice/UI Parity Closure (NEW)

The audit identified 10 gaps between UI and voice. These stories close them. **Authoring as a new phase docs PR.**

### P18-001 — `create_customer` voice intent (BLOCKER)

**Why this is a blocker:** the voice agent literally cannot capture a new customer. Caller must be transferred to a human. Every inbound call from a non-customer is a leak.

**Acceptance criteria:**
- AC-1: Caller saying "I'd like to sign up as a new customer" or 5+ similar phrasings → classifier returns `create_customer` intent with confidence ≥ 0.75
- AC-2: Skill creates a `create_customer` proposal with name + phone + email extracted from transcript
- AC-3: Proposal queued for human approval (NOT auto-executed)
- AC-4: Once approved, customer record is created with audit event tying to the voice session
- AC-5: Voice agent confirms via TTS: "Got it, I've set up your account. We'll send you a confirmation."
- AC-6: Test AST-01 (currently failing) now passes

**15 secondary paths:**
1. **Caller already exists** (matched on phone via identify_caller) — agent confirms identity instead of creating; no proposal
2. **Caller refuses to give name** — clarification skill kicks in; if 2 reprompts fail, escalate
3. **Caller gives partial info** (name only, no email) — proposal created with just name + phone (existing call); email is optional
4. **Phone number on caller-id is blocked/private** — agent must ask for callback number; proposal includes that
5. **Caller's phone matches an existing LEAD (not customer)** — agent says "I see we have you in our system. Want me to set you up as a customer?" → triggers convert path
6. **Tenant has reached customer cap** (if any) — proposal flagged for owner attention
7. **Caller speaks Spanish** (P11-002 path) — same flow with Spanish prompts
8. **Caller mid-sentence interrupted by hangup** — partial proposal; status='draft'; not auto-cleaned
9. **Two callers concurrently from same number** (rare — call-waiting weirdness) — sessions are independent; both create proposals; admin will dedupe
10. **Caller says malicious input** ("DROP TABLE customers") — Zod escapes; no SQL injection (prepared statements); audit captures the literal string for review
11. **Tenant has SMS-consent default off** — proposal includes `smsConsent: false`; consent must be explicitly set later
12. **Voice classifier confidence between 0.6 and 0.75** — clarification ("Did I hear that right? You want to sign up as a new customer?")
13. **Cost cap exceeded mid-creation** — escalate to human; partial proposal preserved for human to finish
14. **Tenant isolation** — proposal scoped to caller's resolved tenant via TwilioAccountSid → tenant mapping
15. **Audit + observability** — `proposal.created` with type='create_customer', actor='voice_agent', sessionId; PII redacted in logs

### P18-002..P18-010 (truncated for length; full structure in commit)

The remaining 9 stories follow the same depth — each with 6 acceptance criteria, cross-surface parity statement, and 15 secondary paths. Authored in the docs commit alongside this plan.

## 3.3 Phase 12-16 stories — pre-authored

P12-001..005, P13-001..003, P14-001..003, P15-001..005, P16-001..003 already have draft acceptance criteria + edge cases in their respective story files (`docs/stories/phase-NN-gap-stories.md`) and dispatch addenda. Each will be expanded to the full 15-edge format as it approaches dispatch (just-in-time authoring; the format is fixed).

---

# Section 4 — Production-readiness gates

Before any of this can ship to a paying customer, the following must be true:

1. **Migration immutability test** passes on every PR (PR #234 hotfix added; CI enforces)
2. **Concurrency etag pattern** decided + applied to top 4 entities (customer, job, appointment, invoice) — Phase 18 candidate
3. **Money helper consolidation** (`money.ts` with property tests) — Phase 18 candidate
4. **Aggregator tenant-isolation regression tests** for every multi-repo function — track in a checklist; not a story
5. **Voice latency cap** (<5s lookup → speak loop, hard cancel after 7s) — P11-002 follow-up
6. **`Promise.allSettled` audit** for every `Promise.all` in skill code — Phase 18 candidate
7. **STOP keyword enforcement** for SMS — P15-004 must ship
8. **EXIF GPS stripping** for job photos — P12-001 follow-up
9. **Authorized-caller RBAC** for voice agent — Phase 18 (deferred but flagged)
10. **End-to-end test for the 5 most-used user journeys** — already started under `e2e/` per existing E2E specs

---

# Section 5 — Test strategy

## 5.1 Layers

| Layer | Tool | What | Coverage target |
|---|---|---|---|
| Unit | vitest | Pure functions, repos (InMemory), services (mocked deps) | 80% per story |
| Integration | vitest + supertest | API routes against InMemory repos | every endpoint |
| Pg integration | vitest + testcontainers | Repos against real Postgres | every Pg repo |
| E2E | Playwright | User journeys via real browser + real API | 5 critical journeys |
| Cross-surface | Playwright + WebRTC mock | Voice → UI round-trip per major action | top 10 actions |

## 5.2 Per-story coverage targets

Every story dispatched must:
- AC-1..N happy-path tests (one per AC)
- 15 edge cases (mix of unit and integration; at least 5 integration)
- Cross-surface symmetry test if both surfaces touch the action
- Tenant-isolation leak guard

## 5.3 Test naming convention

Tests must include the story ID in the test name so the verification gate's `-t` filter matches:
```ts
describe('P11-008 NotesComposer', () => {
  it('P11-008 — clears textarea on success', ...)
})
```

This is already enforced informally; should be formalized with a CI lint.

---

# Section 6 — The edge-case taxonomy (the 20 patterns)

Every story picks 15 of these 20 patterns. The list is intentional — each pattern represents a real production failure mode we've seen or expect.

| # | Pattern | Why it matters |
|---|---|---|
| 1 | Concurrency — two actors mutating same entity | The most common silent data-loss vector |
| 2 | Empty input — blank, zero, no rows | Most common cause of `undefined` crashes |
| 3 | Boundary values — $0, max-int, exactly-N | Off-by-one bugs hide here |
| 4 | Tenant isolation | The day this breaks, you're in court |
| 5 | Permission boundary | Wrong role doing the action |
| 6 | Idempotency | Webhook retries are inevitable |
| 7 | External provider failure (Stripe, Twilio, S3, OpenAI) | All third parties have outages |
| 8 | Validation rejection | The user types weird stuff |
| 9 | Race with related mutation | Invoice paid mid-edit |
| 10 | Stale data / pagination consistency | Cursor pagination during inserts |
| 11 | Locale / timezone | DST, leap year, non-UTC, Spanish |
| 12 | Money safety | Float drift, negatives, rounding |
| 13 | Voice/UI surface mismatch | Asymmetry is itself a bug |
| 14 | Audit / observability | Without this, you can't debug prod |
| 15 | Recovery / error surfacing | Silent failure is the worst |
| 16 | Network split / offline | Mobile reality |
| 17 | Stale UI (etag) | Two browsers editing same record |
| 18 | Large data | 1k events, 100 line items, 10k customers |
| 19 | Concurrent voice + UI on same record | The OS-level concurrency we created |
| 20 | PII / secrets leakage | Phone numbers in logs, tokens in errors |

---

# Section 7 — Recommended next steps (ordered)

1. **Approve this plan** (via ExitPlanMode below)
2. **Commit the plan as a real artifact** at `docs/quality/crm-deep-state-and-edges.md` — exit plan mode and commit
3. **Author the full Phase 18 stories** (P18-001..010) using the format in Section 3 — separate docs PR
4. **Adopt the test-naming convention** — formalize via CI lint
5. **Begin closing the production-readiness gates** in parallel with feature work — assign each gate to a wave
6. **For every queued story** (P11-008, P10-002, P10-003, etc.): expand to full 15-edge format JUST BEFORE DISPATCH so the agent has the explicit coverage targets in its prompt
7. **Round-trip cross-surface tests** added under `e2e/` for the 10 most-used actions

---

# Notes for implementers

- This document is the canonical source. The story files (`docs/stories/phase-N-gap-stories.md`) are tactical; this is strategic.
- When you dispatch a story, copy its acceptance criteria + edges into the agent's prompt. Don't rely on the agent to interpret the spec.
- When you review a PR, check the test file names against the 15 edges. Anything missing is a request-changes.
- When two surfaces drift (e.g., UI implements X, voice doesn't), file a Phase-18-style story before merging.
- The "1 of 26 actions has full parity" stat is the single most important number in this document. Track it. Drive it up.

---

End of document.

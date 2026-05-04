# Phase 15 — Integrations + Retention

> **5 stories** | QuickBooks, Calendar sync, Refunds, SMS auto-reply, Referrals

---

## Purpose

Service businesses run on QuickBooks (accounting) and Google/Outlook (scheduling). Without sync, owners do double-entry — daily friction kills adoption. Plus retention features that the audit ranked high: refunds + store credit, two-way SMS auto-reply, referral program.

## Exit Criteria

Owner connects QuickBooks → paid invoices appear in QBO Sales Receipts within 5 min. Tech's Google Calendar shows tomorrow's appointments synced two-way. Owner refunds $50 of a $200 invoice via Stripe; balance applied to customer's store credit. Customer texts "YES" to confirm an appointment; system auto-replies. Customer shares referral code; friend books; original customer auto-credited $25.

## Foundations already in place

- `packages/api/src/payments/stripe-payment-intent.ts` — Stripe API wrapper (P15-003 reuses for refund)
- `packages/api/src/conversations/` — message threading (P15-004 reuses for SMS routing)
- `packages/api/src/notifications/send-service.ts` — SMS dispatch
- `packages/api/src/leads/lead-service.ts` — referral attribution path (P15-005 extends)
- `packages/api/src/ai/orchestration/intent-classifier.ts` — reused for SMS intent classification (P15-004)

---

## Story Specifications

### P15-001 — QuickBooks Online integration

> **Size:** XL | **Layer:** Integration | **AI Build:** Low | **Human Review:** Heavy

**Dependencies:** none

**Allowed files:** `packages/api/src/integrations/quickbooks/**, packages/api/src/routes/integrations.ts, packages/api/src/db/schema.ts (migration 071 only), packages/api/src/app.ts (wiring only), packages/api/src/workers/qbo-sync-worker.ts, packages/api/test/integrations/quickbooks/**, packages/api/test/workers/qbo-sync-worker.test.ts, packages/web/src/pages/settings/IntegrationsSettings.tsx, packages/web/src/components/integrations/QuickBooksConnect.tsx, packages/web/src/components/integrations/QuickBooksSyncStatus.tsx, packages/web/src/components/integrations/__tests__/**, packages/web/src/api/integrations.ts`

**Build prompt:** (1) Migration `071_create_accounting_integrations`: TWO tables.

`accounting_integrations`: `id, tenant_id (UNIQUE), provider (enum: quickbooks, xero — only quickbooks for v1), access_token_encrypted (TEXT), refresh_token_encrypted (TEXT), realm_id (TEXT — QBO's company id), connected_at, last_synced_at, status (enum: active, expired, disconnected, error), error_message`. RLS.

`accounting_sync_log`: `id, tenant_id, integration_id (FK), entity_type (enum: invoice, customer, payment), entity_id (UUID — internal id), external_id (TEXT — QBO id), action (enum: push, pull, conflict), status (enum: success, failed), payload_hash, error_message, synced_at`. RLS. Index on (tenant_id, integration_id, synced_at desc).

(2) OAuth flow: redirect to Intuit's OAuth → callback at `/api/integrations/quickbooks/callback` → exchange code for tokens → encrypt at rest using existing crypto util (find one or fallback to AES-256-GCM with `process.env.ENCRYPTION_KEY`). (3) QBO client wrapping `node-fetch` to `https://quickbooks.api.intuit.com/v3/company/<realmId>` (no new SDK dep). (4) Sync worker: every 5 min, find paid invoices since last sync, push as QBO Sales Receipts. Push customers as needed (FK chain). De-dupe via accounting_sync_log. (5) Routes: `GET /api/integrations`, `POST /api/integrations/quickbooks/connect` (returns OAuth URL), `GET /api/integrations/quickbooks/callback`, `POST /api/integrations/quickbooks/disconnect`, `GET /api/integrations/quickbooks/status`. (6) Web: IntegrationsSettings page; Connect button kicks off OAuth; SyncStatus widget shows last sync + error count + retry button.

**Scope explicitly limited:** v1 = OAuth + push paid invoices + push customers as FK prerequisites. NOT in scope: pull QBO data on first sync, conflict resolution UI, mapping classes/items/tax codes. Document deferred items in PR.

**Review prompt:** Verify tokens encrypted at rest. Verify refresh token rotation works (QBO tokens expire). Verify dedup via payload hash. Verify per-tenant isolation of QBO realm. Verify worker survives QBO 429 rate-limits with backoff.

**Required tests:** OAuth callback exchanges code for tokens (mock Intuit); push invoice creates QBO sales receipt (mock API); push customer creates QBO customer; dedup prevents double-push; refresh token rotation; tenant isolation.

---

### P15-002 — Google + Outlook calendar 2-way sync per technician

> **Size:** L | **Layer:** Integration | **AI Build:** Low | **Human Review:** Heavy

**Dependencies:** none

**Allowed files:** `packages/api/src/integrations/calendar/**, packages/api/src/routes/calendar-integrations.ts, packages/api/src/db/schema.ts (migration 072 only), packages/api/src/app.ts (wiring only), packages/api/src/workers/calendar-sync-worker.ts, packages/api/test/integrations/calendar/**, packages/api/test/workers/calendar-sync-worker.test.ts, packages/web/src/pages/settings/CalendarIntegrationsSettings.tsx, packages/web/src/components/integrations/CalendarConnect.tsx, packages/web/src/components/integrations/__tests__/**, packages/web/src/api/calendar-integrations.ts`

**Build prompt:** (1) Migration `072_create_calendar_integrations`: TWO tables.

`calendar_integrations`: `id, tenant_id, user_id (per-tech), provider (enum: google, outlook), access_token_encrypted, refresh_token_encrypted, calendar_id, sync_enabled BOOL DEFAULT true, last_synced_at, status, error_message`. RLS. UNIQUE (tenant_id, user_id, provider).

`calendar_sync_log`: `id, tenant_id, integration_id (FK), direction (enum: push, pull), appointment_id (nullable), external_event_id (TEXT), action (enum: create, update, delete, conflict), status, error_message, synced_at`. RLS.

(2) OAuth flows for Google + Outlook (encrypted token storage same pattern as QBO). (3) Sync worker every 2 min: PUSH — for each tech with active integration, push next 14 days of Serviceos appointments to their external calendar. PULL — read external blocks back; surface as "external busy" markers on dispatch board (not as appointments). (4) Routes mirror QBO pattern. (5) Web: per-user calendar settings; tech connects own calendar.

**Conflict policy:** Serviceos-wins on collision (the dispatch decision is authoritative). Document in PR.

**Review prompt:** Verify per-user (not per-tenant) integration. Verify token encryption. Verify push/pull are clearly separated (avoid feedback loops). Verify externally-deleted events don't delete Serviceos appointments (only mark as "external block removed"). Verify worker handles Google 429 + Outlook 429.

**Required tests:** OAuth code exchange for both providers (mocked); push appointment creates external event; pull external event creates "external busy" marker; deletion handling; per-user isolation.

---

### P15-003 — Refunds + store credit

> **Size:** M | **Layer:** Financial | **AI Build:** Medium | **Human Review:** Heavy

**Dependencies:** none

**Allowed files:** `packages/api/src/refunds/**, packages/api/src/customer-credits/**, packages/api/src/routes/refunds.ts, packages/api/src/routes/customer-credits.ts, packages/api/src/db/schema.ts (migration 073 only), packages/api/src/app.ts (wiring only), packages/api/test/refunds/**, packages/api/test/customer-credits/**, packages/web/src/pages/invoices/InvoiceRefund.tsx, packages/web/src/components/invoices/RefundDialog.tsx, packages/web/src/components/customers/CreditBalance.tsx, packages/web/src/pages/invoices/InvoiceDetail.tsx (add Refund button only), packages/web/src/pages/customers/CustomerDetail.tsx (add credit balance only), packages/web/src/components/__tests__/**, packages/web/src/api/refunds.ts, packages/web/src/api/customer-credits.ts`

**Build prompt:** (1) Migration `073_create_refunds_and_credits`: TWO tables.

`refund_events`: `id, tenant_id, invoice_id (FK), original_payment_id (FK to payments), amount_cents BIGINT, refund_type (enum: stripe_refund, manual_credit), stripe_refund_id (TEXT, nullable), reason, status (enum: pending, completed, failed), processed_by_user_id, processed_at, error_message, created_at`. RLS.

`customer_credits`: `id, tenant_id, customer_id (FK), amount_cents BIGINT (positive = credit balance), source_type (enum: refund, manual, referral), source_id (UUID — refund_event id, etc.), notes, expires_at (nullable), created_by, created_at`. RLS. Computed balance = SUM(amount_cents) per customer.

(2) Service: `processRefund(tenantId, invoiceId, amountCents, type, reason)`. For stripe_refund: call Stripe Refunds API on the original payment_intent. For manual_credit: skip Stripe, just create customer_credits row. Always idempotent (check for existing refund_event with same invoice + amount in last 60s). (3) Service: `applyCustomerCredit(tenantId, customerId, invoiceId, amountCents)` — creates negative customer_credits row + payments row tied to invoice. (4) Routes: `POST /api/invoices/:id/refund`, `GET /api/customers/:id/credits`, `POST /api/customers/:id/credits/apply`. Owner-only role check (no rbac.ts edits — inline guard). (5) Web: Refund dialog on InvoiceDetail; CreditBalance widget on CustomerDetail.

**Review prompt:** Verify only refund up to original payment amount minus prior refunds. Verify Stripe idempotency key. Verify partial refund returns to original payment method (or store credit if Stripe fails). Verify owner-only authorization. Verify tenant isolation.

**Required tests:** full refund happy path (mocked Stripe); partial refund; refund > original amount rejected; manual credit creates row; apply credit reduces invoice balance; owner-only enforced; tenant isolation.

---

### P15-004 — Two-way SMS auto-reply rules

> **Size:** M | **Layer:** Communication | **AI Build:** Medium | **Human Review:** Heavy

**Dependencies:** none

**Allowed files:** `packages/api/src/sms-rules/**, packages/api/src/routes/sms-rules.ts, packages/api/src/db/schema.ts (migration 074 only), packages/api/src/app.ts (wiring only), packages/api/src/conversations/sms-router.ts (or extend existing inbound SMS handler — discover at dispatch time), packages/api/test/sms-rules/**, packages/web/src/pages/settings/SmsRulesSettings.tsx, packages/web/src/components/settings/__tests__/SmsRulesSettings.test.tsx, packages/web/src/api/sms-rules.ts`

**Build prompt:** (1) Migration `074_create_sms_auto_reply_rules`: `id, tenant_id, name, trigger_keyword (CITEXT — case-insensitive match on inbound SMS body), match_mode (enum: exact, contains, starts_with), reply_template (TEXT — supports {{customer_name}}, {{appointment_time}} etc.), action (enum: reply_only, reply_and_set_status, reply_and_create_note), action_payload JSONB, is_active BOOL DEFAULT true, priority INT DEFAULT 100, created_at, updated_at`. RLS. Index (tenant_id, priority asc).

(2) Built-in rules (seeded for every tenant on first activation): STOP/UNSUBSCRIBE → opt-out + reply "You've been unsubscribed."; YES/CONFIRM → confirm next pending appointment; START/SUBSCRIBE → opt back in. (3) Service: `findMatchingRule(tenantId, inboundBody)` returns highest-priority match. `executeRule(rule, message, customer)`. (4) Route: full CRUD on /api/sms-rules. (5) Web: SmsRulesSettings page (rule list + edit form). (6) Hook into existing inbound SMS path — find it via grep for "twilio" + SMS handlers in conversations.

**Voice intent classifier reuse:** for inbound SMS that doesn't match a keyword rule, optionally route through the existing intent_classifier as a fallback (off by default, behind tenant flag `sms_ai_classifier_enabled`).

**Review prompt:** Verify STOP keyword honored before any other rule fires. Verify only respond to inbound SMS (never proactive). Verify reply template variables interpolate correctly (or render literal if no customer match). Verify priority ordering. Verify tenant isolation. Verify rate-limit (max 3 auto-replies per customer per hour).

**Required tests:** STOP triggers opt-out + reply; YES confirms appointment; custom rule matches per mode; priority order; rate-limit enforced; STOP dominates other matches.

---

### P15-005 — Customer referral program

> **Size:** M | **Layer:** Marketing | **AI Build:** Medium | **Human Review:** Moderate

**Dependencies:** P15-003 (uses customer_credits for reward issuance)

**Allowed files:** `packages/api/src/referrals/**, packages/api/src/routes/referrals.ts, packages/api/src/db/schema.ts (migration 075 only), packages/api/src/app.ts (wiring only), packages/api/src/leads/lead-service.ts (additive — extend createLead to accept optional referralCode), packages/api/test/referrals/**, packages/web/src/pages/customers/CustomerReferral.tsx, packages/web/src/components/referrals/ReferralCodeShare.tsx, packages/web/src/pages/customers/CustomerDetail.tsx (add referral section only), packages/web/src/api/referrals.ts`

**Build prompt:** (1) Migration `075_create_referrals`: TWO tables.

`referral_codes`: `id, tenant_id, customer_id (FK), code TEXT UNIQUE (8-char alphanumeric, generate on first request), reward_amount_cents BIGINT NOT NULL, max_uses INT (nullable — uncapped if null), uses_count INT DEFAULT 0, is_active BOOL DEFAULT true, created_at`. RLS. UNIQUE (tenant_id, customer_id) WHERE is_active = true.

`referral_credits`: `id, tenant_id, referrer_customer_id (FK), referred_customer_id (FK, nullable), referred_lead_id (FK, nullable), referral_code_id (FK), reward_amount_cents, status (enum: pending, issued, void), customer_credit_id (FK, nullable — set when issued), issued_at, created_at`. RLS.

(2) Service: `getOrCreateReferralCode(tenantId, customerId)`. `recordReferralOnLead(tenantId, leadId, code)` — call from `createLead` when referralCode passed. On lead conversion to customer (existing path), trigger `issueReferralCredit(tenantId, referralCreditId)` which creates a `customer_credits` row tied to the referrer. (3) Routes: `GET /api/customers/:id/referral-code`, `POST /api/customers/:id/referral-code/regenerate`, `GET /api/referrals/:code/lookup` (public — for landing page). (4) Web: CustomerReferral section on CustomerDetail; ReferralCodeShare component (code + copy + SMS share button).

**Review prompt:** Verify code generation is collision-resistant (8-char base32 → ~1T combinations, retry on collision). Verify reward only issued ONCE per referral_credits row (idempotent). Verify referrer can't refer self. Verify max_uses enforced. Verify tenant isolation.

**Required tests:** code generation is unique; recordReferralOnLead links credit; lead conversion issues credit; double-issuance prevented; self-referral rejected; max_uses enforced; tenant isolation.

# Phase 15 (Integrations + Retention) — Multi-Agent Dispatch Addendum

## Wave plan

| Wave | Stories | Run-mode | Blocks |
|---|---|---|---|
| 15A | P15-001 | single agent (XL — QBO is wide and high-review) | unlocks 15B |
| 15B | P15-002 | single agent (L — calendar OAuth surface) | unlocks 15C |
| 15C | P15-003, P15-004, P15-005 | 3-way parallel (orthogonal surfaces) | sprint complete |

15A and 15B are sequential because both touch app.ts integration wiring + secrets handling. 15C's three stories are independent (financial / SMS / marketing).

## Migration ledger

- 071: P15-001 `accounting_integrations` + `accounting_sync_log`
- 072: P15-002 `calendar_integrations` + `calendar_sync_log`
- 073: P15-003 `refund_events` + `customer_credits`
- 074: P15-004 `sms_auto_reply_rules`
- 075: P15-005 `referral_codes` + `referral_credits`

---

## P15-001 — QuickBooks Online integration

**Wave:** 15A
**Migration number reserved:** 071
**Forbidden files:**
- `packages/api/src/db/pg-base.ts`
- `packages/shared/**`
- `packages/api/src/auth/rbac.ts`
- `packages/api/src/invoices/**` (READ ONLY)
- `packages/api/src/customers/**` (READ ONLY)
- `packages/api/src/payments/**` (READ ONLY)

**Allowed files:** as listed in story.

**Verification gate:**
```bash
cd /home/user/Serviceos && \
  (cd packages/api && npx tsc --project tsconfig.build.json --noEmit) && \
  (cd packages/api && npm test -- -t "quickbooks|qbo|accounting|P15-001") && \
  (cd packages/web && npm test -- --run -t "QuickBooks|Integrations|P15-001")
```

**Risk note:**
- **Token encryption**: AES-256-GCM with `process.env.ENCRYPTION_KEY`. If env var unset in dev, fall back to dev-only marker (NEVER plaintext storage).
- **OAuth callback URL**: must be HTTPS for prod; allow http://localhost in dev.
- **Refresh token rotation**: QBO's refresh tokens have a 100-day max lifetime; surface this in status UI.
- **Rate limiting**: QBO allows ~500 req/min; worker uses simple backoff on 429.
- **Scope explicitly limited**: OAuth + push paid invoices + push customers as FK prerequisites. Document deferrals in PR.

**Implementation hints:**
1. Read `packages/api/src/payments/stripe-payment-intent.ts` for the OAuth-token-storage pattern.
2. QBO API: `https://quickbooks.api.intuit.com/v3/company/<realmId>/salesreceipt`. Use `node-fetch` (global).
3. Worker pattern: mirror `recurring-agreements-worker.ts`.

---

## P15-002 — Calendar 2-way sync (Google + Outlook)

**Wave:** 15B
**Migration number reserved:** 072
**Forbidden files:**
- `packages/api/src/db/pg-base.ts`
- `packages/shared/**`
- `packages/api/src/auth/rbac.ts`
- `packages/api/src/appointments/**` (READ ONLY — push side reads; pull side writes a separate "external_busy_blocks" surface, not appointments)
- `packages/api/src/users/**` (READ ONLY)

**Allowed files:** as listed in story.

**Verification gate:**
```bash
cd /home/user/Serviceos && \
  (cd packages/api && npx tsc --project tsconfig.build.json --noEmit) && \
  (cd packages/api && npm test -- -t "calendar|google-calendar|outlook|P15-002") && \
  (cd packages/web && npm test -- --run -t "Calendar|P15-002")
```

**Risk note:**
- **Per-user OAuth**: each tech connects own calendar. Never share tokens across users.
- **Feedback loops**: PUSHing an event then PULLing it back must not create a duplicate. De-dupe via external_event_id stored in calendar_sync_log.
- **External deletions**: do NOT delete Serviceos appointments when external event vanishes. Just clear the external_event_id.
- **Webhook vs polling**: v1 = polling (every 2 min). Webhooks (Google push notifications, Microsoft Graph subscriptions) deferred.

**Implementation hints:**
1. Google Calendar API: `https://www.googleapis.com/calendar/v3/calendars/primary/events`.
2. Outlook: Microsoft Graph `https://graph.microsoft.com/v1.0/me/events`.
3. Use `node-fetch`. Don't add SDK deps.

---

## P15-003 — Refunds + store credit

**Wave:** 15C
**Migration number reserved:** 073
**Forbidden files:**
- `packages/api/src/db/pg-base.ts`
- `packages/shared/**`
- `packages/api/src/auth/rbac.ts`
- `packages/api/src/invoices/invoice.ts` (interface — do NOT modify)
- `packages/api/src/payments/payment.ts` (interface — do NOT modify)
- `packages/api/src/payments/stripe-payment-intent.ts` (READ ONLY — call existing API)

**Allowed files:** as listed in story.

**Verification gate:**
```bash
cd /home/user/Serviceos && \
  (cd packages/api && npx tsc --project tsconfig.build.json --noEmit) && \
  (cd packages/api && npm test -- -t "refund|customer-credit|P15-003") && \
  (cd packages/web && npm test -- --run -t "Refund|CreditBalance|P15-003")
```

**Risk note:**
- **Stripe idempotency key**: required on every refund call. Use `${invoice_id}-${amount_cents}-${created_at}` hash.
- **Owner-only**: inline `if (req.auth.role !== 'owner') return 403;` — do NOT modify rbac.ts.
- **Refund > original**: reject. `SUM(prior refunds) + new amount <= original payment.amount_cents`.
- **Stripe failure → store credit fallback**: on Stripe API error, fall back to creating a customer_credits row with notes explaining the Stripe failure.

---

## P15-004 — Two-way SMS auto-reply rules

**Wave:** 15C
**Migration number reserved:** 074
**Forbidden files:**
- `packages/api/src/db/pg-base.ts`
- `packages/shared/**`
- `packages/api/src/notifications/**` (READ ONLY — call existing send-service)
- `packages/api/src/conversations/conversation-service.ts` (READ ONLY — append messages via existing service)
- `packages/api/src/ai/orchestration/intent-classifier.ts` (READ ONLY — reuse for fallback)

**Allowed files:** as listed in story.

**Verification gate:**
```bash
cd /home/user/Serviceos && \
  (cd packages/api && npx tsc --project tsconfig.build.json --noEmit) && \
  (cd packages/api && npm test -- -t "sms-rule|sms-auto-reply|P15-004") && \
  (cd packages/web && npm test -- --run -t "SmsRules|P15-004")
```

**Risk note:**
- **STOP must dominate**: built-in STOP keyword fires before any tenant rule, regardless of priority.
- **Reply-only on inbound**: never proactive SMS from this path.
- **Rate-limit**: 3 auto-replies per customer per hour, hard cap.
- **Template variables**: render literal if no customer match (e.g. unknown caller). Don't crash.

**Implementation hints:**
1. Find existing inbound SMS handler — likely in `routes/telephony.ts` or `conversations/sms-router.ts`.
2. Mirror `lookup_part_availability` voice skill for the optional intent_classifier fallback.

---

## P15-005 — Customer referral program

**Wave:** 15C
**Migration number reserved:** 075
**Forbidden files:**
- `packages/api/src/db/pg-base.ts`
- `packages/shared/**`
- `packages/api/src/customers/**` (READ ONLY)
- `packages/api/src/customer-credits/**` (READ ONLY — call P15-003 service)

**Allowed files:** as listed in story.

**Verification gate:**
```bash
cd /home/user/Serviceos && \
  (cd packages/api && npx tsc --project tsconfig.build.json --noEmit) && \
  (cd packages/api && npm test -- -t "referral|P15-005") && \
  (cd packages/web && npm test -- --run -t "Referral|P15-005")
```

**Risk note:**
- **Code collision**: 8-char base32 = ~1T combinations. On INSERT collision, retry up to 3 times.
- **Self-referral**: reject if `referrer_customer_id === referred_customer_id` at issue time.
- **Idempotent issuance**: `referral_credits.status='issued'` is one-way; never re-issue a credit.
- **Cross-story dependency**: P15-005 needs P15-003 merged for `customer_credits` to exist. Pre-flight verifies via `git log origin/main`.

**Implementation hints:**
1. `referral_credits.referrer_customer_id` is the giver; `referred_customer_id` is the recipient (after lead conversion).
2. Issue credit only on lead → customer conversion (existing path in `lead-service.convertToCustomer`).
3. UI ReferralCodeShare: "Copy code" button + "Share via SMS" button (uses `sms:?body=...` deeplink on mobile).

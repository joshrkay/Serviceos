# QA Manual Test Plan

**Last Updated**: 2026-10-13  
**Frequency**: Every 2-3 days  
**Scope**: Full application, all user-facing flows

## Pre-Flight Checks

- [ ] **Build Verification**: `cd packages/api && npx tsc --project tsconfig.build.json --noEmit` (0 errors)
- [ ] **Test Suite**: `npm test` (all suites complete)
- [ ] **Dependencies**: `npm audit` (known vulnerabilities only, no new ones)
- [ ] **No uncommitted changes** affecting production code

---

## Web Application Tests

### Authentication & Onboarding
- [ ] Signup form displays correctly (form validation works)
- [ ] Email verification link works (send & click)
- [ ] Login redirects correctly post-signup
- [ ] Logout clears session + redirects to login
- [ ] OAuth state binding works (no CSRF vulnerability)
- [ ] Environment schema validates at startup (empty env values are unset)

### Proposal/Estimate Management
- [ ] Create estimate form displays all fields
- [ ] Estimate auto-save works (localStorage)
- [ ] Estimate approval flows execute cleanly
  - [ ] Auto-approve when confidence > threshold
  - [ ] Show human approval dialog when confidence low
  - [ ] Rejection reason captures correctly
- [ ] Proposal gating: missing fields block approval ✅
- [ ] Entity resolver: ambiguous customer names → clarification prompt
- [ ] Line items resolve to catalog (no uncatalogued items over threshold)
- [ ] Money calculations use cents, never floating point
- [ ] Invoice & appointment creation from approved proposals

### File Uploads
- [ ] File upload form binds declared size into signature ✅
- [ ] Presigned PUT URLs enforce Content-Length header
- [ ] Upload >100MB fails with proper error message
- [ ] Download works via presigned GET link

### Voice Integration
- [ ] Inbound call connects and greets
- [ ] Call recording triggers on connect
- [ ] Voice clarification (ambient disambiguation) works:
  - [ ] "Which customer?" → single-tap selection
  - [ ] "Create what type?" → limited intent options
  - [ ] Follow-up turn answers clarification
- [ ] Estimate draft via voice voice → shows in web UI same-session
- [ ] Emergency dispatch detection triggers:
  - [ ] Flooding/fire/intrusion keywords activate
  - [ ] Escalation initiated immediately
  - [ ] On-call notification sent
- [ ] Call transfer/escalation:
  - [ ] Transfer dial-out completes ⚠️ (currently not wired)
  - [ ] Hold music plays during transfer
  - [ ] Call ends cleanly if transfer fails

### Real-Time Features
- [ ] WebSocket connects (gated on live DB membership) ✅
- [ ] Proposal updates in real-time across tabs
- [ ] Token expiration closes WebSocket ✅
- [ ] Session revocation closes WebSocket ✅
- [ ] No unauthorized members access /api/ws ✅

### Mobile (React Native) — 44px+ tap targets, 320px width
- [ ] App starts without crashes
- [ ] Login/signup accessible and readable at 320px width
- [ ] All buttons ≥44px (iOS) / ≥48px (Android)
- [ ] Estimate approval form doesn't overflow
- [ ] Keyboard doesn't overlap text input
- [ ] Forms submit cleanly

---

## API Layer Tests

### Audit & Logging
- [ ] Every mutation (create/update/delete) emits audit event
- [ ] Unauthenticated webhook failures throttled (no log spam) ✅
- [ ] Audit rows include timestamp, actor, action, tenant_id
- [ ] Query parameter logging excludes sensitive values (passwords, tokens)
- [ ] CSP headers align with web edge before SPA shell ✅

### Database & RLS
- [ ] All entities have `tenant_id` column
- [ ] RLS prevents cross-tenant data access
- [ ] Money calculations in DB (not rounded locally)
- [ ] No floating-point money stored
- [ ] Foreign keys cascade correctly (customer delete → invoices, estimates stay)

### Voice Call Handling (Telephony)
- [ ] Twilio adapter receives inbound calls
- [ ] Media stream initializes (disclosure protocol)
- [ ] Language detection on first utterance ✅
- [ ] Language switch (ES ↔ EN) works
- [ ] TTS fallback triggers when primary provider times out ⚠️
- [ ] Audio codec conversions (MP3 → PCM):
  - [ ] ElevenLabs PCM streams directly ✅
  - [ ] OpenAI TTS (non-PCM) triggers fallback ⚠️
- [ ] Media stream disconnects cleanly on call end
- [ ] Idle timeout (4s audio silence) → tear down ✅

### AI Proposal Generation
- [ ] LLM calls route through gateway (never direct to vendor)
- [ ] Proposal payload validated by Zod before approval gate
- [ ] Missing required fields block approval:
  - [ ] `customerId` (uuid format required) ✅
  - [ ] `scheduledStart` / `scheduledEnd` (for appointments) ✅
  - [ ] `lineItems` (for invoices, non-empty) ✅
- [ ] Confidence scoring works (low confidence → human review)
- [ ] Cost caps enforce per-tenant per-call limits ✅
- [ ] Catalog resolution validates AI-drafted prices:
  - [ ] Price found in catalog → accept ✅
  - [ ] Price not in catalog → downgrade confidence below threshold ✅

### Emergency Dispatch & On-Call
- [ ] Emergency keywords trigger escalation ✅
- [ ] On-call notification sent to tenant owner
- [ ] E1 follow-up task created (callback reminder) ⚠️ **BROKEN** (no callMeBackRepo)
- [ ] Emergency transfer dials out ⚠️ **BROKEN** (setPendingTransferTwiml not wired)
- [ ] If no owner number: gracefully fallback, don't drop call

### Webhook Handling (P0-014)
- [ ] Twilio status callbacks processed
- [ ] Call metrics recorded (duration, outcome, cost)
- [ ] Idempotency: duplicate webhook (same callSid) = no double-charge
- [ ] Webhook signature verification (Twilio X-Twilio-Signature)
- [ ] Rate-limit handling (503 backoff)

### Background Jobs (P0-009)
- [ ] Email job queued when estimate approved
- [ ] Email sent via Resend (if wired) or Twilio SMS
- [ ] Job retries on transient failure
- [ ] Job marked complete after success
- [ ] Failed jobs logged with reason

### Environment & Configuration
- [ ] Production env schema enforced at boot ✅
- [ ] Missing required vars → fail fast (e.g., DATABASE_URL)
- [ ] Invalid vars (bad URLs, bad keys) → error logged
- [ ] Secrets never logged (token masking active)

---

## End-to-End Flows

### Happy Path: Estimate → Approval → Invoice
1. [ ] Create customer (name, phone, address)
2. [ ] Create estimate (customer, line items, labor, tax)
3. [ ] Review estimate on web
4. [ ] Auto-approve (high confidence) OR request human approval
5. [ ] Convert to invoice
6. [ ] Invoice displays correct total (line item + tax + labor, in cents)
7. [ ] Payment link generated (Stripe or custom)
8. [ ] Audit log shows all 4 events (create, review, approve, convert)

### Inbound Call: Voice → Estimate
1. [ ] Caller dials business number
2. [ ] Call connects, greeting plays
3. [ ] Caller: "I need a water heater replacement estimate"
4. [ ] AI extracts intent: `create_estimate`
5. [ ] AI extracts customer (new or existing)
6. [ ] AI asks: "Which customer?" (if ambiguous) → caller taps option
7. [ ] AI collects line items (labor, parts, address)
8. [ ] Proposal generated, confidence scored
9. [ ] If confidence high: "I'll email you the estimate"
10. [ ] If confidence low: "Does $X sound right?" → confirm
11. [ ] Estimate appears in web UI same call
12. [ ] Caller receives estimate via SMS or email ✅

### Emergency Call: Voice → Escalation → On-Call Notification
1. [ ] Caller: "Water is pouring in from the roof"
2. [ ] AI detects emergency keyword (`flooding`)
3. [ ] System escalates immediately (no gate delay)
4. [ ] On-call dispatcher notified via SMS + email ⚠️
5. [ ] Dispatcher dials out to escalate ⚠️ **BROKEN**
6. [ ] Call logs emergency flag in audit trail ✅
7. [ ] E1 follow-up task created for next morning ⚠️ **BROKEN**

### Integration: File Upload + Proposal
1. [ ] Job photo uploaded (>5MB)
2. [ ] Presigned PUT URL enforces size ✅
3. [ ] File stored in cloud (S3/Supabase)
4. [ ] File reference linked to job/estimate
5. [ ] File accessible in proposal view (URL served via presigned GET)

---

## Performance & Load

- [ ] Web app loads in <2s (DCP < 2s)
- [ ] Estimate approval completes <500ms (API)
- [ ] Voice TTS latency <1s (first audio bytes)
- [ ] Concurrent calls (5+) don't degrade service
- [ ] Database queries optimized (no N+1, indexes used)

---

## Regression Checklist

### Recently Fixed (Must Not Regress)
- [ ] WebSocket gated on live DB membership (not just token) ✅
- [ ] File upload size binding in presigned signature ✅
- [ ] Environment schema enforced at boot ✅
- [ ] OAuth states bound to prevent CSRF ✅
- [ ] Language detection on first utterance ✅
- [ ] Audit rows throttled for unauthenticated webhook failures ✅
- [ ] CSP headers aligned across API + web edge ✅
- [ ] Proposal gating blocks missing fields ✅

### Known Broken (Not Yet Fixed)
- [ ] ⚠️ Emergency call transfer not wired (E1 follow-up affected)
- [ ] ⚠️ Call-me-back repo not wired (E1 task creation fails)
- [ ] ⚠️ TTS fallback: non-PCM audio handling edge cases
- [ ] ⚠️ On-call repo not connected in some deployments

---

## Documentation Gaps (Track Separately)

- [ ] Voice clarification flow not documented (users confused)
- [ ] Emergency dispatch SLA not published (what's the callback window?)
- [ ] Proposal confidence thresholds not explained (why was I asked to confirm?)
- [ ] Catalog resolution behavior not in runbooks (what if price is missing?)

---

## Next QA Run: 2026-10-15

Expected additions:
- [ ] New features from PRs merged between runs
- [ ] Bug fixes from issues
- [ ] Performance regression checks

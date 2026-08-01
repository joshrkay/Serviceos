# feat: Mobile customer messaging (SMS) + click-to-call

**Created:** 2026-06-20
**Depth:** Deep
**Status:** plan
**Branch:** `claude/lucid-euler-amq2hk` (mobile MVP branch)
**Persist to:** `docs/plans/2026-06-20-001-feat-mobile-messaging-and-click-to-call-plan.md` at execution.

## Context

The owner asked to "make sure the SMS information comes through and we can send
out SMSes," confirm the customer's phone lives on the contact, and add the
ability to text or call a customer. Research found the **entire SMS pipeline is
already live on the backend** — it's the **mobile client** that has no messaging
surface and shows phone numbers as inert text. So this is mostly a mobile build
over existing, tested endpoints, plus **one net-new backend capability**:
owner→customer **click-to-call** (chosen over native `tel:`), which has no
existing implementation.

What already exists (reuse, do not rebuild):
- **Outgoing SMS/email:** `POST /api/conversations/:id/reply` `{ body, channel? }`
  → `sendConversationReply` (`packages/api/src/conversations/reply-service.ts`) —
  Twilio/SendGrid via `MessageDeliveryProvider`, DNC-gated, dispatch-logged,
  threads the outbound message back. Returns 503 when messaging isn't configured;
  error codes mapped in `packages/api/src/routes/conversations.ts`
  (`REPLY_ERROR_STATUS`). Requires permission `conversations:manage`.
- **Unified inbox:** `GET /api/conversations?status&needsReplyOnly&limit` →
  `{ threads: InboxThreadSummary[] }` (`conversation-service.ts`): each thread has
  `conversation`, `lastMessageAt`, `lastMessagePreview`, `lastMessageDirection`,
  `needsReply`, `messageCount`, `customerName`. Permission `conversations:view`.
- **Thread:** `GET /api/conversations/:id` (Conversation) + `GET /:id/messages`
  (`Message[]`: `messageType`, `content`, `senderRole`, `source`, `metadata`,
  `createdAt`). AI draft: `POST /:id/suggest-reply` → `{ draft }` (503 if no gateway).
- **Incoming SMS:** signature-verified Twilio webhook `POST /twilio/sms/:tenantId`
  (`packages/api/src/webhooks/routes.ts`) → `dispatchInboundSms` →
  `inbound-capture.ts` threads every text onto a `customer`/`lead`/`sms_unmatched`
  conversation. **Already works** — the mobile inbox just needs to display it.
- **Phone on the contact:** `customers.primary_phone` / `secondary_phone` →
  API `primaryPhone` / `secondaryPhone` (`GET /api/customers/:id`); generated
  `phone_normalized` powers inbound caller-ID matching.
- **Per-tenant Twilio creds:** `getTenantTwilioCreds(tenantId, pool)`
  (`packages/api/src/integrations/credentials.ts`) → `{ accountSid, authToken,
  messagingServiceSid, phoneE164, credentialVersion }`; falls back to global
  `TWILIO_*` env in dev. The Twilio REST fetch+basic-auth pattern to mirror lives
  in `packages/api/src/notifications/per-tenant-twilio-delivery-provider.ts`.
- **Telephony/TwiML:** `verifyTwilioSignature`/`requireTwilioSignature` +
  `reconstructWebhookUrl` (`packages/api/src/telephony/twilio-signature.ts`),
  `xmlEscape` + `<Dial>` TwiML (`telephony/twilio-call-control.ts`), inbound
  routes in `packages/api/src/routes/telephony.ts`.
- **Timeline:** outbound calls/texts surface on `GET /api/customers/:id/timeline`
  by writing a conversation `Message` with `source: 'outbound_call'` and
  `metadata.direction:'outbound'` (`customers/timeline.ts` `mapMessageToEvent`).
- Mobile already depends on `expo-linking ~7.0.0` and `expo-secure-store`.

## Requirements
- **R1.** Mobile shows a **Messages inbox** of customer SMS threads (incoming +
  outgoing) and lets the owner **open a thread, read history, and send a reply**
  that routes through the business line (tracked, DNC-gated, AI-visible).
- **R2.** From a customer, the owner can **start/open that customer's thread** and
  **text** them, and **call** them via a Twilio bridge that shows the business
  caller-ID and logs the call to the customer timeline.
- **R3.** The customer's phone renders as a first-class, actionable field on the
  mobile customer screens (not inert text).
- **R4.** Reuse the existing backend loop end-to-end; the only new backend is the
  click-to-call bridge + a get-or-create customer-conversation route.
- **R5.** Honor invariants: `tenant_id`+RLS, audit events on mutations, DNC gate
  on outbound, ≥44px tap targets, no 320px overflow. Mobile suite + tsc + `expo
  export` green; api `tsconfig.build.json` clean.
- **R6.** Fix the two valid open PR #597 review findings (schedule 400; push
  re-registration after sign-out).

## Key Technical Decisions
- **Texting goes through the in-app composer, never the phone's native SMS app.**
  Native `sms:` would send from the owner's personal number and bypass the
  business line, DNC, threading, and the AI. So texting = `POST
  /api/conversations/:id/reply`; only **calling** uses a (Twilio) bridge.
- **Click-to-call = Twilio "call the owner, then `<Dial>` the customer" bridge.**
  Create a Twilio call `To=ownerCallbackPhone, From=businessNumber`, with a TwiML
  callback that returns `<Dial callerId="businessNumber"><Number>customer</Number>`.
  Customer sees the business caller-ID; the owner's personal number is never
  exposed. Mirrors the SMS REST fetch pattern; no Twilio SDK dependency.
- **No new "calls" table.** The pending bridge target is carried by embedding
  `tenantId` + the just-created timeline `messageId` in the TwiML callback URL
  (we control it), so the signature-verified callback fetches that message and
  reads the customer phone from its metadata — no cross-tenant scan, no schema
  change. Call status/duration updates patch that same message's metadata.
- **Owner callback number stored on-device** (`expo-secure-store`) and sent as
  `agentPhone` per call. There is **no `users.phone` column**; device-local keeps
  this MVP free of a schema/identity change. (Follow-up: persist in tenant
  settings so notifications/AI can reuse it.)
- **Get-or-create customer conversation** via a thin new route
  `POST /api/customers/:id/conversation` (reuses `conversationRepo.findByEntity` +
  `createConversation`) so "Message this customer" works before any inbound text
  exists — avoids duplicate threads that client-side create-then-reply would risk.
- **Mobile data hooks mirror the existing ones** (`useListQuery`/`useDetailQuery`
  request-version de-dup, AbortError-as-non-error) but are purpose-built for the
  `{ threads }` and bare-`Message[]` envelopes.

## Scope Boundaries
**In scope:** mobile Messages inbox + thread + composer; customer-detail
Message/Call actions + actionable phone; on-device callback number in Settings;
backend click-to-call bridge + get-or-create customer-conversation route; the two
Codex fixes; config/verification that SMS+voice are wired.
**Non-goals:** email composing UI (SMS-first; backend already supports email);
MMS send; delivery-status webhooks (`MessageStatus`); call recording/transcription
of bridged calls; group/broadcast SMS; persisting the owner number server-side;
a web counterpart (web already has CommsInboxPage).

## Repository invariants touched
- **RLS/tenant_id:** all reads/writes go through tenant-scoped repos; the TwiML
  callback re-derives tenant from the signed URL and verifies the per-tenant token.
- **Audit:** call initiation and conversation create/reply emit audit events
  (`createAuditEvent`), mirroring `routes/me.ts` / the reply route.
- **DNC:** outbound call gated by `DncRepository.isOnDnc` exactly as SMS is.
- **Human-approval gate:** texting/calling are direct human-authored actions
  (owner taps send/call), not proposals — no auto-execution involved.

## Implementation Units

### U1. Backend — owner→customer click-to-call (Twilio bridge)
- **Requirements:** R2, R4, R5. **Dependencies:** none.
- **Files:**
  - `packages/api/src/telephony/outbound-call-service.ts` (+ `.test.ts`) — pure-ish
    `initiateOutboundCall(deps, { tenantId, customerId, agentPhone, actor })`:
    resolve customer + `primaryPhone`, DNC-check, `getTenantTwilioCreds`, write a
    `Message` (source `outbound_call`, metadata `{direction:'outbound',
    channel:'call', status:'initiating', target: customerPhone}`) onto the
    customer's conversation (get-or-create), POST Twilio `Calls.json`
    (`To=agentPhone, From=phoneE164, Url=<PUBLIC_API_URL>/api/telephony/
    outbound-bridge?tenantId=..&messageId=..`), patch the message with the
    returned `CallSid`/status, emit audit. Mirror the fetch+basic-auth+error
    handling of `per-tenant-twilio-delivery-provider.ts`.
  - `packages/api/src/routes/calls.ts` (+ route test) — `POST /api/calls`
    `{ customerId, agentPhone }`, `requireAuth/requireTenant/requirePermission`
    (reuse `customers:view` or add `calls:create`), 503 when telephony/creds
    absent, maps service errors (not_found 404, dnc_blocked 403, no_recipient 422,
    provider_failed 502) like `REPLY_ERROR_STATUS`.
  - `packages/api/src/routes/telephony.ts` — add `POST /outbound-bridge`
    (signature-verified via `requireTwilioSignature`): load the message by
    `tenantId`+`messageId`, return `<Response><Dial callerId="<businessNumber>">
    <Number>${xmlEscape(customerPhone)}</Number></Dial></Response>`; mark message
    `status:'bridged'`. Optional `POST /outbound-status` updates status/duration.
  - `packages/api/src/app.ts` — construct the service with `{ pool, conversationRepo,
    customerRepo, dncRepo, auditRepo }` + Twilio creds path; mount `/api/calls`;
    pass deps to the telephony router.
  - Possibly add `conversationRepo.getMessageById(tenantId, id)` (or reuse
    `getMessages` + filter) — keep minimal.
- **Patterns to follow:** `per-tenant-twilio-delivery-provider.ts` (Twilio REST),
  `telephony/twilio-call-control.ts` (`xmlEscape`, `<Dial>`), `twilio-signature.ts`
  (`requireTwilioSignature`, `reconstructWebhookUrl`), `reply-service.ts` (deps
  shape, DNC, audit, error class).
- **Test scenarios:** happy (POSTs `Calls.json` with the right To/From/Url, writes
  the timeline message, returns `callSid`); DNC-listed customer → 403, no Twilio
  call; no creds / `TELEPHONY_ENABLED=false` → 503; Twilio non-2xx → 502 + message
  marked failed; bridge route returns the `<Dial>` for a valid signed request and
  403 on bad signature. Mock `fetch` + creds; no real Twilio.
- **Verification:** unit + route tests green; in a wired env, tapping Call rings
  the owner then bridges to the customer with business caller-ID, and the call
  appears on `GET /api/customers/:id/timeline`.

### U2. Backend — get-or-create a customer's conversation
- **Requirements:** R2, R4. **Dependencies:** none.
- **Files:** `packages/api/src/routes/customers.ts` — add `POST
  /api/customers/:id/conversation` (`conversations:view`): `findByEntity(tenantId,
  'customer', id)` → return the open thread, else `createConversationWithAudit({
  entityType:'customer', entityId:id })`; respond `{ conversation }`. Route test.
- **Patterns to follow:** existing customer routes; `createConversationWithAudit`
  (`conversation-service.ts`).
- **Test scenarios:** existing thread returned (no duplicate created); none →
  creates one + audit; unknown customer → 404; tenant isolation.
- **Verification:** "Message" from a customer with no prior text opens a fresh
  thread; a second tap reuses it.

### U3. Mobile — messaging data layer
- **Requirements:** R1, R2. **Dependencies:** U1, U2.
- **Files (all `packages/mobile/src/...` + co-located `.test.ts`):**
  - `messaging/useConversations.ts` — `GET /api/conversations` → `threads`,
    `needsReply` count for a Home badge; AppState-aware light polling (reuse the
    `usePendingProposals` pause/resume shape) or simple refetch.
  - `messaging/useConversationThread.ts` — `GET /:id` + `GET /:id/messages`,
    request-version de-dup; exposes `messages`, `conversation`, `refetch`.
  - `messaging/sendReply.ts` — `POST /:id/reply` `{ body }`; maps 403→DNC,
    422→no-recipient, 503→not-configured to friendly strings.
  - `messaging/useSuggestReply.ts` (optional) — `POST /:id/suggest-reply` (hide on 503).
  - `messaging/startCustomerConversation.ts` — `POST /api/customers/:id/conversation`.
- **Patterns to follow:** `src/hooks/useListQuery.ts`, `useDetailQuery.ts`,
  `usePendingProposals.ts`; `src/lib/useApiClient.ts`.
- **Test scenarios:** inbox normalizes `{threads}` + needsReply count; thread
  loads messages and dedups out-of-order; sendReply error mapping; AbortError
  non-error; get-or-create returns id.
- **Verification:** hooks unit-tested with a mocked api client.

### U4. Mobile — Messages inbox + thread/composer screens
- **Requirements:** R1, R5. **Dependencies:** U3.
- **Files:**
  - `packages/mobile/app/messages.tsx` — inbox over `useConversations`; rows show
    `customerName`/number, `lastMessagePreview`, relative time, an unread/needsReply
    dot; tap → `/messages/[id]`. Reuse `EntityList` if it fits, else a thin list.
  - `packages/mobile/app/messages/[id].tsx` — thread: message bubbles
    (inbound/outbound via `messageDirection`/`senderRole`), a composer (`TextInput`
    + Send, ≥44px), optimistic append + revert on error, optional "Suggest reply".
  - `packages/mobile/app/index.tsx` — add a **Messages** entry (with a needsReply
    badge) to the Today dashboard nav.
  - Screen tests under `packages/mobile/src/screens/` (jsdom), mirroring
    `approvals.test.ts`/`proposal-review.test.ts`.
- **Patterns to follow:** `app/approvals.tsx`, `app/proposals/[id].tsx`,
  `src/components/EntityList.tsx`, the `react-native` test stub (TextInput→input).
- **Test scenarios:** inbox renders threads + empty state; needsReply dot/badge;
  tap opens thread; thread renders inbound vs outbound; typing + Send calls
  sendReply and appends; send failure shows error + keeps draft; ≥44px targets;
  no 320px overflow (Playwright viewport spec like `e2e/mobile-viewport.spec.ts`).
- **Verification:** mobile suite + `expo export` green; on a simulator the inbox
  shows a real inbound text and a reply is delivered.

### U5. Mobile — customer Message/Call actions + callback number
- **Requirements:** R2, R3, R5. **Dependencies:** U1, U3.
- **Files:**
  - `packages/mobile/app/customers/[id].tsx` — render `primaryPhone`/`secondaryPhone`
    as actionable rows: **Message** (`startCustomerConversation` → push
    `/messages/[id]`) and **Call** (`useStartCall`).
  - `packages/mobile/src/calls/useStartCall.ts` (+ test) — read the saved callback
    number; if missing, route to Settings; else `POST /api/calls`
    `{ customerId, agentPhone }`; surface 403/503 messages.
  - `packages/mobile/src/calls/callbackNumber.ts` (+ test) — `expo-secure-store`
    get/set with E.164-ish validation (reuse the digits-only normalize idea).
  - `packages/mobile/app/settings.tsx` — add a "Your callback number" field
    (TextInput, saved to secure-store) used by click-to-call.
- **Patterns to follow:** `src/push/tokenCache`-style secure-store usage;
  `app/settings.tsx`; the customer detail already built in U9.
- **Test scenarios:** Call with no saved number routes to Settings; with a number
  POSTs `/api/calls`; DNC/not-configured surfaces a message; callback-number
  validation; Message creates/opens the thread and navigates.
- **Verification:** tapping Call rings the owner's device then the customer;
  Message opens the thread; phone rows are ≥44px.

### U6. Mobile — fix the two open PR #597 review findings
- **Requirements:** R6. **Dependencies:** none (can land first).
- **Files:**
  - `packages/mobile/app/schedule.tsx` — call
    `useListQuery('/api/appointments', { params: { paginated: 'true' } })` (the
    bare call hits the historical 400 in `routes/appointments.ts`; confirmed). Add
    a date-window param if we want today-forward. Update/confirm the schedule test.
  - `packages/mobile/src/hooks/usePushRegistration.ts` — reset `doneRef` when
    `enabled` becomes false (sign-out) or key the guard by session/user id, so
    re-sign-in re-registers the Expo token. Add a hook test for the re-enable path.
- **Test scenarios:** schedule hook sends `paginated=true` and renders rows;
  push hook re-registers after an enabled=false→true cycle.
- **Verification:** Schedule loads instead of erroring; sign-out→sign-in restores
  push without an app restart.

## Risks & Dependencies
- **Owner callback number provenance** — device-local per the decision; a new
  device must re-enter it. Flagged for a settings-persisted follow-up.
- **TwiML bridge correctness** is the riskiest new path; pin it with unit tests on
  the `<Dial>` output + signature handling, and a manual two-phone test in a wired
  env. If per-tenant voice creds (`phoneE164`) are absent, `/api/calls` returns 503.
- **Permissions** — verify the owner-operator role carries `conversations:view`,
  `conversations:manage`, and the calls permission; if not, gate/adjust.
- **Config is the real "make SMS come through" gate** — production needs
  `TWILIO_ACCOUNT_SID/AUTH_TOKEN/FROM_NUMBER`, `SENDGRID_*`, `PUBLIC_API_URL`,
  `TELEPHONY_ENABLED=true` (or per-tenant `tenant_integrations` rows). Without
  them, reply/inbound/calls degrade to 503/no-op. Confirm on Railway.
- **Sequencing:** U6 first (quick green); U1+U2 backend; then U3→U4→U5 client.

## Open Questions (deferred to implementation)
- Exact permission literal for `/api/calls` (`customers:view` vs new `calls:create`).
- Whether to add `getMessageById` to the conversation repo or fetch-and-filter.
- Bridge UX detail: dial owner-first (`Calls.json To=owner`) vs `<Dial>` from a
  `To=customer` call — owner-first keeps the owner's number private and is the plan.
- Inbox polling cadence/badge vs. push (a future "new message" push could reuse U7).

## Verification (end-to-end)
1. `cd packages/api && npx tsc --project tsconfig.build.json --noEmit`; api unit +
   route tests; integration test for the get-or-create route if a new query lands.
2. Mobile: `cd packages/mobile && npx tsc --noEmit`, `npx vitest run --root
   packages/mobile --coverage`, `npx expo export --platform ios`, plus the
   root-only CI-lane sim (hide `packages/mobile/node_modules`, run, safe-restore).
3. Wired-env smoke: text the business Twilio number → the thread appears in the
   mobile inbox (incoming works); send a reply → customer receives it and it
   threads (outgoing works); tap Call → owner rings, bridges to customer with
   business caller-ID, call shows on the customer timeline.
4. Confirm Railway env (TWILIO_*, SENDGRID_*, PUBLIC_API_URL, TELEPHONY_ENABLED)
   or per-tenant `tenant_integrations` are set so nothing returns 503 in prod.

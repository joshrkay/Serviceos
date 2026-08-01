# feat: Mobile owner notifications + error-message system

**Created:** 2026-06-21
**Depth:** Deep
**Status:** plan

## Summary
Build the end-to-end owner-facing **notification** layer and a reusable **error-message**
system for the mobile app. Today push is wired to exactly two events (proposal
needs-approval, proposal executed) through a proposal-specific notifier, and mobile
errors are ad-hoc inline red text that throws away the backend's structured error body.
This plan generalizes the push pipeline into a typed owner-notification service, lights up
every owner-notifiable business event (incoming call, inbound SMS, appointment reminder &
cancellation, payment received, invoice overdue, lead captured, escalation/emergency),
wires the mobile client to route/present them, and replaces the per-screen error handling
with a typed-error + toast + offline-banner + Error-Boundary system mapped to a full error
taxonomy.

## Problem Frame
The owner-operator runs the business from the mobile app. Right now the app can only tell
them about proposals; everything else that happens on their account (a customer calling,
a text coming in, an appointment getting cancelled, a payment landing, a hot lead, an
emergency escalation) is invisible unless they go looking. And when anything goes wrong in
the app, they see a bare `HTTP 500` / `Unknown error` with no recovery path, no offline
awareness, and a silent dump to the sign-in screen on session expiry. Both gaps erode
trust in an app meant to be the owner's operational nerve center.

## Requirements
- R1. A single, typed owner-notification service sends Expo push for any notifiable event,
  reusing the existing transport/token-store/targeting; proposal pushes are refactored
  onto it with no behavior change.
- R2. Owner push fires for: incoming call, inbound SMS, appointment reminder, appointment
  cancellation, payment received, invoice overdue, lead captured, escalation/emergency
  (plus the existing proposal needs-approval / executed). Each carries a typed payload and
  a deep-link `screen`.
- R3. The mobile client routes each notification type to the correct screen, presents
  foreground notifications, and refreshes the relevant surface on foreground arrival.
- R4. "Incoming call" = a push identifying the caller that deep-links to the customer
  timeline (no native VoIP/ring); unknown callers route to the just-created lead/customer.
- R5. Mobile decodes the backend `{ error, message, details }` body into a typed error and
  surfaces real, blame-free copy for every error state in the taxonomy (offline, timeout,
  401/403/404/409/422, 5xx, mic & push permission).
- R6. A reusable error UX: toast/banner for transient errors, a persistent offline banner
  with auto-retry-on-reconnect, an Error Boundary, and a session-expired message that
  preserves the user's place before redirecting to sign-in.
- R7. Notifications are governable: owners can mute notification categories (opt-out),
  defaulting all-on. *(Deferrable — see U10.)*
- R8. Every new unit ships with tests in the same commit (handler-level w/ mocked
  notifier/gateway for backend seams; jsdom class-contract + Playwright viewport for mobile
  UI; Docker-gated integration test for DB-touching units).

## Key Technical Decisions
- **Generalize the notifier, don't fork it.** Introduce `OwnerNotificationService` driven
  by a typed notification-descriptor registry; refactor `proposal-push-notifier.ts` to
  delegate to it. *Alternative:* copy-paste a new notifier per event — rejected: 8+
  near-identical dispatch/token-prune/targeting blocks, guaranteed drift.
- **Notification taxonomy lives in `packages/shared`.** A Zod-validated union of
  `{ type, data }` shapes (with the deep-link `screen`) shared by API and mobile, so the
  producer and the router can't disagree. *Alternative:* string-typed payloads — rejected:
  the router already silently no-ops unknown shapes; we want compile-time parity.
- **Per-type target resolution.** Each descriptor declares the Clerk permission/role that
  should receive it (proposals→`proposals:approve`; ops events→owner+dispatcher; money
  events→owner). Generalize the existing `resolveApproverUserIds` into
  `resolveUserIdsWithPermission(tenantId, permission)`. *Alternative:* notify all tenant
  devices — rejected: technicians shouldn't get payment/escalation pushes.
- **Deep-link to existing routes; defer new detail routes.** Map each type to an existing
  route (`/customers/[id]`, `/messages/[id]`, `/proposals/[id]`, list routes `/schedule`,
  `/invoices`). Per-appointment and per-invoice detail routes are a follow-up; reminder/
  cancellation/payment deep-link to their list for v1. The router already honors a
  `data.screen` starting with `/`, so producers drive routing; the client adds a `screen`
  **allowlist** so a malformed payload can't navigate somewhere unexpected.
- **Decode errors at the transport, present at a shared layer.** Parse `{error,message,
  details}` once in `apiFetch`/a small error mapper into a typed `AppError`; a
  `ToastProvider` + `OfflineBanner` + `ErrorBoundary` render it. *Alternative:* keep
  per-screen strings but fix copy — rejected: 12 ad-hoc sites, no offline/timeout/boundary
  coverage, inconsistent voice.
- **Reuse existing infra for delivery timing.** Reminder pushes ride the existing
  `appointment-reminder-worker` sweep (P0-009 leader-locked `setInterval`); inbound
  call/SMS pushes fire at the existing Twilio/SMS webhook seams (P0-014). No new schedulers.

## Scope Boundaries
**In scope:** the generalized notifier + taxonomy; owner push for all events in R2; mobile
routing/presentation; the full mobile error system (R5/R6); tests for each.
**Non-goals:**
- Native VoIP / CallKit incoming-call ringing UI (explicitly out per R4).
- An in-app notification **center/inbox feed** (server-stored notification history + list
  screen). Pushes + deep-links + the existing Home/Messages surfaces only.
- Customer-facing comms changes — `TransactionalCommsService` (SMS/email to customers)
  stays as-is; we only add the *owner* push alongside it.
- New per-appointment / per-invoice mobile detail routes.
### Deferred to follow-up work
- Per-appointment (`app/schedule/[id].tsx`) and per-invoice (`app/invoices/[id].tsx`)
  detail routes, so reminder/payment pushes can deep-link to the specific record.
- In-app notification center with server-stored history + unread badge.
- Expo push **receipt** polling (the transport has a TODO; dead-token pruning already works
  off send-tickets).
- Notification preferences UI beyond simple per-category mute (U10), e.g. quiet hours.

## Repository invariants touched
- **tenant_id + RLS:** `device_tokens` already RLS-scoped; the new `notification_preferences`
  table (U10) carries `tenant_id` + RLS. All token/preference reads are tenant-scoped.
- **Audit events:** preference changes emit `notification.preferences.updated`
  (mirrors `device.registered` in `routes/devices.ts`). Push *sends* remain
  failure-isolated and unaudited, matching the current proposal notifier.
- **UTC / tenant tz:** reminder push reuses the worker's existing UTC sweep window; any
  time in copy is rendered in tenant tz by the existing formatter.
- **Integer cents:** payment/invoice push copy formats amounts from integer cents via the
  shared money formatter — never floats.
- **LLM gateway / proposals / catalog / entity resolver:** not touched — notification copy
  is templated (no LLM), and no proposal is auto-executed (escalation/cancellation pushes
  are notifications about proposals, not executions).
- **Async worker (P0-009) / webhook base (P0-014):** reminders use the existing worker
  sweep; inbound call/SMS pushes hang off the existing webhook-base handlers.

## High-Level Technical Design

```
business event seam ──► OwnerNotificationService.notify(type, ctx)
 (twilio-adapter,        │  1. descriptor = NOTIFICATION_TYPES[type]   (shared Zod registry)
  inbound-capture,       │  2. targets = resolveUserIdsWithPermission(tenant, descriptor.permission)
  reminder-worker,       │  3. (U10) drop targets who muted `type`
  cancellation-handler,  │  4. payload = descriptor.build(ctx) → {title, body, data:{type,screen,…}}
  payment, lead,         │  5. tokens = deviceTokenRepo.listByTenant(tenant) ∩ targets
  escalation)            │  6. expoPushProvider.sendPush(...) ; prune DeviceNotRegistered
                         ▼
        Expo  ──►  device  ──►  mobile useNotificationRouter
                                  • cold-start / tap  → router.push(allowlist(data.screen))
                                  • foreground        → present + onForeground refresh

mobile apiFetch ──► decodeError(res) → AppError{kind,message,details}
                      ├─ 401 → silent refresh → else session-expired toast + preserve + /sign-in
                      ├─ offline (NetInfo) → OfflineBanner + queue retry-on-reconnect
                      └─ 4xx/5xx → ToastProvider / inline, copy from taxonomy map
        ErrorBoundary at app/_layout wraps the tree.
```

## Implementation Units

### U1. Notification taxonomy + generic OwnerNotificationService
- **Goal:** One typed service + shared descriptor registry that sends owner push for any
  event; proposal pushes refactored onto it with identical behavior.
- **Requirements:** R1, R2 (foundation).
- **Dependencies:** none.
- **Files:**
  - `packages/shared/src/contracts/notification.ts` (new) — Zod union of notification
    `type` + `data` shapes (each with `screen`), `NotificationType` enum, descriptor
    interface; export via `packages/shared/src/index.ts`.
  - `packages/api/src/notifications/owner-notification-service.ts` (new) — `notify(type,ctx)`,
    descriptor registry (title/body/screen builders + required permission), token fan-out,
    dead-token prune. Generalizes `proposal-push-notifier.ts:dispatch`.
  - `packages/api/src/notifications/user-targeting.ts` (new or fold into service) —
    `resolveUserIdsWithPermission(tenantId, permission)`, generalized from
    `proposal-push-notifier.ts:approverUserIdsResolver`.
  - `packages/api/src/notifications/proposal-push-notifier.ts` (modify) — delegate
    `notifyNeedsApproval`/`notifyExecuted` to the new service; remove duplicated dispatch.
  - `packages/api/src/app.ts` (modify) — construct `OwnerNotificationService` from the
    existing `expoPushProvider` + `deviceTokenRepo` (around `app.ts:3818-3834`); keep the
    proposal late-bindings working.
  - Tests: `packages/api/test/notifications/owner-notification-service.test.ts` (new),
    update `packages/api/test/notifications/proposal-push-notifier.test.ts`.
- **Approach:** Descriptor-driven. `NOTIFICATION_TYPES[type]` yields `{ permission, build(ctx)
  → PushMessage }`. Service: resolve targets → intersect tenant tokens → `sendPush` →
  prune. Failure-isolated (never throws), matching current notifier. Proposal types become
  two registry entries; `proposal-push-notifier` keeps its public methods but calls
  `service.notify('proposal_needs_approval', …)`.
- **Patterns to follow:** `proposal-push-notifier.ts` (dispatch/prune/targeting),
  `push-delivery-provider.ts` (`PushMessage`/`InMemoryPushDeliveryProvider`),
  `device-token-service.ts` (repo interface).
- **Test scenarios:**
  - Happy: `notify('proposal_needs_approval', ctx)` → one push per approver device with the
    same title/body/data the old notifier produced (parity assertion).
  - Targeting: a technician-only token is excluded for an owner-scoped type; included for a
    type scoped to all staff.
  - Edge: zero tokens → no send, no throw; `DeviceNotRegistered` ticket → token pruned via
    repo.
  - Failure: provider throws → `notify` swallows and logs (caller never sees it).
- **Verification:** Proposal pushes still fire identically (existing tests green via the new
  path); the service sends a correctly-targeted, well-formed push for an arbitrary new type.

### U2. Inbound-call owner push
- **Goal:** Push the owner when a customer call comes in, deep-linking to the customer.
- **Requirements:** R2, R4.
- **Dependencies:** U1.
- **Files:**
  - `packages/api/src/telephony/twilio-adapter.ts` (modify) — at the caller-known branch
    (~`:1548-1573`) and the unknown-caller `findOrCreateLeadByPhone` branch (~`:1591`),
    call `ownerNotifications.notify('incoming_call', { customerId, callerName|phone })` with
    `screen: '/customers/<id>'`.
  - `packages/api/src/telephony/inbound-call-log.ts` (reference) — reuse the resolved
    customer/lead id it already computes; don't double-resolve.
  - Tests: `packages/api/test/telephony/inbound-call-owner-push.test.ts` (new).
- **Approach:** Fire once per inbound call at identify time (not per media frame). Known
  caller → name in body ("Maria Lopez is calling"); unknown → "New caller: <phone>" routing
  to the freshly-created lead's customer page. Inject the notifier as a dependency (mirror
  how the adapter already takes collaborators) so it's mockable.
- **Patterns to follow:** `inbound-call-log.ts` (customer resolution + where it hooks),
  existing adapter dependency injection.
- **Test scenarios:**
  - Happy (known): inbound call from a known customer → one `incoming_call` push, body has
    the customer name, `data.screen === '/customers/<id>'`.
  - Happy (unknown): unknown number → lead created → push routes to the new customer id.
  - Edge: caller-id blocked / no number → push still fires with a generic caller label, no
    crash.
  - Integration: the push call is invoked from the real inbound-call entry path (handler
    test exercising `handleInboundCall`, not just the helper).
- **Verification:** An inbound call produces exactly one correctly-targeted, correctly-routed
  owner push.

### U3. Inbound-SMS owner push
- **Goal:** Push the owner on an inbound customer text, deep-linking to the thread.
- **Requirements:** R2.
- **Dependencies:** U1.
- **Files:**
  - `packages/api/src/sms/inbound-capture.ts` (modify) — after `addMessage` succeeds
    (~`:218-235`, where `sms.inbound.captured` is audited at `:244`), call
    `notify('inbound_sms', { conversationId, customerId, preview })` with
    `screen: '/messages/<conversationId>'`.
  - `packages/api/src/sms/inbound-dispatch.ts` (reference) — confirm this is the single
    capture seam; avoid double-firing across negotiation/owner-edit handlers.
  - Tests: `packages/api/test/sms/inbound-sms-owner-push.test.ts` (new).
- **Approach:** One push per inbound message, body = truncated text preview, deep-link to the
  thread (`/messages/[id]` exists). Skip system/automated inbound (STOP/HELP) so owners
  aren't pinged for keyword auto-replies.
- **Patterns to follow:** `inbound-capture.ts` audit-emit site; truncation/preview style
  from existing message rendering.
- **Test scenarios:**
  - Happy: inbound text → one `inbound_sms` push, preview truncated, `screen` = thread.
  - Edge: `STOP`/`HELP` keyword inbound → no push (compliance auto-reply path).
  - Edge: long body → preview truncated to N chars with ellipsis.
  - Failure: notifier throws → message still threaded/audited (push is best-effort).
- **Verification:** A normal inbound text pushes once to the thread; compliance keywords
  don't.

### U4. Appointment-reminder owner push
- **Goal:** Owner push for upcoming appointments alongside the existing customer reminder.
- **Requirements:** R2.
- **Dependencies:** U1.
- **Files:**
  - `packages/api/src/workers/appointment-reminder-worker.ts` (modify) — in the sweep loop
    (~`:54-59`, after the canceled/held skip), call `notify('appointment_reminder', …)`
    with `screen: '/schedule'`, reusing the same idempotency/dispatch-key guard so a sweep
    re-run doesn't double-push.
  - `packages/api/src/notifications/transactional-comms-service.ts` (reference) — mirror its
    dispatch-key idempotency (`notifyReminder` ~`:98`); do not route owner push through the
    customer comms service.
  - Tests: `packages/api/test/workers/appointment-reminder-owner-push.test.ts` (new) +
    Docker-gated integration in `packages/api/test/integration/` (the sweep reads real
    appointment rows — pin columns).
- **Approach:** Reuse the worker's existing T-24h window and per-appointment idempotency key
  (add an owner-push dispatch key so customer-SMS and owner-push are independently
  idempotent). One push per appointment per sweep window.
- **Patterns to follow:** the worker's leader-locked sweep + dispatch-key idempotency;
  `SWEEP_LOCK` wiring at `app.ts:1782/4445-4464`.
- **Test scenarios:**
  - Happy: appointment 24h out → one owner `appointment_reminder` push.
  - Edge: canceled/held appointment → skipped (no push).
  - Idempotency: two sweeps in the same window → exactly one owner push (dispatch key).
  - Integration (DB): seed a real appointment row, run the sweep, assert the notifier was
    invoked with the real `appointmentId`/customer and the dispatch key persisted.
- **Verification:** Each eligible appointment pushes the owner once per window; re-sweeps
  don't duplicate.

### U5. Appointment-cancellation owner push
- **Goal:** Owner push when an appointment is cancelled.
- **Requirements:** R2.
- **Dependencies:** U1.
- **Files:**
  - `packages/api/src/proposals/execution/cancellation-handler.ts` (modify) — at the
    `notifyCanceled` site (~`:95`), add `notify('appointment_cancellation', …)` with
    `screen: '/schedule'`.
  - Tests: `packages/api/test/proposals/execution/cancellation-owner-push.test.ts` (new).
- **Approach:** Fire after the cancellation executes (in the same handler that already
  notifies the customer). Body names the customer + original time (tenant tz). Covers both
  owner-initiated and customer-portal-initiated cancellations, since both execute the
  `cancel_appointment` handler.
- **Patterns to follow:** `cancellation-handler.ts` existing `notifyCanceled` call;
  tenant-tz time formatting used elsewhere in execution handlers.
- **Test scenarios:**
  - Happy: `cancel_appointment` executes → one `appointment_cancellation` owner push with
    customer + time in body.
  - Edge: cancellation of an already-canceled appointment → handler no-ops, no push.
  - Failure: notifier throws → cancellation still completes + customer still notified.
- **Verification:** A cancellation produces one owner push; the cancellation itself is
  unaffected by push failure.

### U6. Remaining owner pushes — payment received, invoice overdue, lead captured, escalation/emergency
- **Goal:** Light up the rest of the comprehensive set at their existing seams.
- **Requirements:** R2.
- **Dependencies:** U1.
- **Files:**
  - `packages/api/src/invoices/payment.ts` (modify ~`:369`) — `notify('payment_received', …)`,
    amount from integer cents, `screen: '/invoices'`.
  - `packages/api/src/workers/overdue-invoice-worker.ts` (modify) — `notify('invoice_overdue',
    …)`, `screen: '/invoices'`; dispatch-key idempotent like U4.
  - `packages/api/src/leads/lead-service.ts` (modify ~`:81`) and/or
    `packages/api/src/ai/skills/find-or-create-lead.ts` (~`:129`, the `lead.created` audit) —
    `notify('lead_captured', …)`, `screen: '/customers/<id>'`. Fire once at lead creation
    (guard against the call-path also creating a lead → dedupe with U2's incoming-call push:
    a brand-new caller should get **one** notification, not both — see Risks).
  - `packages/api/src/proposals/auto-approve.ts` (escalate path ~`:411`) +
    `packages/api/src/proposals/execution/emergency-dispatch-handler.ts` (modify) —
    `notify('escalation', …)` / `notify('emergency', …)`, `screen` = the related proposal
    (`/proposals/<id>`) or `/approvals`. Emergency is high-priority (see U7 presentation).
  - Tests: `packages/api/test/notifications/remaining-owner-pushes.test.ts` (new),
    plus a Docker-gated integration for the overdue-invoice sweep.
- **Approach:** Each is a thin `notify(...)` at an existing seam; the heavy lifting is in U1.
  Group them in one unit since each is small and shares the test harness. Money copy uses the
  shared cents formatter. Targeting: payment/overdue → owner; lead → owner+dispatcher;
  escalation/emergency → owner+dispatcher (and emergency marked high-priority).
- **Patterns to follow:** `transactional-comms-service.ts` `notifyPaymentReceived`/
  `notifyInvoiceOverdue` (for *what* data is available at each seam), U1 service API.
- **Test scenarios:**
  - Happy (×4 types): each seam fires the right typed push with correct `screen` and copy;
    payment body formats cents correctly.
  - Edge: lead created via an inbound call does **not** double-notify (incoming_call wins;
    lead_captured suppressed for that path) — assert single push.
  - Idempotency (overdue): two sweeps → one push per invoice.
  - Integration (DB, overdue): real overdue invoice row → sweep → notifier invoked once.
- **Verification:** All four event types push correctly; no double-notify on the
  new-caller→new-lead path; money formatted from cents.

### U7. Mobile — notification routing, presentation & foreground refresh
- **Goal:** Route every new notification type to the right screen, present foreground
  notifications, and refresh the relevant surface on arrival.
- **Requirements:** R3, R4.
- **Dependencies:** U1 (shared taxonomy); backend producers (U2–U6) for end-to-end, but the
  client can be built/tested against the shared contract independently.
- **Files:**
  - `packages/mobile/src/push/notificationRouting.ts` (modify) — consume the shared
    `NotificationData` union; add a **screen allowlist** (`/customers/[id]`, `/messages/[id]`,
    `/proposals/[id]`, `/schedule`, `/invoices`, `/approvals`); fall back to a safe default
    (Home) for unknown/te­nant-mismatched screens.
  - `packages/mobile/src/push/nativeNotificationDeps.ts` (modify) — set
    `shouldShowAlert: true` (at least for high-priority types like `emergency`); keep badge.
  - `packages/mobile/src/push/useNotificationRouter.ts` (modify) — pass an `onForeground`
    that refreshes the relevant query (e.g. invalidate pending-proposals / messages / money).
  - `packages/mobile/app/_layout.tsx` (modify) — wire the `onForeground` refresh callback
    (currently omitted at `:20`).
  - Tests: `packages/mobile/src/push/notificationRouting.test.ts` (extend — one case per
    type → expected route, allowlist rejection → Home), and a hook test for
    `useNotificationRouter` foreground refresh.
- **Approach:** Producers already send a `screen`, so routing is mostly validation + the
  allowlist; the `type` field drives presentation priority and which query to refresh on
  foreground. No new screens (deep-link to existing detail/list routes).
- **Patterns to follow:** existing `routeForNotification` purity + its test table;
  `usePendingProposals`/`useConversationThread` refetch APIs for the refresh.
- **Test scenarios:**
  - Happy: each `type` (incoming_call→/customers/[id], inbound_sms→/messages/[id],
    reminder/cancellation→/schedule, payment/overdue→/invoices, lead→/customers/[id],
    escalation→/proposals/[id], proposal_*→/proposals/[id]) routes as expected.
  - Edge: `data.screen` not in allowlist, or empty `data` → routes to Home, never throws.
  - Foreground: a foreground push invokes the refresh callback (and does not navigate).
- **Verification:** Every notification type deep-links correctly; malformed payloads degrade
  to Home; foreground arrivals refresh the right surface.

### U8. Mobile — typed API error decoding
- **Goal:** Turn raw responses/throws into a typed `AppError` carrying the backend's real
  message/code, replacing `HTTP ${status}` everywhere.
- **Requirements:** R5.
- **Dependencies:** none (can land before U9).
- **Files:**
  - `packages/mobile/src/lib/appError.ts` (new) — `AppError` type (`kind`: offline | timeout |
    unauthorized | forbidden | notFound | conflict | validation | server | unknown) +
    `decodeError(res|thrown)` that parses `{ error, message, details }` (contract in
    `packages/api/src/shared/errors.ts:50`) and classifies network/timeouts.
  - `packages/mobile/src/lib/apiFetch.ts` (modify) — add an `AbortController` timeout; on
    non-2xx, attach the parsed body so callers/hook layer can `decodeError`.
  - `packages/mobile/src/hooks/useListQuery.ts`, `useDetailQuery.ts`,
    `useConversationThread.ts`, `usePendingProposals.ts`, `useMoneyDashboard.ts`,
    `useProposalReview.ts` (modify) — replace `HTTP ${status}` with `decodeError(...)`.
  - Tests: `packages/mobile/src/lib/appError.test.ts` (new),
    `packages/mobile/src/lib/apiFetch.test.ts` (extend — timeout + body parse).
- **Approach:** Single decode path; hooks store `AppError` instead of a string. Keep the
  existing 401 silent-refresh; `decodeError` only classifies the *final* failure. Preserve
  the `AbortError` sign-out swallow.
- **Patterns to follow:** existing good per-path mappers `useStartCall.ts:callErrorMessage`,
  `sendReply.ts:replyErrorMessage` (lift their 403/422/503 logic into the shared map).
- **Test scenarios:**
  - Happy: 404 with `{error:'NOT_FOUND',message:'...'}` → `AppError{kind:'notFound',
    message:'...'}` (server copy preserved).
  - Edge: body not JSON / empty → `kind:'server'` with a generic message.
  - Timeout: request exceeds the AbortController limit → `kind:'timeout'`.
  - Network throw (`Network request failed`) → `kind:'offline'`.
  - 401 after refresh → still classified `unauthorized` for the session-expired flow (U9).
- **Verification:** Every read hook surfaces the backend's human message (or a typed
  fallback), never `HTTP 500`.

### U9. Mobile — error UX system (toast, offline banner, Error Boundary, session-expired, push-denied)
- **Goal:** A reusable presentation layer mapping the error taxonomy to consistent,
  blame-free copy with recovery affordances.
- **Requirements:** R5, R6.
- **Dependencies:** U8 (consumes `AppError`).
- **Files:**
  - `packages/mobile/src/components/Toast.tsx` + `ToastProvider` (new) — transient error/
    info toasts; mounted in `app/_layout.tsx`.
  - `packages/mobile/src/components/OfflineBanner.tsx` (new) — persistent banner driven by
    connectivity; `@react-native-community/netinfo` dependency (new).
  - `packages/mobile/src/components/ErrorBoundary.tsx` (new) — class boundary with a
    friendly fallback + "Try again"; wraps the tree in `app/_layout.tsx`.
  - `packages/mobile/src/lib/errorCopy.ts` (new) — `AppError.kind` → copy map (taxonomy:
    offline/timeout/401/403/404/409/422/5xx/mic/push), tone matching existing conventions.
  - `packages/mobile/src/lib/apiFetch.ts` / `useApiClient.ts` (modify) — before the
    `/sign-in` redirect (`apiFetch.ts:131`, `useApiClient.ts:22`) show "Your session expired —
    please sign in again" and preserve the current route to resume after re-auth.
  - `packages/mobile/src/lib/useReconnectRetry.ts` (new) — re-run failed read queries when
    NetInfo reports reconnection.
  - `packages/mobile/src/hooks/usePushRegistration.ts` (modify) — surface `'denied'` so
    Settings/Home can show "Turn on notifications to get alerts."
  - Update the ~12 inline `text-destructive` sites (`EntityList.tsx`, `app/index.tsx`,
    `app/approvals.tsx`, `app/proposals/[id].tsx`, `app/messages*.tsx`,
    `app/customers/[id].tsx`, `app/settings.tsx`) to use the shared copy/affordances; keep
    the voice screen's existing good retry.
  - Tests: jsdom class-contract `packages/mobile/src/components/*.test.tsx` (≥44px tap
    targets `min-h-11`, no horizontal overflow at 320px), `errorCopy.test.ts`,
    offline-banner + reconnect-retry behavior tests, ErrorBoundary fallback test, and a
    Playwright viewport spec `packages/mobile/e2e/error-states-mobile.spec.ts` (pattern:
    `e2e/estimate-approval-mobile.spec.ts`).
- **Approach:** Toasts for transient action failures (send, mode-switch); inline for
  list/detail load failures (with a Retry calling the hook's existing `refetch`); persistent
  banner for offline; boundary for render throws. Copy is short, blame-free, action-first
  (matches `useStartCall`/`sendReply` voice). Session-expiry preserves place per best
  practice.
- **Patterns to follow:** existing copy voice (`useStartCall.ts`, `sendReply.ts`,
  `useVoiceCapture.ts`); NativeWind `className` conventions; the mobile test patterns in
  `CLAUDE.md` (jsdom class-contract + Playwright 320px).
- **Test scenarios:**
  - Happy: a `server` error renders a toast with the mapped copy + Retry; Retry re-invokes
    the hook.
  - Offline: NetInfo offline → banner shown; reconnect → banner hides + failed queries
    re-run automatically.
  - Session-expired: final 401 → session-expired message shown, route preserved, redirect to
    `/sign-in`.
  - Boundary: a thrown render error shows the fallback, not a blank screen.
  - Push-denied: `usePushRegistration` returns `'denied'` → Settings shows the enable-prompt.
  - Class-contract + viewport: toast/banner/boundary have `min-h-11` tap targets and no
    320px horizontal overflow (jsdom + Playwright).
- **Verification:** Every taxonomy state renders consistent, recoverable copy; offline and
  session-expiry behave per best practice; no blank-screen crashes.

### U10. Notification preferences (opt-out by category) — *deferrable*
- **Goal:** Let owners mute notification categories; default all-on.
- **Requirements:** R7.
- **Dependencies:** U1 (service consults preferences), U9 (Settings UI surface).
- **Files:**
  - `packages/api/src/db/schema.ts` (modify) + migration — `notification_preferences`
    (`tenant_id`, `user_id`, `notification_type`, `enabled`), RLS, unique
    `(tenant_id,user_id,notification_type)`.
  - `packages/api/src/notifications/notification-preferences-service.ts` (new) + Pg repo;
    `OwnerNotificationService` filters muted targets.
  - `packages/api/src/routes/notification-preferences.ts` (new) — `GET/PUT`, audit
    `notification.preferences.updated`.
  - `packages/mobile/app/settings.tsx` (modify) — per-category toggles.
  - Tests: Docker-gated integration `packages/api/test/integration/notification-preferences.test.ts`
    (real columns + RLS), service unit test, mobile settings jsdom test.
- **Approach:** Default-on (absence = enabled). Service intersects resolved targets with
  not-muted preferences before sending. Keep categories coarse (the `NotificationType` set).
- **Patterns to follow:** an existing RLS table + Pg repo (`device_tokens` /
  `pg-device-token-repository.ts`); `routes/devices.ts` audit-emit style.
- **Test scenarios:**
  - Happy: mute `payment_received` → owner stops getting payment pushes, still gets others.
  - Edge: no preference row → treated as enabled.
  - Integration (DB): preference persists with `tenant_id` + RLS isolation across tenants;
    mutation emits the audit event.
- **Verification:** Muting a category suppresses exactly that push; defaults all-on; tenant
  isolation holds.

## Risks & Dependencies
- **Double-notify on new-caller→new-lead.** An unknown inbound caller creates a lead *and*
  is an incoming call. U2 and U6 must dedupe (incoming_call wins; suppress lead_captured for
  the call-originated lead). Pinned by a U6 test.
- **Notification fatigue.** Comprehensive coverage risks spamming owners; U10 (mute) is the
  mitigation and should not stay deferred long. Mark high-priority among the follow-ups.
- **Foreground alert behavior.** Flipping `shouldShowAlert: true` affects all notifications
  (incl. proposals). Verify proposal foreground UX still feels right; consider per-type
  presentation if noisy.
- **NetInfo dependency** adds a native module — ensure it's in the EAS build config and the
  jsdom test stub (mirror the existing `react-native` stub) so unit tests don't pull native.
- **Deep-link targets for reminder/payment** land on list screens until the deferred detail
  routes exist — acceptable for v1, noted to the user.
- **Sequencing:** U1 gates U2–U6 and U10's service hook; U8 gates U9. U2–U6 are mutually
  independent (parallelizable). U7 depends only on the shared contract (U1's
  `notification.ts`), so it can proceed alongside the backend producers.

## Open Questions (deferred to implementation)
- Exact helper/symbol names at each backend seam (e.g. the precise variable holding the
  resolved `customerId` in `twilio-adapter.ts`) — resolve when editing the file.
- Whether `escalation` and `emergency` should be one type with a priority flag or two
  distinct types — decide in U6 from how `escalate_to_oncall` vs `emergency-dispatch`
  differ in payload.
- Final NetInfo library choice (`@react-native-community/netinfo` vs Expo equivalent) — pick
  in U9 based on the current Expo SDK's recommendation.
- Whether reminder/cancellation should deep-link to `/schedule` or warrant the deferred
  `app/schedule/[id].tsx` detail route now — revisit if v1 list-routing feels too coarse.

## Sources & Research
- Best-practice error UX (offline banner + auto-retry, graceful session-expiry, actionable
  blame-free copy, always-offer-recovery): UX Content Collective; Maestro "Error Handling in
  Mobile Apps"; web.dev "Offline UX guidelines"; LeanCode "Offline Mobile App Design";
  Smashing Magazine "Error States for Mobile Apps". (Gathered during planning research;
  shaped U6/U8/U9 copy + offline/session-expiry decisions.)

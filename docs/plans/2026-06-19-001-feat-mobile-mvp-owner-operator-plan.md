# feat: Owner-Operator Mobile App MVP (Expo + React Native)

**Created:** 2026-06-19
**Depth:** Deep
**Status:** plan

## Summary

Build the downloadable iOS + Android app for the owner-operator tradesperson as a new
`packages/mobile` Expo workspace, delivering the full closed loop: **speak an action →
AI drafts a typed proposal → review & approve (with a 5-second undo) → get a push
notification when it executes.** The backend already exposes this loop over HTTP; the
only net-new server work is a push-notification system (`device_tokens` + an Expo push
dispatcher wired into two existing injected seams). Design spec lives at
`docs/mobile/owner-operator-app-spec.md`.

## Problem Frame

The owner-operator who "learned the trade" (founding sentence, `docs/decisions.md`)
runs their business today from SMS (D-011). They need a native app that lets them
**talk** their work into the system and **approve** what the AI drafts — without
sitting at a desk. The web app already proves the patterns (voice capture, proposal
card, inbox polling, Clerk auth); none of it is installable on a phone, and there is no
push channel to tell the owner an action needs approval or has completed.

## Requirements

- **R1.** A downloadable Expo (iOS + Android) app in `packages/mobile`, sharing
  `@ai-service-os/shared` contracts, that does **not** break the Railway api/web build
  or CI.
- **R2.** Voice-first capture: hold-to-talk → record → upload → transcribe → the AI
  turns the transcript into proposal(s) surfaced in the app.
- **R3.** Approvals: review a proposal's typed payload, confidence, pricing badges, and
  "what I wasn't sure about" markers; approve / reject / edit / resolve ambiguous line;
  a **5-second undo** affordance; batch approve. Human approval always — never
  auto-execute (D-004).
- **R4.** Push notifications: the owner is notified when a proposal **needs approval**
  and when an approved proposal **finishes executing**, each deep-linking into the app.
- **R5.** Reuse the existing backend loop (proposals, voice, auth) — no parallel
  reimplementation of business logic on the client.
- **R6.** Honor repo invariants on the client: render money from integer cents
  (display-format only), render times in the tenant timezone, ≥44pt tap targets.
- **R7.** New backend table/endpoints carry `tenant_id` + RLS, emit audit events, and
  are pinned by a Docker-gated integration test.

## Key Technical Decisions

- **Expo + React Native, Expo Router.** One TS codebase; file-based routing gives
  typed routes and first-class deep-linking for push taps. (Locked with user;
  alternatives — bare RN, native Swift/Kotlin, Flutter — rejected for setup cost / zero
  contract reuse.)
- **Async voice path, not SSE.** Capture uses record → `POST /api/voice/recordings` →
  poll, not the realtime SSE voice-session. Rationale: works offline (a recording is a
  file), battery-light, ports trivially; the web SSE client had to abandon native
  `EventSource` to header-auth the Clerk token (`useVoiceSession.ts`), which RN can't do
  cleanly. Conversational SSE is deferred.
- **Foreground polling + background push.** Port `usePendingProposals` to RN `AppState`
  for live badges while foregrounded; push covers the backgrounded/closed case. Rejected
  porting the WS gateway for MVP (same header-auth-over-socket problem, more battery).
- **Expo Push (one API over APNs + FCM).** New `ExpoPushDeliveryProvider` mirrors the
  existing `MessageDeliveryProvider` shape (`notifications/delivery-provider.ts`).
  Provider literal `push-gateway`, consistent with the `*-gateway` canonical naming in
  `docs/notifications-provider-migration.md`.
- **Push fires from the two existing injected seams, not a new system.**
  "Needs approval" → an optional `notifyPush?` dep added to
  `RouteUnsupervisedProposalDeps` (`proposals/auto-approve.ts:394`), called exactly where
  `sendSms?` is. "Executed" → a best-effort call inside the existing failure-isolated
  `onExecuted` callback (`app.ts:1610`). Push send is deduped per
  `(proposalId, kind)` (per the idempotency learning in
  `docs/solutions/architecture-patterns/per-tenant-job-shared-idempotency-key.md`).
- **Mobile test runner: `jest-expo`.** Expo's supported path; kept **out of** the root
  `--workspaces` sweep so it never blocks the api/web deploy (see U1). The repo's Vitest
  is web/api-only.
- **Generic `<ProposalCard>` bound to live contracts.** Mirror the *structure* of
  `AIProposalCard.tsx` (TYPE_CONFIG, confidence bar, pricing badges, markers,
  clarification chips) but bind to `@ai-service-os/shared` `proposalResponseSchema` —
  the web card is mock-typed (`../../data/mock-data`) and must not be imported.

## Scope Boundaries

**In scope:** `packages/mobile` Expo app (scaffold, auth, voice capture, approvals +
undo, supporting read screens); the push-notification backend (`device_tokens`, routes,
dispatcher, seam wiring) and client registration/deep-linking.

**Non-goals:**
- Conversational realtime voice (SSE `useVoiceSession`) — later phase.
- Technician/dispatcher field views, multi-role gating — owner-operator only.
- In-app payments / Stripe (D-009 keeps payment to links) — read-only money screens.
- Offline *editing* of proposal payloads; offline catalog resolution.
- App Store / Play Store submission, EAS build pipelines, OTA release config.

### Deferred to follow-up work
- EAS Build + store submission + OTA channel setup.
- WS gateway port for a live "talk to the agent" assistant.
- Push receipt-driven token pruning at scale (basic pruning is in U7).

## Repository invariants touched

- **Integer cents:** client renders cents → currency for display only; no math. (D-003)
- **Tenant timezone:** all dates rendered via tenant `timezone` from `GET /api/me`, not
  device-local.
- **tenant_id + RLS:** `device_tokens` carries `tenant_id`, `ENABLE`/`FORCE ROW LEVEL
  SECURITY`, tenant-isolation policy; queried through the tenant-transaction runner.
- **Audit events:** device-token register/unregister emit audit events via
  `createAuditEvent` (mirror `routes/me.ts` mode-switch call site).
- **Zod proposals / human-approval gate:** client validates proposals with
  `proposalResponseSchema`; approval is always a human tap calling existing endpoints —
  no client-side execution (D-004).
- **Catalog/entity resolver:** unchanged server-side; client surfaces their outputs
  (pricing badges, `voice_clarification` chips, `resolve-line` picker).

## High-Level Technical Design

```
 Mobile (packages/mobile, Expo Router)            Backend (packages/api, existing + M4)
 ───────────────────────────────────              ──────────────────────────────────────
 [Voice Capture]  expo-audio                        POST /api/files/upload-url → PUT → verify
   hold-to-talk ──record──upload───────────────►    POST /api/voice/recordings (idempotencyKey)
                          poll ◄───────────────────  GET  /api/voice/recordings/:id
                                                     (voice-turn → proposals: draft/ready)
 [Approvals inbox] poll 30s (AppState) ─────────►    GET  /api/proposals/inbox
 [Proposal review] approve/reject/edit ────────►    POST /api/proposals/:id/{approve,reject,undo,resolve-line}
   5s undo banner ──undo──────────────────────►     PUT  /api/proposals/:id ; POST /approve-batch
                                                          │ approve → undo window → execute
 [Push registration] POST /api/device-tokens ──►    device_tokens (RLS)            │
 [Deep link /proposals/:id] ◄──push────────────     ExpoPushDeliveryProvider ◄─────┤
                                                       ▲ notifyNeedsApproval        │ onExecuted
                                                       └─ routeUnsupervisedProposal ┘ (app.ts:1610)
                                                          (auto-approve.ts:490)
 Auth: @clerk/clerk-expo + expo-secure-store, getToken({template:'serviceos'}) on every call
```

## Implementation Units

### U1. Scaffold `packages/mobile` Expo workspace (monorepo + CI guard)
- **Goal:** A runnable Expo app added as an **isolated project (NOT a root npm
  workspace)** that does not enter the api/web Docker image or break CI; NativeWind
  wired to a token module extracted from web.
- **Requirements:** R1, R6.
- **Dependencies:** none.
- **Files:**
  - `packages/mobile/package.json` (name `@ai-service-os/mobile`, scripts: `start`,
    `ios`, `android`, `test:mobile` → `jest-expo`; **no** `build`/`test`/`lint` script
    that the root sweep would invoke — see below), `app.json`, `metro.config.js`,
    `babel.config.js`, `tsconfig.json` (extends root, `jsx: react-native`),
    `tailwind.config.js` (NativeWind), `nativewind-env.d.ts`.
  - `packages/mobile/src/theme/tokens.ts` (OKLch/hex palette + `--radius` extracted from
    `packages/web/src/index.css`; light + dark).
  - `packages/mobile/app/_layout.tsx`, `packages/mobile/app/index.tsx` (placeholder
    home so the app renders).
  - Do **not** add `packages/mobile` to root `package.json` `workspaces` — keep it an
    isolated project (own `node_modules`/lockfile). Adding it would break the Docker
    `npm ci` (the workspace isn't COPYed into the image) or pull the Expo/RN tree into
    the api image. Metro resolves `@ai-service-os/shared` from `../shared/dist`.
  - Modify `.dockerignore` → add `packages/mobile`.
  - Modify `Dockerfile` → **no** new `COPY packages/mobile` line (explicit COPYs already
    exclude it); add a comment noting mobile is intentionally excluded.
  - Modify `.github/workflows/pr-checks.yml` → because mobile is not a workspace, the
    root `--workspaces` sweeps already skip it; add a dedicated "Mobile unit tests" step
    (`npx vitest run --root packages/mobile`) so its pure-logic tests still gate PRs.
- **Approach:** Use Expo's monorepo metro preset: `watchFolders: [workspaceRoot]`,
  `resolver.nodeModulesPaths` for both `packages/mobile/node_modules` and root; point
  `@ai-service-os/shared` at `packages/shared` (built `dist`, via package.json `main`).
  `tokens.ts` feeds `tailwind.config.js theme.extend.colors`/`borderRadius`; define a
  `min-h-11`/≥44pt utility. Verify `npm ci` at root still resolves and api/web build.
- **Patterns to follow:** root `package.json` workspaces/scripts; `Dockerfile` explicit
  per-package COPY; `.github/workflows/pr-checks.yml` job structure; web tokens in
  `packages/web/src/index.css`.
- **Test scenarios:**
  - Config/scaffolding: `Test expectation: none — scaffolding`; the meaningful gate is
    CI: `npm ci` + `npm run build --workspace=packages/api --workspace=packages/web
    --workspace=packages/shared` + `npx tsc -p packages/api/tsconfig.build.json --noEmit`
    still pass with mobile present.
  - A trivial `packages/mobile/src/theme/tokens.test.ts` asserting the palette exports
    the expected token keys (guards accidental token drift).
- **Verification:** `npm run start` (Expo) boots the placeholder home; the api/web
  production build and PR CI are green with `packages/mobile` in the tree.

### U2. Auth + API client + `/api/me` bootstrap
- **Goal:** Clerk-native sign-in, a ported API client that injects the `serviceos` JWT
  on every call, and a `useMe` context exposing role/mode/timezone with a mode toggle.
- **Requirements:** R1, R5, R6.
- **Dependencies:** U1.
- **Files:**
  - `packages/mobile/src/lib/apiClient.ts` (+ `apiClient.test.ts`) — port of
    `packages/web/src/lib/apiClient.ts`: `getToken({template:'serviceos'})`,
    `PUBLIC_API_PREFIXES`/`isPublicApiPath`, 401→`skipCache:true` single retry,
    Content-Type-only-for-string-bodies; replace `window.location` redirect with Expo
    Router navigation; base URL from `EXPO_PUBLIC_API_URL`.
  - `packages/mobile/src/lib/tokenCache.ts` — `expo-secure-store`-backed Clerk token
    cache.
  - `packages/mobile/app/_layout.tsx` — wrap in `<ClerkProvider tokenCache>`; auth gate.
  - `packages/mobile/app/(auth)/sign-in.tsx` — Clerk sign-in screen.
  - `packages/mobile/src/hooks/useMe.ts` (+ `useMe.test.ts`) — port of
    `packages/web/src/hooks/useMe.ts`; `GET /api/me`, `switchMode` → `POST /api/me/mode`;
    default-surface `supervisor` mode for owner-operator.
- **Approach:** `@clerk/clerk-expo` mirrors `getToken`/`useAuth`. Reuse the exact
  `serviceos` template so RLS claims (`tenantId`, `role`, `mode`) populate identically.
  `useMe` caches like web; render dates via the returned `timezone`.
- **Patterns to follow:** `packages/web/src/lib/apiClient.ts` + its
  `apiClient.test.ts`/`api-fetch.test.ts`; `packages/web/src/hooks/useMe.ts`;
  `routes/me.ts` response shape (`current_mode`, `timezone`,
  `unsupervised_proposal_routing`).
- **Test scenarios:**
  - Happy path: authenticated `/api/` call gets `Authorization: Bearer <token>`.
  - Edge: public path (`/api/public-*`) skips auth; `getToken()` null → `AbortError`,
    not an unauthenticated request.
  - Error path: 401 → one refresh+retry; persistent 401 → navigates to sign-in (assert
    the RN nav call, not `window.location`).
  - `useMe`: `switchMode('tech')` invalidates cache and re-fetches; mode persists.
- **Verification:** Sign in on a simulator; `GET /api/me` returns the tenant; toggling
  mode round-trips and survives app backgrounding.

### U3. Voice capture → proposal pipeline
- **Goal:** Hold-to-talk recording that uploads and transcribes via the existing
  endpoints, producing proposals that land in the inbox.
- **Requirements:** R2, R5, R6.
- **Dependencies:** U2.
- **Files:**
  - `packages/mobile/src/voice/useVoiceCapture.ts` (+ `useVoiceCapture.test.ts`) — the
    record/upload/poll state machine.
  - `packages/mobile/src/voice/uploadAndTranscribe.ts` (+
    `uploadAndTranscribe.test.ts`) — port the web sequence: `POST /api/files/upload-url`
    → `PUT` → `POST /api/files/:id/verify` → `POST /api/voice/recordings`
    (`idempotencyKey` via `expo-crypto`/`Crypto.randomUUID()`) → poll
    `GET /api/voice/recordings/:id` (interval 1500ms, timeout 90000ms).
  - `packages/mobile/app/voice.tsx` — push-to-talk screen (≥72pt mic, phases
    idle/listening/transcribing/sending; transcript review before submit).
- **Approach:** `expo-audio` records `m4a`/`aac` (both in `ALLOWED_MIME_TYPES`,
  `routes/voice.ts:35`). Reuse the web constants/sequence 1:1; abstract
  `MediaRecorder`/`crypto`/`fetch`-PUT behind the RN equivalents. On success, navigate to
  the inbox (proposals created by the voice-turn processor server-side).
- **Patterns to follow:** `packages/web/src/components/shared/VoiceBar.tsx`
  (`createSignedAudioUpload`, `uploadAndTranscribe`, `pollRecordingUntilDone`,
  `VOICE_POLL_INTERVAL_MS`/`VOICE_POLL_TIMEOUT_MS`);
  `packages/web/src/components/voice/useVoiceRecorder.ts` (max size/duration).
- **Test scenarios:**
  - Happy path: blob → upload-url → PUT → verify → recordings → poll `completed` yields a
    transcript; the same `idempotencyKey` is sent on `POST /recordings`.
  - Edge: poll `timeout` → surfaces "Transcription timed out"; recorder auto-stops at the
    max duration.
  - Error path: `failed` status → surfaces `errorMessage`; upload PUT failure → retryable
    error, recording preserved.
- **Verification:** On a simulator, speaking an action produces a recording whose
  transcript appears, and the resulting proposal is visible in the inbox (U4).

### U4. Approvals inbox + live polling (AppState)
- **Goal:** A prioritized approvals list backed by `GET /api/proposals/inbox`, with a
  live badge that polls while foregrounded and pauses in the background.
- **Requirements:** R3, R5.
- **Dependencies:** U2.
- **Files:**
  - `packages/mobile/src/hooks/usePendingProposals.ts` (+ `usePendingProposals.test.ts`)
    — port of the web hook to RN `AppState` (replace `document.hidden`): 30s poll,
    pause/resume, baseline+diff for new/critical, badge `count`.
  - `packages/mobile/app/(tabs)/approvals.tsx` — inbox list grouped by `chainId`, urgency
    badges, "Approve all (N)" gated at 3+.
  - `packages/mobile/app/(tabs)/_layout.tsx` — tab bar with the Approvals badge.
- **Approach:** Fetch `GET /api/proposals/inbox` (`{ data, summary }`); render each row's
  summary + confidence + markers; tap → review (U5). Validate rows against
  `proposalResponseSchema`.
- **Patterns to follow:** `packages/web/src/hooks/usePendingProposals.ts` (+
  `usePendingProposals.test.tsx`); `packages/web/src/components/inbox/InboxPage.tsx`
  (grouping, urgency, optimistic actions).
- **Test scenarios:**
  - Happy path: inbox renders prioritized rows; badge `count` matches.
  - Edge: app → background pauses polling; → foreground fires a one-shot refresh
    (mock `AppState`).
  - Edge: a newly-arrived proposal fires `onNewProposal` once (not on baseline); a
    proposal within the 2h critical window fires `onCriticalProposal`.
- **Verification:** Inbox updates within ~30s of a new proposal while open; badge clears
  as items are actioned.

### U5. Proposal review + actions + 5-second undo
- **Goal:** A generic typed-payload review screen with approve / reject / edit /
  resolve-line / batch, and a 5-second undo affordance after approve.
- **Requirements:** R3, R5, R6.
- **Dependencies:** U4.
- **Files:**
  - `packages/mobile/src/components/ProposalCard.tsx` (+ `ProposalCard.test.tsx`) —
    generic card keyed on `proposalType`: TYPE_CONFIG registry, confidence bar, pricing
    badges, "what I wasn't sure about" markers, `voice_clarification` chips. Bound to
    `proposalResponseSchema` (NOT the web mock types).
  - `packages/mobile/app/proposals/[id].tsx` (+ `proposals-id.test.tsx`) — detail screen;
    `GET /api/proposals/:id`; actions → `POST /:id/{approve,reject,undo,resolve-line}`,
    `PUT /:id`, `POST /approve-batch`.
  - `packages/mobile/src/components/UndoBanner.tsx` (+ `UndoBanner.test.tsx`) — non-modal
    5s countdown + UNDO → `POST /:id/undo`; on window close, flip to "Executing…".
  - `packages/mobile/src/components/ProposalCard.taptargets.test.tsx` — class/size
    contract: Approve/Reject/Undo/mic ≥44pt (mirror the web tap-target test).
- **Approach:** Per-type detail rows via a small renderer registry, defaulting to a
  key/value dump of `payload`. Capture-class one-tap approve; money/comms/irreversible
  require an explicit on-screen confirm (server-enforced; client mirrors). The 5s timer
  is cosmetic — the server `findReadyForExecution` window is the real gate; handle a
  "window closed" undo error by showing "Executing…". Optimistic flip + revert-on-error
  like `AIProposalCard.runApprove`.
- **Patterns to follow:** `packages/web/src/components/shared/AIProposalCard.tsx`
  (+ `AIProposalCard.test.tsx`) for structure; `InboxPage.tsx` optimistic actions;
  `packages/web/src/components/customer/FeedbackPage.test.tsx` and
  `e2e/estimate-approval-mobile.spec.ts` for the tap-target assertion style;
  `UNDO_WINDOW_MS` (`packages/api/src/proposals/lifecycle.ts:40`).
- **Test scenarios:**
  - Happy path: approve a capture-class proposal → optimistic Approved → undo banner with
    5s countdown.
  - Edge: undo within window calls `POST /:id/undo` and restores; undo after window →
    server rejects → banner flips to "Executing…".
  - Edge: money/comms proposal shows no one-tap approve (explicit confirm required);
    ambiguous catalog line shows the `resolve-line` picker.
  - Error path: approve fails → revert + error toast (no false "approved").
  - Contract: tap targets ≥44pt across Approve/Reject/Undo.
- **Verification:** Full loop on a simulator — voice → proposal → approve → 5s undo →
  (no undo) → executes server-side.

### U6. `device_tokens` table + repository + routes (RLS + audit)
- **Goal:** Persist Expo push tokens per tenant/user with RLS, plus register/unregister
  endpoints that emit audit events.
- **Requirements:** R4, R7.
- **Dependencies:** none (backend; parallelizable with U1–U5).
- **Files:**
  - `packages/api/src/db/schema.ts` — add migration `196_create_device_tokens`
    (`tenant_id UUID REFERENCES tenants(id)`, `user_id TEXT`, `expo_push_token TEXT`,
    `platform TEXT CHECK (platform IN ('ios','android'))`, `device_id TEXT`,
    `last_seen_at TIMESTAMPTZ`, `created_at`, `revoked_at TIMESTAMPTZ`; partial unique
    index on `expo_push_token WHERE revoked_at IS NULL`; index on
    `(tenant_id, user_id) WHERE revoked_at IS NULL`; `ENABLE`/`FORCE ROW LEVEL
    SECURITY` + `tenant_isolation_device_tokens` policy).
  - `packages/api/src/device-tokens/device-token.ts` — `DeviceTokenRepository` interface,
    `PgDeviceTokenRepository`, `InMemoryDeviceTokenRepository` (upsert-on-token,
    soft-revoke, `listActiveForTenant`).
  - `packages/api/src/routes/device-tokens.ts` — `createDeviceTokensRouter(deps)`:
    `POST /api/device-tokens` (`{expoPushToken, platform, deviceId?}`, upsert + audit),
    `DELETE /api/device-tokens/:id` (soft-revoke + audit).
  - Modify `packages/api/src/app.ts` — construct the repo and
    `app.use('/api/device-tokens', createDeviceTokensRouter({ deviceTokenRepo, auditRepo }))`.
  - Modify `packages/shared/src/contracts/` — add `device-token.ts` Zod request/response
    schema; re-export from `src/index.ts` (shared with the RN client).
  - Tests: `packages/api/test/routes/device-tokens.route.test.ts` (unit, `buildTestApp`);
    `packages/api/test/integration/device-tokens.rls.integration.test.ts` (Docker-gated).
- **Approach:** Mirror the `voice_recordings` migration exactly for the
  CREATE/INDEX/RLS shape, plus `FORCE ROW LEVEL SECURITY` per the newer
  `supervisor_policies` convention. Query through `PgTenantTransactionRunner`. Emit audit
  via `createAuditEvent` (`eventType: 'device_token_registered'` /
  `'device_token_revoked'`, `entityType: 'device_token'`) — mirror the `routes/me.ts`
  mode-switch call site.
- **Patterns to follow:** `schema.ts` migration `007_create_voice_recordings` /
  `167_create_supervisor_policies`; `db/tenant-transaction.ts`; `audit/audit.ts` +
  `routes/me.ts:197`; router registration in `app.ts`;
  `packages/api/test/integration/tenant-isolation.leak.test.ts` (the `asTenant` Layer-2
  RLS pattern); `packages/api/test/routes/test-app.ts`.
- **Test scenarios:**
  - Happy path (unit): `POST /api/device-tokens` upserts and returns the row; re-register
    same token resurrects (no duplicate active row); `DELETE` soft-revokes; both emit one
    audit event.
  - Integration (Docker-gated, **mandatory**): a token registered under tenant A is
    invisible to tenant B via the unprivileged-role RLS path (`asTenant`); columns exist
    as written (pin real columns — mocked-Pool tests are insufficient per CLAUDE.md).
  - Edge: invalid `platform` → 400 (Zod); registering an already-active token updates
    `last_seen_at` only.
- **Verification:** Integration suite green under testcontainers; manual `POST`/`DELETE`
  round-trip writes/soft-revokes rows with audit entries.

### U7. Expo push dispatcher + wire the two seams
- **Goal:** Send pushes to a tenant's devices when a proposal needs approval and when an
  approved proposal executes — via the existing injected seams, best-effort and
  failure-isolated.
- **Requirements:** R4.
- **Dependencies:** U6.
- **Files:**
  - `packages/api/src/notifications/push-delivery-provider.ts` — `PushDeliveryProvider`
    interface (`sendPush(messages): Promise<PushSendResult[]>`),
    `InMemoryPushDeliveryProvider`.
  - `packages/api/src/notifications/expo-push-service.ts` (+
    `packages/api/test/notifications/expo-push-service.test.ts`) —
    `ExpoPushDeliveryProvider`: batch `POST https://exp.host/--/api/v2/push/send`, parse
    tickets, poll receipts, return `DeviceNotRegistered` tokens for pruning. Provider
    literal `push-gateway`.
  - `packages/api/src/notifications/proposal-push-notifier.ts` (+
    `proposal-push-notifier.test.ts`) — `notifyNeedsApproval(deps, {tenantId, proposal})`
    and `notifyExecuted(deps, {tenantId, proposalId, resultEntity})`: resolve active
    device tokens (tenant-scoped), build title/body + `data {proposalId, kind, screen}`,
    dedupe per `(proposalId, kind)`, prune revoked tokens. Failure-isolated.
  - Modify `packages/api/src/proposals/auto-approve.ts` — add optional
    `notifyPush?: (args) => Promise<void>` to `RouteUnsupervisedProposalDeps` and call it
    where `sendSms?` is invoked (mirror that exact optional-dep pattern).
  - Modify `packages/api/src/app.ts` — construct `ExpoPushDeliveryProvider` +
    `proposal-push-notifier`; inject `notifyPush` into the
    `routeUnsupervisedProposal` deps; add a best-effort `notifyExecuted(...)` inside the
    existing `onExecuted` callback (alongside the `proposal_correction` enqueue), guarded
    by the existing `status === 'succeeded'` check.
- **Approach:** Keep the notifier a small pure-ish function taking injected deps
  (repo + provider) so it is unit-testable without HTTP. Dedupe via a
  `(proposalId, kind)` key (idempotency learning); do **not** double-notify
  auto-approved proposals — `notifyExecuted` covers them, `notifyNeedsApproval` only
  fires for `ready_for_review` routing. All push failures are swallowed (never break
  approval/execution).
- **Patterns to follow:** `notifications/delivery-provider.ts` +
  `twilio-delivery-provider.ts` (interface + injection shape);
  `proposals/auto-approve.ts:394/519` (`sendSms?` optional-dep pattern);
  `app.ts:1604-1644` (`onExecuted`, failure-isolated try/catch);
  `docs/notifications-provider-migration.md` (provider literal naming).
- **Test scenarios:**
  - Happy path (unit): `notifyNeedsApproval` sends one push per active tenant token with
    `data.kind='needs_approval'`; `notifyExecuted` sends `kind='executed'` once.
  - Seam (unit): `routeUnsupervisedProposal` calls injected `notifyPush` on a
    `ready_for_review` route; `onExecuted` calls `notifyExecuted` on first `succeeded`
    and **not** on a re-execution (`alreadyExecuted`).
  - Edge: a `DeviceNotRegistered` receipt prunes that token; no active tokens → no-op.
  - Error path: provider throws → caught; approval/execution still succeed.
- **Verification:** Unit suites green; in a wired dev env, approving on web triggers an
  "executed" push to a registered device; an unsupervised-routed proposal triggers a
  "needs approval" push.

### U8. Push registration + deep-linking (client)
- **Goal:** The app registers its Expo push token after sign-in, handles foreground vs
  background notifications, and deep-links a tapped push into the proposal review screen.
- **Requirements:** R4.
- **Dependencies:** U2, U5, U6.
- **Files:**
  - `packages/mobile/src/push/registerPushToken.ts` (+ `registerPushToken.test.ts`) —
    request permission, get Expo token, `POST /api/device-tokens`; `DELETE` on sign-out.
  - `packages/mobile/src/push/useNotificationRouter.ts` (+ `useNotificationRouter.test.ts`)
    — foreground handler (suppress OS banner → quiet toast + inbox badge refresh);
    background tap → Expo Router deep link `/proposals/[id]`; `getLastNotificationResponse`
    on cold start.
  - Modify `packages/mobile/app/_layout.tsx` — mount the router; register on auth, revoke
    on sign-out.
- **Approach:** `expo-notifications` for permission/token/handlers. `data.screen`/`kind`
  drive routing: `needs_approval` → `/proposals/[id]` review; `executed` → the result
  entity (fallback to the proposal). Foreground keeps the user's context (no hijack),
  just refreshes the badge.
- **Patterns to follow:** `usePendingProposals` refresh (U4) for the foreground badge;
  `apiClient` (U2) for the register/unregister calls.
- **Test scenarios:**
  - Happy path: post-auth registration POSTs the token; sign-out DELETEs it.
  - Edge: permission denied → app still works (no token; graceful).
  - Routing: a `needs_approval` tap navigates to `/proposals/:id`; cold-start tap via
    `getLastNotificationResponse` lands on the same route; foreground notification does
    not navigate (badge refresh only).
- **Verification:** On a device, a push tap opens the correct proposal; revoking on
  sign-out stops further pushes.

### U9. Supporting read screens (repeatable pattern)
- **Goal:** Read-only Home/Today plus Customers, Jobs, Estimates, Invoices, Schedule, and
  a Settings screen — each a thin list/detail over an existing route.
- **Requirements:** R5, R6.
- **Dependencies:** U2 (and U4 for Home's approvals card).
- **Files (one screen per route; pattern repeats — representative paths):**
  - `packages/mobile/app/(tabs)/index.tsx` — Home/Today (`GET /api/me`,
    `GET /api/proposals/inbox`); approvals card + money/time cards.
  - `packages/mobile/app/(tabs)/customers.tsx`, `app/customers/[id].tsx`
    (`GET /api/customers`).
  - `packages/mobile/app/jobs.tsx`, `app/estimates.tsx`, `app/invoices.tsx`,
    `app/schedule.tsx` (`GET /api/{jobs,estimates,invoices,appointments}`).
  - `packages/mobile/app/settings.tsx` — mode toggle (U2), business info, sign-out.
  - `packages/mobile/src/hooks/useListQuery.ts` + `useDetailQuery.ts`
    (+ `useListQuery.test.ts`) — small RN ports of the web fetch hooks (request-version
    de-dup, AbortError-as-non-error).
- **Approach:** Build the two query hooks once, then each screen is a thin consumer.
  Render money from cents (display-format) and times via tenant `timezone`. No mutations
  here beyond the existing mode toggle.
- **Patterns to follow:** `packages/web/src/hooks/useListQuery.ts` /
  `useDetailQuery.ts`; `packages/web/src/components/home/*` for Home cards.
- **Test scenarios:**
  - Happy path: `useListQuery` paginates/searches; a screen renders rows.
  - Edge: sign-out mid-flight → AbortError treated as non-error; stale response from an
    out-of-order request is dropped (version counter).
  - Contract: currency formatting from cents; dates in tenant tz.
- **Verification:** Each tab loads its data on a simulator; Settings mode toggle persists.

## Risks & Dependencies

- **CI workspace sweep** (`npm test --workspaces`, `build --workspaces`, `lint
  --workspaces`) pulling the RN toolchain into the api/web gate. Mitigation in U1:
  explicit per-workspace CI invocation for api/web/shared; mobile uses `jest-expo` under
  its own `test:mobile`.
- **Metro + ESM `@ai-service-os/shared`** (`type:module`, unbuilt `dist`). Mitigation:
  point Metro at `packages/shared/src` via `watchFolders` (U1).
- **SSE/WS header-auth** can't be done over RN's native EventSource → async voice +
  polling chosen (U3/U4); WS deferred.
- **Push token hygiene:** `DeviceNotRegistered` receipts must prune or dead rows
  accumulate (U7).
- **`AIProposalCard` is mock-typed** — mirror structure only, bind to
  `proposalResponseSchema` (U5).
- **Sequencing:** backend U6→U7 is independent of the client and can land first to
  unblock U8; U2 gates all client feature units.

## Open Questions (deferred to implementation)

- Exact Expo SDK version + `expo-audio` vs `expo-av` final choice (verify current Expo
  recommendation at build time).
- Whether to record push dispatches in a `message_dispatches`-style table (and thus
  formalize the `push-gateway` provider literal) or keep push fire-and-forget for MVP.
- Final `data` payload schema for deep links (`screen` enum) — settle when wiring U8.
- `EXPO_PUBLIC_API_URL` per-environment config mechanism (dev/staging/prod).

## Sources & Research

- Design spec: `docs/mobile/owner-operator-app-spec.md`.
- Decisions: `docs/decisions.md` (D-002 Clerk, D-003 cents, D-004 proposal-first,
  D-011 SMS back-office framing, founding sentence).
- Notifications naming: `docs/notifications-provider-migration.md` (`*-gateway`).
- Idempotency: `docs/solutions/architecture-patterns/per-tenant-job-shared-idempotency-key.md`.
- Backend seams/conventions and client patterns: pinned via repo exploration (paths
  cited inline per unit).

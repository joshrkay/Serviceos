---
title: Owner-Operator Mobile App — Workflows & Screen-Design Spec
status: spec (no app code yet)
persona: owner-operator tradesperson
stack: Expo + React Native
last_updated: 2026-06-19
---

# Owner-Operator Mobile App — Workflows & Screen-Design Spec

> Downloadable iOS + Android apps so an owner-operator tradesperson can run the
> operational side of their business **by voice**, while an AI agent drafts the work
> and they simply **approve** it and get **notified** when it's done.
> "The tradesperson does the trade work, we handle the rest."

This is the design blueprint for the mobile apps. It documents the workflows, the
screen inventory, the one net-new backend system (push notifications), and a phased
build roadmap (M0–M5). **No app code is built from this pass** — this doc plus the
Figma mockups are the deliverable; the roadmap is executed in later passes.

## Why this exists

The backend already implements ~80% of the product. The canonical API
(`packages/api`) exposes the full **voice → AI proposal → approve (with a 5-second
undo) → execute** loop over HTTP, with Clerk auth + Postgres RLS. The web app
(`packages/web`) already contains the voice-capture, proposal-card, and
pending-proposal polling patterns the mobile app mirrors. The single material gap is
**push notifications** — there is no `device_tokens` table and no Expo/APNs/FCM
dispatch anywhere in the codebase.

## Locked decisions

- **Stack:** Expo + React Native — one TypeScript codebase for iOS + Android. Reuses
  `@ai-service-os/shared` (pure-Zod, RN-bundle-safe) contracts, Clerk's native SDK,
  NativeWind for the Tailwind tokens, and Expo Push (one API over both APNs + FCM).
- **Primary persona:** the owner-operator tradesperson — the person who *approves*.
  Default operator **mode = `supervisor`** (the lowest auto-approve threshold, 0.90,
  because they are the approver).
- **MVP = the closed loop:** speak → see proposal → approve (with undo) → get notified
  it ran.

## What already exists — reuse, do **not** rebuild

| Capability | Where | Mobile reuse |
|---|---|---|
| Proposal lifecycle: 44 types, 9 statuses, `decideInitialStatus` auto-approve gate, mode-aware thresholds (supervisor 0.90 / both 0.92 / tech 0.95) | `packages/api/src/proposals/*` | Consume as-is |
| **5-second undo window** (`UNDO_WINDOW_MS=5000`); executor refuses to run within the window; the sweep picks up proposals only *past* it via `findReadyForExecution` | `proposals/lifecycle.ts:40`, `proposals/executor.ts`, `proposals/execution-worker.ts` | Client shows a countdown; the **server is the real gate** |
| Proposal HTTP API: `GET /api/proposals/inbox` (prioritized draft+ready), `GET /:id`, `POST /:id/{approve,reject,undo,resolve-line}`, `PUT /:id` (edit), `POST /approve-batch` | `packages/api/src/routes/proposals.ts` | Direct calls |
| Voice capture pipeline: `POST /api/files/upload-url` → `PUT` → verify → `POST /api/voice/recordings` (with client `idempotencyKey`) → poll `GET /api/voice/recordings/:id` | `routes/voice.ts`, mirrored client `components/shared/VoiceBar.tsx` | Port 1:1 onto `expo-audio` |
| Entity resolver (τ=0.80) → `voice_clarification` proposals; catalog resolver grounds prices, caps confidence ≤0.85 for uncatalogued lines, tags `pricingSource` | `ai/resolution/*`, `ai/voice-turn/*` | Surface in the card |
| Inbox polling + new-proposal diffing (pauses on hidden, refreshes on focus) | `packages/web/src/hooks/usePendingProposals.ts` | Port to `AppState` |
| Proposal card structure: confidence bar, "what I wasn't sure about" markers, pricing badges, clarification chips | `packages/web/src/components/shared/AIProposalCard.tsx` | Mirror **structure only** — it is mock-typed; bind to live `/api/proposals` + shared Zod |
| Auth client: Clerk `getToken({template:'serviceos'})`, public-path skip, 401→retry | `packages/web/src/lib/apiClient.ts` | Port verbatim; swap `window.location` for Expo Router nav |
| Design tokens: OKLch palette, `--radius: 0.625rem`, dark mode, `min-h-11` (≥44px) | `packages/web/src/index.css` | Extract to `tokens.ts` → NativeWind config |

**Two push seams already exist as injected dependencies** — we add a *call*, not a
system:

- **"Needs approval"** — `routeUnsupervisedProposal()` at
  `packages/api/src/proposals/auto-approve.ts:490`. This is *already* the "owner is
  absent → notify them + mint a one-tap SMS approve token" router.
- **"Approved & executed"** — the `onExecuted` callback wired in
  `packages/api/src/app.ts:~1610`. It fires once, on first successful execution, after
  the undo window.

## Core workflows

### 1. Speak an action (the capture loop)

The owner holds the big mic button, says a complete thought ("just finished the
Rodriguez job — bill them 3 hours and the parts"), and releases.

Use the **async record → transcribe → propose** path, **not** the real-time SSE
voice-session path, for the primary capture flow because it:

- works **offline** — a recording is just a file; upload + propose queue until back
  online;
- is **battery-light** — the mic is on only during the utterance, then bursty network;
- **ports trivially** to RN — multipart `fetch` upload + JSON polling; whereas the web
  SSE client had to abandon native `EventSource` to send the Clerk token in an
  `Authorization` header (query tokens leak to logs) and RN fetch-streaming is weak;
- needs no TTS read-back — **the proposal card itself is the confirmation.**

The conversational SSE "talk to the agent" path is deferred to a later phase.

Concrete pipeline (mirrors `VoiceBar.tsx`): record with `expo-audio` to `m4a`/`aac`
(both whitelisted in `routes/voice.ts`) → upload via the existing signed-URL dance →
`POST /api/voice/recordings` with a client `idempotencyKey` → poll
`GET /api/voice/recordings/:id` until `completed`.

### 2. The AI drafts a typed proposal

The transcript routes through the voice-turn processor → intent classifier → entity
resolver → catalog resolver, landing one or more typed proposals in the inbox as
`draft` / `ready_for_review`. **Ambiguity never silently guesses:**

- ambiguous entity → a `voice_clarification` proposal with one-tap candidate chips;
- ambiguous catalog line → an in-card picker via `POST /api/proposals/:id/resolve-line`
  (`{lineIndex, catalogItemId}`) — patches the draft, never approves.

### 3. Review & approve (with undo)

The owner opens the proposal and sees the confidence bar, pricing badges ("From
catalog" / "Needs a pick" / "AI-estimated"), and the "what I wasn't sure about"
markers. They tap **Approve**, and a **non-modal bottom banner shows a 5-second
countdown + UNDO** (`POST /api/proposals/:id/undo`). Capture-class items can one-tap
approve; **money / comms / irreversible items always require an explicit on-screen
confirm** — this is server-enforced (`decideInitialStatus` + action class); the client
only mirrors it. "Approve all (N)" uses `POST /api/proposals/approve-batch` (cap 50),
gated at 3+ like web.

### 4. Notification of the result

- When an approved action **executes** (after the undo window), a **push** confirms it
  ("Done — invoice sent to Rodriguez"), deep-linking to the resulting entity.
- When the owner is **away** and a proposal needs them, a **push** ("Approve: estimate
  for Rodriguez — $1,240?") deep-links straight to the review screen.

## Screen / navigation inventory (Expo Router, file-based deep links)

MVP = the closed loop. Everything else is read-mostly support, later.

| Screen | Endpoint(s) | Mirrors (web) | Phase |
|---|---|---|---|
| **Home / Today** | `GET /api/me`, `GET /api/proposals/inbox` | `home/MoneyLoopHomeCard.tsx`, `Shell.tsx` | MVP |
| **Voice Capture** (push-to-talk) | files upload-url/verify → `POST /api/voice/recordings` → poll | `shared/VoiceBar.tsx` | **MVP (core)** |
| **Approvals inbox** | `GET /api/proposals/inbox`, `?status=ready_for_review` | `inbox/InboxPage.tsx` + `usePendingProposals.ts` | **MVP (core)** |
| **Proposal review** | `GET /:id`; approve/reject/edit/undo/resolve-line; approve-batch | `AIProposalCard.tsx` (structure) | **MVP (core)** |
| **Undo banner** | `POST /:id/undo` | undo affordance | **MVP (core)** |
| **Notifications** | `POST`/`DELETE /api/device-tokens` + `expo-notifications` | net-new | **MVP (the "notify")** |
| **Settings** (mode toggle) | `GET /api/me`, `POST /api/me/mode` | mode toggle | MVP (small) |
| Customers / Jobs / Estimates / Invoices / Schedule | `GET /api/{customers,jobs,estimates,invoices,appointments}` | respective routes | Later (read views) |
| Assistant (conversational voice over SSE) | `POST /api/voice/sessions` + SSE | `useVoiceSession.ts` | Later |

## Net-new backend: push notifications (designed here, built in M4)

- **DB:** add a `device_tokens` table to `packages/api/src/db/schema.ts` `MIGRATIONS`
  (+ a matching `.sql`), following the `voice_recordings` / `supervisor_policies`
  convention: `tenant_id UUID` + RLS (`ENABLE` / `FORCE ROW LEVEL SECURITY`, tenant
  isolation policy), `user_id TEXT` (Clerk id), `expo_push_token`, `platform`
  `CHECK (platform IN ('ios','android'))`, `device_id`, `last_seen_at`, `revoked_at`;
  partial unique index on live tokens (`WHERE revoked_at IS NULL`).
- **Endpoints:** new `routes/device-tokens.ts` — `POST /api/device-tokens` (upsert,
  emit audit event per the "all mutations emit audit" rule), `DELETE
  /api/device-tokens/:id` (soft-revoke on logout / on Expo `DeviceNotRegistered`).
- **Dispatch:** new `notifications/expo-push-service.ts` alongside `send-service.ts` /
  `twilio-delivery-provider.ts` — POST batches to `https://exp.host/--/api/v2/push/send`,
  poll receipts, prune dead tokens. Wire into the DI graph in `app.ts` like the other
  notifiers. Reads tokens through the tenant-transaction helper so RLS is honored.
- **Fire seams:** add an injected `sendPush?` dep to `RouteUnsupervisedProposalDeps`
  (`auto-approve.ts:490`) for "needs approval"; add a push call next to the existing
  queue send inside the `onExecuted` callback (`app.ts:~1610`) for "executed". **Do not
  double-notify** auto-approved proposals (the execution confirmation covers them).
- **Client:** `expo-notifications` registration post-auth → `POST /api/device-tokens`;
  `data` payload `{proposalId, kind, screen}` → Expo Router deep link `/proposals/[id]`;
  foreground suppression + inbox badge refresh; `getLastNotificationResponse()` on cold
  start.

## Client architecture notes

- **Monorepo:** `packages/mobile` as a 4th npm workspace. The Railway build is safe —
  the root `Dockerfile` `COPY`s api/web/shared **explicitly** (no workspace glob), so RN
  never enters the api image; add `packages/mobile` to `.dockerignore`. Avoid root
  `--workspaces` scripts dragging the RN toolchain into the api/web build (use explicit
  per-workspace CI invocation, or give mobile a no-op `build`). Metro points at
  `shared/src` via `watchFolders` to sidestep the unbuilt-`dist` / ESM issue.
- **Auth:** `@clerk/clerk-expo` + an `expo-secure-store` token cache; reuse the
  `template: 'serviceos'` JWT template so the RLS claims (`tenantId`, `role`, `mode`)
  populate identically. Render all times in `tenant_settings.timezone`, never
  device-local.
- **Real-time:** foreground **polling** (port `usePendingProposals` to `AppState`),
  **push** for the backgrounded case. WS/SSE deferred to the later "live agent" phase.
- **Design system:** NativeWind v4 + a `tokens.ts` extracted from `index.css` (OKLch
  literals → `theme.extend.colors` / `borderRadius`); carry both light and dark
  palettes; enforce ≥44pt hit areas (go *larger* on the mic + Approve buttons for dirty
  hands); add `accessibilityRole` / labels and announce the undo countdown.
- **Offline (MVP minimum):** queue voice uploads `{localUri, idempotencyKey}` and
  approvals when offline; flush on reconnect (the `idempotencyKey` + the
  `proposal_executions` uniqueness make replay safe); the undo window starts at server
  `approvedAt`, so a queued approval still gets its real 5s window + execution push —
  the UI shows "Will approve when back online" instead of a live countdown. On reconnect,
  re-fetch `/api/proposals/inbox` rather than trusting local optimistic state. No offline
  editing or catalog resolution.

## Build roadmap (documented; executed in later passes)

Each milestone follows the repo rules: unit tests always; **Docker-gated integration
tests for any DB/endpoint change** (`packages/api/test/integration/`).

- **M0 — Scaffold.** `packages/mobile` Expo app; root workspace + `.dockerignore`;
  metro monorepo + `@ai-service-os/shared` resolution; NativeWind + `tokens.ts` from
  `index.css`. *Guard test:* CI smoke that `npm ci` + the api/web build still pass.
- **M1 — Auth + me.** `@clerk/clerk-expo` + secure-store token cache; port
  `apiClient.ts`; `GET /api/me` bootstrap context; mode toggle. *Unit:* apiClient
  auth-injection / public-path skip / 401-retry.
- **M2 — Voice capture → proposal.** `expo-audio` push-to-talk; port the
  upload → `POST /api/voice/recordings` → poll pipeline. *Unit:* the upload/poll state
  machine. (No backend change.)
- **M3 — Approval + undo.** Inbox (port `usePendingProposals` + `InboxPage`); a generic
  `<ProposalCard>` bound to live `/api/proposals` + shared Zod; approve / reject / edit /
  resolve-line; the 5s undo banner; batch approve. *Unit:* card rendering across proposal
  types + the undo countdown/abort; class-contract test for ≥44px tap targets.
- **M4 — Push (backend + client).** `device_tokens` migration; `routes/device-tokens.ts`;
  `notifications/expo-push-service.ts`; wire the two `sendPush` seams; client registration
  + deep-link handler. **Mandatory Docker-gated integration test:** `device_tokens` RLS
  tenant isolation + register/unregister on **real columns**; unit tests asserting the
  push fires on `ready_for_review` and on first `executed` (and **not** on re-execution).
  This is the only milestone touching the DB.
- **M5 — Supporting read screens.** Customers / Jobs / Estimates / Invoices / Schedule /
  Settings; conversational voice (SSE `useVoiceSession` port) optional.

## Risks

- **SSE/WS auth over RN.** Native `EventSource` can't header-auth; the web client
  abandoned `?token=` for exactly this reason (`useVoiceSession.ts:65`). Mitigated by the
  async voice path + polling for MVP.
- **Root `--workspaces` CI** sweeping the RN toolchain into the api/web deploy →
  explicit per-workspace invocation.
- **`AIProposalCard` is mock-typed** → mirror its structure, bind to live contracts.
- **Expo `DeviceNotRegistered` receipts** must prune dead tokens (build receipt-polling
  into `expo-push-service.ts`).
- **`AppState` vs web `document.hidden`** — the polling pause/resume must be
  re-implemented on RN's lifecycle, not ported verbatim.

## Where existing code already does 80%+

Entire proposal lifecycle / undo / execution (`proposals/*`); the voice capture endpoints
and the exact client sequence (`VoiceBar.tsx`, `routes/voice.ts`); inbox polling +
new-proposal diffing (`usePendingProposals.ts`); the proposal card structure
(`AIProposalCard.tsx`); the two injected push seams (`routeUnsupervisedProposal`,
`onExecuted`); and the auth/token/401 client (`apiClient.ts`) with the `serviceos` JWT
template that fills the RLS claims.

## Appendix — Screen wireframes (5 core screens)

Low-fidelity structural wireframes for the MVP loop. These are the source of truth the
Figma mockups render at high fidelity (same tokens, same tap targets). Mobile frame ≈
390 × 844. Primary tap targets (mic, Approve, Undo) are ≥56pt; all others ≥44pt.

### 1. Home / Today  — `GET /api/me`, `GET /api/proposals/inbox`

```
┌──────────────────────────────────────────┐
│  Good morning, Mike            ☀️ 7:42a   │  greeting + tenant-tz clock
│  Mike's Plumbing · supervisor mode  ⚙︎     │  mode badge → Settings
├──────────────────────────────────────────┤
│  ┌────────────────────────────────────┐  │
│  │  Needs your approval          ● 3  │  │  card → Approvals inbox
│  │  2 estimates · 1 invoice           │  │  (count from inbox payload)
│  │  Tap to review →                   │  │
│  └────────────────────────────────────┘  │
│  ┌────────────────┐ ┌────────────────┐   │
│  │ Today's money  │ │ Time given back │  │  MoneyLoopHomeCard mirror
│  │  $1,240 booked │ │   2h 10m        │  │
│  └────────────────┘ └────────────────┘   │
│                                          │
│  Recent activity                         │
│   ✓ Invoice sent · Rodriguez   2m        │  executed-proposal feed
│   ✓ Appt booked · 123 Oak St   18m       │
├──────────────────────────────────────────┤
│   🏠 Home   🎙 Speak   📋 Approvals(3)  ⚙︎ │  tab bar; Approvals shows badge
└──────────────────────────────────────────┘
```

### 2. Voice Capture (push-to-talk)  — upload-url/verify → `POST /api/voice/recordings` → poll

```
┌──────────────────────────────────────────┐
│  ‹ Back                    Speak an action│
├──────────────────────────────────────────┤
│   "Just finished the Rodriguez job —     │  live/edited transcript appears
│    bill them 3 hours and the parts."     │  after transcription completes
│                                          │
│            ╭───────────────╮             │
│            │   ▁▃▅▇▅▃▁      │             │  waveform while recording
│            ╰───────────────╯             │
│                                          │
│               ╭─────────╮                │
│               │    🎙    │   ← HOLD       │  ≥72pt mic; press-and-hold
│               ╰─────────╯                │  states: idle│listening│
│        Hold to speak · release to send   │  transcribing│sending
│                                          │
│  [ Re-record ]            [ Use this → ] │  ≥44pt; "Use this" submits turn
└──────────────────────────────────────────┘
   Offline → "Saved. Will send when back online" (queued {localUri, idempotencyKey})
```

### 3. Approvals inbox  — `GET /api/proposals/inbox`, `?status=ready_for_review`

```
┌──────────────────────────────────────────┐
│  Approvals                     Approve all │  "Approve all (N)" gated at 3+
├──────────────────────────────────────────┤
│  ┌────────────────────────────────────┐  │
│  │ 🧾 Estimate · Rodriguez            │  │  card per proposal (prioritized)
│  │ $1,240 · 4 line items              │  │
│  │ ▓▓▓▓▓▓▓░░ confidence 0.88          │  │  confidence bar
│  │ ⚠ 1 line needs a pick              │  │  catalog "ambiguous" marker
│  │            [ Review ]  [ Approve ] │  │  Approve = capture-class 1-tap
│  └────────────────────────────────────┘  │
│  ┌────────────────────────────────────┐  │
│  │ 💵 Invoice · 123 Oak St   $480     │  │  money-class →
│  │ ▓▓▓▓▓▓▓▓▓ 0.94                     │  │  no 1-tap; "Review to send"
│  │            [ Review to send → ]    │  │
│  └────────────────────────────────────┘  │
│  ┌────────────────────────────────────┐  │
│  │ ❓ Which "Bob"?                     │  │  voice_clarification →
│  │ [ Bob Rodriguez ] [ Bob's HVAC ]   │  │  one-tap candidate chips
│  └────────────────────────────────────┘  │
└──────────────────────────────────────────┘
   Foreground poll 30s (AppState-aware); pull-to-refresh re-fetches inbox.
```

### 4. Proposal review + 5-second undo  — `GET /:id`; approve/reject/edit/undo/resolve-line

```
┌──────────────────────────────────────────┐         AFTER APPROVE (undo window):
│  ‹ Inbox        Estimate · Rodriguez      │       ┌──────────────────────────────┐
├──────────────────────────────────────────┤       │ ... proposal detail dimmed ...│
│  Summary                                  │       │                              │
│   New water heater + 3h labor             │       │                              │
│  ▓▓▓▓▓▓▓░░  confidence 0.88               │       ├──────────────────────────────┤
│                                          │        │ ✓ Approved · executing in 4s │  countdown
│  Line items                              │        │                    [ UNDO ]  │  ≥56pt UNDO →
│   • 50-gal heater   $720   From catalog  │  badge │                              │  POST /:id/undo
│   • Labor 3h        $360   From catalog  │        └──────────────────────────────┘
│   • Misc fittings   $160   ⚠ Needs a pick│  → resolve-line picker
│                                          │        On window close → banner flips to
│  What I wasn't sure about                │        "Executing…", then dismissed; an
│   • "the parts" → matched fittings (0.71)│        execution push confirms (Screen 5).
│                                          │
│  [ Reject ]   [ Edit ]    [ Approve ✓ ]  │  Approve ≥56pt, primary color
└──────────────────────────────────────────┘
```

### 5. Notification (push + deep-link landing)  — `device-tokens` + `expo-notifications`

```
  LOCK SCREEN (background)                    TAP → deep link /proposals/[id]
┌──────────────────────────────────────────┐   ┌──────────────────────────────────┐
│  🔔 ServiceOS                  now        │   │  ‹            Estimate · Rodriguez │
│  Approve: estimate for Rodriguez          │──►│  (opens Screen 4 review directly) │
│  $1,240 — tap to review                   │   └──────────────────────────────────┘
└──────────────────────────────────────────┘   data: {proposalId, kind:'needs_approval'}

┌──────────────────────────────────────────┐   ┌──────────────────────────────────┐
│  🔔 ServiceOS                  now        │   │  ‹                Invoice · INV-42 │
│  Done — invoice sent to Rodriguez ✓       │──►│  (opens the executed entity)      │
│  Tap to view                              │   └──────────────────────────────────┘
└──────────────────────────────────────────┘   data: {kind:'executed'}; fires once,
   Foreground: OS banner suppressed →           after undo window, via onExecuted seam.
   quiet in-app toast + inbox badge refresh.
```


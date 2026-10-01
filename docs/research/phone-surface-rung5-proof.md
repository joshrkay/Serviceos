---
title: "Hermetic rung-5 proof on the phone surface: what Twilio and signed webhooks allow"
date: 2026-09-11
status: research
tags: [research, telephony, twilio, e2e, rung-5, wayfinder]
ticket: joshrkay/Serviceos#1004
parent: joshrkay/Serviceos#995
---

# Hermetic rung-5 proof on the phone surface

> Research ticket #1004. Primary sources: twilio.com/docs (test credentials, request
> validation, status callbacks, Programmable Voice, Media Streams) and the twilio-node
> SDK source on GitHub (`twilio/twilio-node`). Repo evidence is read-only, from
> `origin/main` — no checkout, no code changes proposed here.

## 0. tl;dr answer to the four research questions

1. **Test credentials**: work for exactly four REST resources (buy a number, send SMS,
   place a call, Lookup); every other endpoint 403s. They never charge, never touch a
   real phone number, and — critically — **never fetch your TwiML `Url` and never fire
   a status callback**, for either SMS or Voice. They prove your HTTP client talks to
   Twilio's real API correctly; they prove nothing about your inbound webhook or about
   delivery/answer.
2. **Yes** — a hermetic process can produce a byte-identical `X-Twilio-Signature` to
   the one Twilio's servers would send, entirely offline, using the Twilio SDK's own
   `getExpectedTwilioSignature(authToken, url, params)` helper (pure HMAC-SHA1, no
   network call). Driving `/api/telephony/voice` / `/gather` / the inbound-SMS route
   this way through the real Express app, with the tenant's own (real or Twilio *test*)
   auth token pulled from `tenant_integrations`, meets the "no SQL, no platform-admin,
   no env var" bar for a normally-provisioned tenant. **The repo already does this** —
   just in Vitest+supertest, not Playwright (`packages/api/test/telephony/
   telephony-routes.test.ts`) — and the QA matrix's own `voice-extras.spec.ts` (VOX-04)
   currently documents the opposite ("cannot be forged"), which this research shows is
   an outdated assumption, not a Twilio limitation.
3. **Media Streams has no documented hermetic path.** No Twilio doc, sample, or
   changelog entry describes a simulator or test mode for the `<Connect><Stream>` /
   WebSocket protocol. Twilio does sign the WS upgrade request the same way (a
   self-signed upgrade is technically constructible with `getExpectedTwilioSignature`
   the same as the HTTP routes), but the realtime audio exchange itself — Twilio
   sending real `media` frames, us sending `mark`/`clear` back — has no way to originate
   without an actual established call. This repo already treats it that way: the
   media-stream server's only signature bypass (`authTestMode`) is explicitly reserved
   for Layer-2 voice-quality tests, never wired into the production app, and the repo
   has a separate, non-hermetic, real-Twilio-credentialed daily job
   (`.github/workflows/voice-smoke-real.yml`) for exactly this gap.
4. A reviewer applying §12.4d should reject **a mocked Twilio client** (stubbing what
   our code would send to Twilio) outright — nothing about Twilio's real behavior is
   exercised. **Twilio test credentials** prove the *outbound* HTTP integration against
   Twilio's real API surface, but not delivery/answer/callbacks — partial proof, and
   only for the outbound leg. **A signed webhook replay** (self-computed
   `X-Twilio-Signature`, real tenant credential, POSTed through the real route) is full
   proof of the *inbound* leg: nothing in our code or in Twilio's signing algorithm is
   faked, only the physical carrier hop is absent.

---

## 1. Twilio test credentials: capability table

Source: [Test Credentials](https://www.twilio.com/docs/iam/test-credentials) (twilio.com/docs/iam/test-credentials).

| Capability | Works with test credentials? | What actually happens | Source |
|---|---|---|---|
| `POST Messages.json` (send SMS) | Yes — mock `201` | Returns a mock Message resource (`sid` like `SMaaaa…`, `status: "queued"`). No carrier interaction. | Test Credentials |
| `POST Calls.json` (place a call) | Yes — mock `201` | Returns a mock Call resource (`sid` like `CAaaaa…`, `status: "completed"`). **"Because no call is placed, Twilio doesn't request the URL specified in the `Url` parameter and no TwiML is executed."** | Test Credentials |
| Buy a phone number (`AvailablePhoneNumbers` / `IncomingPhoneNumbers`) | Yes, with magic numbers | Deterministic success/error per magic number (below) | Test Credentials |
| Lookup API | Yes | Works | Test Credentials |
| Any other resource (Conversations, Verify, Sync, Video, …) | **No** | `403 Forbidden` | Test Credentials |
| Status callback (`StatusCallback` on Messages or Calls) firing for a test-credential send | **No, never** | **"SMS messages and calls sent by using test credentials don't trigger status callbacks."** | Test Credentials |
| Inbound webhook to your app as a side effect of a test-credential call/SMS | **No, never** | Same clause as above — no TwiML fetch, no callback, no simulated inbound reply | Test Credentials |
| Self-computing a valid `X-Twilio-Signature` for a request you construct | **Yes, fully offline** | `getExpectedTwilioSignature(authToken, url, params)` — pure HMAC-SHA1, no network call, works with a real *or* test auth token | [Webhooks security](https://www.twilio.com/docs/usage/webhooks/webhooks-security); [twilio-node source](https://github.com/twilio/twilio-node/blob/main/src/webhooks/webhooks.ts) |
| Media Streams WS session without a live call | **No** | No documented simulator/test mode anywhere in Twilio's docs or sample repos | [Media Streams Overview](https://www.twilio.com/docs/voice/media-streams) |

### Magic phone numbers (test credentials only)

| Number | Context | Result | Error code |
|---|---|---|---|
| `+15005550000` | Buying a number | "Phone number is unavailable" | 21422 |
| `+15005550001` | Buying / SMS `From`+`To` / Call `From`+`To` | "Invalid" | 21421 / 21212 / 21211 / 21212 / 21217 |
| `+15005550002` | SMS `To` / Call `To` | Can't route / unroutable | 21612 / 21214 |
| `+15005550003` | SMS `To` / Call `To` | No international permission | 21408 / 21215 |
| `+15005550004` | SMS `To` / Call `To` | Blocked | 21610 / 21216 |
| `+15005550006` | Buying / SMS `From` / Call `From` | **Succeeds** ("passes all validation") | — |
| `+15005550007` | SMS `From` | Not owned / not SMS-capable | 21606 |
| `+15005550008` | SMS `From` | Message queue full | 21611 |
| `+15005550009` | SMS `To` | Can't receive SMS | 21614 |

Source: Test Credentials page (magic-number tables for phone purchase, SMS From/To, Call
From/To).

This is also the origin of the tenant's live `+15005550006` number mentioned in the
ticket — it is Twilio's own "always succeeds" *outbound-From* magic number, not a
number capable of receiving a real inbound call.

---

## 2. Signature validation: the mechanism that makes hermetic inbound proof possible

Source: [Webhooks security](https://www.twilio.com/docs/usage/webhooks/webhooks-security);
canonical implementation read directly from
[`twilio/twilio-node` `src/webhooks/webhooks.ts`](https://github.com/twilio/twilio-node/blob/main/src/webhooks/webhooks.ts)
(fetched 2026-09-11, `main` branch).

- Twilio signs every webhook with **HMAC-SHA1**, keyed on the account's auth token, over
  the exact URL Twilio called concatenated with the request's parameters sorted
  alphabetically by key (form-encoded requests), or the URL plus a `bodySHA256` query
  param for JSON-body requests. Result is base64-encoded and sent as `X-Twilio-Signature`.
- The twilio-node SDK exports this as two matched, pure functions:
  - `getExpectedTwilioSignature(authToken, url, params): string` — **computes** the
    signature a request should carry. No network call; deterministic; ~15 lines of
    `crypto.createHmac('sha1', authToken)`.
  - `validateRequest(authToken, twilioHeader, url, params): boolean` — **compares** an
    incoming signature against the same computation (with fallback variants for
    port/legacy-querystring quirks).
- These are the *same* function pair: generating a "test" signature is not forging
  anything or reverse-engineering an undocumented protocol — it is calling the
  documented, first-party helper Twilio ships for exactly this purpose, with a
  credential (`authToken`) the tenant genuinely possesses.
- **This repo already relies on exactly this technique**, just not in Playwright:
  - `packages/api/src/telephony/twilio-signature.ts` — `verifyTwilioSignature()` wraps
    `twilio.validateRequest()`; `requireTwilioSignature()` is the Express middleware
    every telephony webhook route runs behind, and it fails **closed** (`500`) if no
    auth token is resolvable, mirroring the Stripe webhook route's loud-fail pattern.
  - `packages/api/test/telephony/twilio-signature.test.ts` and
    `packages/api/test/telephony/telephony-routes.test.ts` build a real Express app
    (`createTelephonyRouter`), sign requests with `twilio.getExpectedTwilioSignature(
    AUTH_TOKEN, url, params)`, and drive them through `supertest` — asserting on the
    real TwiML the route emits (`<Response><Gather…`) and on real session-store state.
    Nothing about Twilio is mocked in these tests; `verifyTwilioSignature` runs for
    real and passes because the signature is genuinely correct.
  - The Media Streams WS upgrade path (`twilio-mediastream-server.ts`) validates
    `X-Twilio-Signature` on the upgrade request the same way, and its only bypass
    (`authTestMode`) is explicitly gated to a single non-production Layer-2
    voice-quality Vitest suite (comment: "Must NEVER be set in production code paths");
    it is not wired into `app.ts`'s real construction, and a dedicated unit test lints
    the source to enforce that.

### Where the tenant's auth token comes from (no SQL / no platform-admin / no env var)

`packages/api/src/app.ts` (`resolveTwilioAuthTokenForSubaccount`) resolves the
per-request Twilio auth token by looking up `tenant_integrations.auth_token_primary_enc`
(keyed on the `AccountSid` Twilio's own body carries), decrypting it with
`TENANT_ENCRYPTION_KEY` — the same standing encryption key every tenant secret already
uses, not something added for a test. This *is* the row a normally-provisioned tenant's
Twilio subaccount already has (created by `packages/api/src/integrations/twilio/
provisioning.ts` during onboarding). Only if that row is absent does it fall back to the
legacy global `process.env.TWILIO_AUTH_TOKEN`. So: a story whose fixture tenant already
went through normal Twilio provisioning needs **zero new SQL, zero platform-admin
action, and zero new env var** to get a real (or Twilio *test*) auth token a hermetic
Playwright run can sign with.

---

## 3. Status callbacks (outbound leg)

- **SMS** — `StatusCallback` on `Messages.json` reports `queued → sent → delivered |
  undelivered | failed`, with `MessageStatus`/`ErrorCode` on the POST to your callback
  URL. Source: [Track the Status of Outbound Messages](https://www.twilio.com/docs/messaging/guides/track-outbound-message-status).
- **Voice** — `StatusCallbackEvent` on `Calls.json` reports `initiated → ringing →
  answered (in-progress) → completed`, with `CallStatus` in
  `queued|initiated|ringing|in-progress|completed|busy|failed|no-answer|canceled`.
  Source: [Call resource](https://www.twilio.com/docs/voice/api/call-resource).
- Both are stated by the Test Credentials page to **never fire for test-credential
  traffic** — this is the load-bearing fact for question 1: you cannot hermetically
  prove "the customer's phone rang" or "the SMS was delivered" via test credentials,
  because Twilio's test-mode explicitly skips the machinery that would produce that
  signal.

---

## 4. Existing e2e specs that already drive phone-shaped journeys (Playwright)

None of the existing `e2e/qa-matrix` specs sign or POST a Twilio-shaped webhook. All
"phone surface" coverage today goes through the **in-app simulated voice channel**
(`POST /api/voice/sessions`, `POST /api/voice/sessions/:id/input` —
`InAppVoiceAdapter`/text-mode driver), which shares the channel-agnostic FSM with the
real Twilio adapters but bypasses `requireTwilioSignature`, `TwilioGatherAdapter`, and
the whole `/api/telephony/*` router entirely.

| Spec | Rows | What it actually drives |
|---|---|---|
| `e2e/qa-matrix/voice-extras.spec.ts` | VOX-01 (emergency triage), VOX-02 (Spanish), VOX-03 (DNC suppression), VOX-04, VOX-12/13 | `/api/voice/sessions*` only. **VOX-04 is a self-documented coverage gap** ("Telephony-only edge cases (documented coverage gap)") that explicitly calls out business-hours enforcement, maintenance-plan caller context, phone rate-limiting, the P6-028 "I'm out today" SMS keyword, and P8-015 dropped-call recovery as needing "live Twilio (signed webhooks / a real call)." Its exact words: *"Tech 'I'm out today' SMS (P6-028): inbound SMS webhook requires a valid X-Twilio-Signature (cannot be forged)."* Section 2 above shows this premise is out of date. |
| `e2e/qa-matrix/voice-billing.spec.ts` | VOX-05..VOX-11 | Same `/api/voice/sessions*` in-app path, for the billing-proposal funnel |
| `e2e/qa-matrix/sms.spec.ts` | SMS-01, SMS-02 | Outbound SMS only, and indirectly — creates customers/jobs/appointments/estimates via REST, then polls `message_dispatches` in Postgres. Never touches the Twilio adapter, the outbound delivery provider's HTTP call, or any inbound route. |
| `e2e/qa-matrix/matrix.ts`, `e2e/journeys/onboarding-v2.spec.ts`, `e2e/README.md` | — | Only pass mentions of "twilio" in surrounding prose/imports; no webhook traffic |

Grep across all of `e2e/` for `X-Twilio-Signature` / `validateRequest` returns exactly
one hit — the VOX-04 comment above, i.e. a note that it *isn't* done, not an instance of
doing it.

### The pattern already proven elsewhere in the repo (Vitest, not Playwright)

These are not Playwright/e2e, but they are the existing, working template for exactly
the technique §8.2/§8.3 move tickets need to lift into a hermetic Playwright spec:

- `packages/api/test/telephony/telephony-routes.test.ts` — full signed HTTP round-trip
  through `createTelephonyRouter` for `/voice` and `/gather`, asserting on real TwiML.
- `packages/api/test/telephony/twilio-signature.test.ts` — unit coverage of
  `verifyTwilioSignature`/`reconstructWebhookUrl` using `twilio.getExpectedTwilioSignature`.
- `packages/api/test/telephony/gather-fallback-route.test.ts`,
  `telephony-voice-gate.test.ts`, `recording-webhook.test.ts`,
  `voicemail-status-route.test.ts` — same signed-request pattern for the other
  telephony routes.
- `packages/api/test/webhooks/twilio-sms-dispatch.test.ts` — the inbound-SMS keyword
  dispatcher test, which deliberately **mocks** `verifyTwilioSignature` and says so in
  its own header comment ("Signature behavior is covered separately by … the dedicated
  twilio-signature unit tests") — i.e. the codebase already treats "prove the signature
  path" and "prove the dispatch wiring" as two separable, both-provable concerns.

Caveat worth flagging to the move tickets: none of the above run inside a Playwright
project or against the `qa-matrix`/`chromium-devauth` webServer processes — they spin up
their own bare `express()` app in-process. Lifting the technique into `e2e/qa-matrix`
means POSTing the signed request at the *already-running* API webServer
(`E2E_API_URL`), not building a parallel app instance, and resolving the auth token the
same way `app.ts` does at runtime (from the seeded tenant's `tenant_integrations` row),
not by constructing a fresh `TwilioGatherAdapter` by hand.

---

## 5. A correction to the ticket's premise: which Playwright project has a real Postgres

The ticket's framing says `chromium-devauth` "runs the API in `DEV_AUTH_BYPASS` mode
against a testcontainer Postgres." Reading `playwright.config.ts` on `origin/main`
directly shows the opposite for that specific project:

```
const devAuthApiServerEnv: NodeJS.ProcessEnv = {
  ...
  TELEPHONY_ENABLED: 'false',
  // Force InMemory repos regardless of any DATABASE_URL/E2E_USE_TEST_DB set
  // for the legacy webServer pair — dev-auth specs run against seeded
  // InMemory data (verify-seed.mjs), never a real/ephemeral Postgres.
  DATABASE_URL: undefined,
  E2E_USE_TEST_DB: undefined,
};
```

`chromium-devauth` is explicitly InMemory-only and explicitly telephony-**disabled**. The
testcontainer/ephemeral-Postgres path (`e2e/fixtures/setup-test-db.ts`,
`E2E_USE_TEST_DB`) belongs to the **legacy webServer pair** (`apiWebServerEnv`), which is
what the opt-in `qa-matrix` Playwright project (`QA_MATRIX=1`) actually runs against —
same pair, real Postgres, `TELEPHONY_ENABLED` not forced off. A hermetic signed-webhook
phone spec belongs in `e2e/qa-matrix` against that pair, not in `chromium-devauth`, which
is the wrong project for this surface today (InMemory repos and telephony explicitly
disabled). Separately, `packages/api/test/integration/*.test.ts` (Vitest, not
Playwright) is a third, independent place that uses `getSharedTestDb()` / testcontainer
Postgres for DB-level integration coverage — also not Playwright.

---

## 6. Story shapes that cannot be proven without a live line

Per Twilio's own documentation (test credentials never fetch your TwiML `Url`, never
fire status callbacks, and there is no simulator for Media Streams), the following
require a real Twilio account with a real recipient phone number — genuinely
un-hermetic, and already treated that way elsewhere in this repo's own CI:

1. **Media Streams realtime transport end-to-end** — Deepgram STT, barge-in, TTS
   playback, `mark`/`clear` backpressure — no documented way to originate the WS
   `media` frame stream without an actual established call. (§8.6/§8.8-adjacent voice
   stories that specifically exercise the realtime path, not the Gather path.)
2. **"An outbound SMS is delivered"** (as opposed to "our code successfully called
   Twilio's Messages API") — `DeliveredCallbackEvent`/`MessageStatus=delivered` never
   fires for test credentials, and no live send happens.
3. **"An outbound call is answered"** — same gap for `CallStatus=answered` /
   `in-progress`; test-credential calls are mock resources only, TwiML is never fetched.
4. **Dropped-call recovery (P8-015)** — the trigger is a live mid-call drop; the
   recovery SMS worker's *trigger condition* is telephony-originated even though the
   worker's own logic could be unit-tested with a synthetic drop event.
5. **Business-hours / after-hours voicemail fallback, and phone-based rate-limiting**
   keyed by inbound caller number — VOX-04 already documents these as unreachable via
   the in-app simulated channel; they *are* reachable via a signed-webhook Playwright
   test per §2/§4 above, so these should move out of "needs a live line" and into
   "needs a signed-webhook spec," not stay lumped with #1–4.
6. **The tenant's real DID actually ringing** (E.164 provisioning correctness,
   carrier-level routing, actual audio codec negotiation) — inherently outside any
   process boundary a test can control.

The repo already has a designated, separate, explicitly-non-hermetic home for this
category: `.github/workflows/voice-smoke-real.yml` — a daily (not per-PR) job that
hard-fails if `TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN`/`TWILIO_TEST_NUMBER_FROM`/
`TWILIO_TEST_NUMBER_TO`/`STAGING_TWIML_URL`/`STAGING_DB_URL` secrets are absent — with a
comment making the same point this research makes: *"a skipped/no-op real-call smoke
must NOT read as a green gate."* Items 1–4 and 6 belong behind that kind of gate, not
rung 5; item 5 does not.

---

## 7. Sources

- [Test Credentials — Twilio Docs](https://www.twilio.com/docs/iam/test-credentials)
- [Webhooks Security — Twilio Docs](https://www.twilio.com/docs/usage/webhooks/webhooks-security)
- [Getting Started with Twilio Webhooks](https://www.twilio.com/docs/usage/webhooks/getting-started-twilio-webhooks)
- [Track the Status of Outbound Messages — Twilio Docs](https://www.twilio.com/docs/messaging/guides/track-outbound-message-status)
- [Call resource — Programmable Voice API](https://www.twilio.com/docs/voice/api/call-resource)
- [Media Streams Overview — Twilio Docs](https://www.twilio.com/docs/voice/media-streams)
- [`twilio/twilio-node` — `src/webhooks/webhooks.ts`](https://github.com/twilio/twilio-node/blob/main/src/webhooks/webhooks.ts) (fetched from `main`, 2026-09-11)
- Repo (read-only, `origin/main`): `packages/api/src/telephony/twilio-signature.ts`,
  `packages/api/src/routes/telephony.ts`, `packages/api/src/telephony/twilio-adapter.ts`,
  `packages/api/src/telephony/media-streams/{mediastream-adapter.ts,
  twilio-mediastream-server.ts}`, `packages/api/src/app.ts`
  (`resolveTwilioAuthTokenForSubaccount`), `packages/api/src/integrations/twilio/
  provisioning.ts`, `packages/api/src/notifications/twilio-delivery-provider.ts`,
  `packages/api/test/telephony/*.test.ts`, `packages/api/test/webhooks/
  twilio-sms-dispatch.test.ts`, `e2e/qa-matrix/{voice-extras,voice-billing,sms}.spec.ts`,
  `playwright.config.ts`, `.github/workflows/voice-smoke-real.yml`.

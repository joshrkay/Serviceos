# Prompt — Ship the Rivet iOS App to the App Store (end-to-end)

_A paste-ready execution prompt. Hand this to Claude Code (or an engineer)
to drive the **Rivet** iOS app from its current in-repo state all the way to
**live on the App Store**. It is grounded in this repo's actual files, so
follow the exact paths and commands below rather than generic Expo advice._

> Companion docs (read, don't duplicate):
> - `packages/mobile/README.md` — dev / QA / how to run
> - `docs/mobile/RELEASE-RUNBOOK.md` — the release-config runbook this prompt operationalizes
> - `packages/mobile/store/` — store listing, Play listing, App Review notes
> - `docs/mobile/owner-operator-app-spec.md` — architecture / feature scope

---

## Role & objective

**You are the release engineer for `@serviceos/mobile`.** The app binary is
real and API-wired — this is a **release-completion** task, not a build-from-
scratch. Your objective: get **Rivet** (`com.serviceos.app`, Expo SDK 52)
onto **TestFlight**, verified against both personas, and then **submitted and
approved on the App Store**.

Work the phases **in order**. Each phase has a **Gate** — do not advance until
the gate passes. Check every box before declaring done.

### Guardrails (non-negotiable)
- **Never commit secrets.** No Apple ID passwords, Clerk `pk_live`/`sk`, ASC
  API keys, or Play service-account JSON in git. Use EAS env / EAS secrets /
  ASC confidential fields. `eas.json` keeps `REPLACE_WITH_*` **placeholders**
  in the repo; real values are supplied at submit time.
- **EAS builds run off this sandbox.** Trigger `eas build` / `eas submit` from
  a developer machine or CI with an `EXPO_TOKEN` — the cloud sandbox cannot
  produce signed iOS binaries.
- **Nothing irreversible without human approval** (CLAUDE.md core rule). App
  Store *submission* and *release* are human-gated: prepare everything, then
  ask before the final "Submit for Review" / "Release".
- **Honesty in store metadata.** No offline-recording claims — v1 has no
  offline queue (see App Review notes).

---

## Current state (already done — verify, don't redo)

Confirmed present in this branch:
- ✅ App exists and is API-wired: routes under `packages/mobile/app/**`,
  feature code under `packages/mobile/src/**` (voice, proposals, push,
  payments, messaging, location, jobs, calls).
- ✅ `app.json`: `expo.name: "Rivet"`, `ios.bundleIdentifier:
  "com.serviceos.app"`, `version: "1.0.0"`, `newArchEnabled: true`,
  `supportsTablet: false`, all iOS `infoPlist` permission strings (mic,
  camera, location, Bluetooth, notifications, local network) branded "Rivet".
- ✅ Config plugins wired: expo-router, expo-audio, expo-camera,
  expo-location, expo-notifications, `@stripe/stripe-terminal-react-native`,
  expo-build-properties, expo-font.
- ✅ Asset **scaffolds** present + wired: `assets/icon.png`, `splash.png`,
  `adaptive-icon.png`, `notification-icon.png` (placeholders — replace before
  public screenshots).
- ✅ Push `projectId` resolution in code (`src/push/nativePushDeps.ts`) —
  reads `app.json` → `expo.extra.eas.projectId` (or `EAS_PROJECT_ID`).
- ✅ Store copy + App Review notes: `packages/mobile/store/`.
- ✅ Config guard: `npm run validate:config`.
- ✅ `eas.json`: `production` profile is store-distribution
  (`appVersionSource: "remote"`, `autoIncrement`).

Known **open gaps** this prompt must close (these are expected — the validator
warns on them today):
- ⛔ `app.json` → `expo.extra.eas.projectId` is **empty** (`eas init` fills it).
- ⛔ `eas.json` → `submit.production.ios` still has `REPLACE_WITH_APPLE_ID_EMAIL`,
  `REPLACE_WITH_APP_STORE_CONNECT_APP_ID`, `REPLACE_WITH_APPLE_TEAM_ID`.
- ⛔ Production `EXPO_PUBLIC_*` env not yet set on EAS (app falls back to
  `http://localhost:3000` when unset — wrong for prod).
- ⛔ **Export-compliance key not set.** `ios.infoPlist` has no
  `ITSAppUsesNonExemptEncryption`, so App Store Connect will prompt for
  encryption compliance on **every** upload. Set it once (see Phase 2).
- ⛔ Placeholder brand assets (icon/splash/notification) — required before
  public listing screenshots.

---

## Phase 0 — Prerequisites (human / accounts, outside the repo)

You cannot ship without these. Gather them first; block and ask the user for
any that are missing.

- [ ] **Apple Developer Program** membership active ($99/yr) — org or individual.
- [ ] **App Store Connect** access with an **Admin** or **App Manager** role.
- [ ] **Apple Team ID** (10-char, e.g. `A1B2C3D4E5`) — Apple Developer →
      Membership. → fills `appleTeamId`.
- [ ] **Apple ID email** used for submission → fills `appleId`.
- [ ] **Expo account** + **`EXPO_TOKEN`** (for CI/off-sandbox builds).
- [ ] **Production API URL** (the deployed Railway API host) → `EXPO_PUBLIC_API_URL`.
- [ ] **Clerk production publishable key** (`pk_live_…`) → `EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY`.
- [ ] **Support URL + Privacy Policy URL** live and reachable (e.g. on
      `https://rivet.ai`) — App Store requires both.
- [ ] **Two demo accounts** (supervisor + technician) on one demo tenant,
      bootstrapped with `tenant_id` in the Clerk JWT (see App Review notes;
      use `packages/api/scripts/bootstrap-mobile-qa-user.ts`). Passwords go in
      ASC confidential fields, **not** git.

**Gate 0:** every box above is checked or explicitly waived by the user.

---

## Phase 1 — Prove the app is release-ready (code gates)

Run from `packages/mobile` unless noted. Fix anything red before advancing.

- [ ] **Type check (mobile):** `npm run typecheck` → clean.
- [ ] **Shared build (monorepo gate, from repo root):**
      `cd packages/api && npx tsc --project tsconfig.build.json --noEmit` → clean
      (CLAUDE.md mandatory build verification; mobile resolves `@ai-service-os/shared`
      from source, so keep shared green).
- [ ] **Unit / hook / screen tests:** `npm test` → green (Vitest, coverage-gated).
- [ ] **RN render tests:** `npm run test:rn` → green (jest-expo).
- [ ] **Viewport e2e:** `npm run e2e:viewport` → no horizontal overflow at
      320px; tap targets ≥44px (CLAUDE.md mobile invariant). In a sandbox
      without Playwright's browser, set `PW_EXECUTABLE_PATH` to a chromium binary.
- [ ] **Config guard:** `npm run validate:config` → exits 0. (Placeholder /
      empty-projectId **warnings** are expected until Phase 2; **errors**
      — missing assets or "ServiceOS" left in a permission string — are not.)

**Gate 1:** all six commands pass (validate:config may still warn, not error).

---

## Phase 2 — iOS project configuration (close the code/config gaps)

Run from `packages/mobile`.

1. **Create the EAS project (writes the real projectId):**
   ```
   npx eas-cli login
   npx eas-cli init      # populates app.json → expo.extra.eas.projectId + owner
   ```
   - [ ] `app.json` → `expo.extra.eas.projectId` is now a real UUID (commit it).
   - The push fix reads it automatically — no code change after init.

2. **Set production runtime env on EAS** (no secrets in repo; see
   `packages/mobile/eas.env.example`):
   ```
   npx eas-cli env:create --environment production --name EXPO_PUBLIC_API_URL --value https://<api-host>
   npx eas-cli env:create --environment production --name EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY --value pk_live_...
   ```
   - [ ] Both set for `production`. (Optional: `EAS_PROJECT_ID` if you prefer
         the env path over `app.json`.)

3. **Set export-compliance once** so uploads stop prompting. Add to
   `app.json` → `expo.ios.infoPlist`:
   ```json
   "ITSAppUsesNonExemptEncryption": false
   ```
   Rivet uses only standard HTTPS/TLS (exempt). If you ever add
   non-exempt crypto, flip this and add the required documentation instead.
   When editing `app.json` keep it **valid JSON** — add the key as a new
   member of the existing `infoPlist` object (mind the trailing comma; no
   comments), then re-run the validator below to confirm it still parses.
   - [ ] Key added; `npm run validate:config` still exits 0.

4. **Fill iOS submit credentials** in `eas.json` →
   `submit.production.ios` (or pass at submit time / via EAS secrets — do
   **not** commit real values if the repo is public):
   - [ ] `appleId` ← Apple ID email
   - [ ] `ascAppId` ← App Store Connect app id (from Phase 4, step 1)
   - [ ] `appleTeamId` ← 10-char Team ID

5. **iOS signing credentials** — let EAS manage them:
   ```
   npx eas-cli credentials        # or accept the prompts during `eas build`
   ```
   - [ ] Distribution cert + provisioning profile for `com.serviceos.app`
         exist (EAS-managed is fine).
   - [ ] **Push key (APNs):** an EAS-managed APNs key is registered (required
         for production push to work end-to-end).

**Gate 2:** `projectId` is real, production env is set, export-compliance key
added, submit creds resolved (in `eas.json` or supplied at submit), signing +
APNs credentials exist.

---

## Phase 3 — Assets & store metadata

- [ ] **App icon** — final 1024×1024 Rivet mark, **no alpha channel**, at
      `assets/icon.png` (Apple rejects transparency in the store icon).
- [ ] **Splash** — `assets/splash.png` (background `#030213`).
- [ ] **Notification icon** — `assets/notification-icon.png` (plugin tint `#1F5FD6`).
- [ ] `npm run validate:config` still exits 0 after swapping assets.
- [ ] **Screenshots** — real device/simulator captures for required iPhone
      sizes (6.7" and 6.5" at minimum; 5.5" if you still support it). Portrait.
- [ ] **Listing copy** finalized from `packages/mobile/store/app-store-listing.md`
      (name, subtitle, promo text, description, keywords, categories).
- [ ] **App Review notes** finalized from
      `packages/mobile/store/app-review-notes.md` — dual-persona walkthrough +
      demo creds (creds in ASC confidential fields, not git).
- [ ] **Privacy "nutrition" labels** in ASC match what the app actually
      collects: location (field tracking), microphone (voice), camera (job
      photos), plus account/identifier data via Clerk. Disclose accurately.
- [ ] **Age rating** questionnaire completed.
- [ ] **Support URL** + **Privacy Policy URL** entered and reachable.

**Gate 3:** validator green with final assets; all metadata drafted in ASC.

---

## Phase 4 — App Store Connect app record

1. [ ] **Create the app** in App Store Connect:
       - Platform iOS, **Bundle ID `com.serviceos.app`** (register it under
         Certificates, Identifiers & Profiles first if it doesn't exist),
         a unique **SKU**, primary language.
       - Copy the generated **ASC app id** back into `eas.json`
         (`ascAppId`) — Phase 2 step 4.
2. [ ] **Pricing:** Free.
3. [ ] **In-App Purchases / Subscriptions:** **none.** Rivet is a companion to
       the web product; account creation, the 14-day trial, and billing all
       happen on the web (Guideline 3.1.1 — see App Review notes). Do **not**
       configure IAP for the subscription.
4. [ ] **Encryption / export compliance:** answered (the `infoPlist` key from
       Phase 2 makes this automatic — standard-encryption exempt).

**Gate 4:** app record exists, `ascAppId` wired into `eas.json`, Free + no-IAP
confirmed.

---

## Phase 5 — Build & submit to TestFlight

Trigger from a dev machine or CI with `EXPO_TOKEN` (not this sandbox).

```
# store-distribution build (REQUIRED for TestFlight — the internal `preview`
# profile is rejected by `eas submit`):
npx eas-cli build --platform ios --profile production

# upload to App Store Connect → TestFlight (explicit profile → submit.production.ios):
npx eas-cli submit --platform ios --profile production
```
- [ ] `production` build succeeds (build number auto-increments server-side;
      marketing version stays `1.0.0`).
- [ ] `eas submit` uploads and the build appears in **TestFlight** and
      finishes **processing**.
- [ ] Provide **TestFlight test details** / beta App Review info if prompted.

**Gate 5:** a processed `1.0.0` build is live in TestFlight.

---

## Phase 6 — TestFlight verification (dual persona, physical device)

Install the TestFlight build on a **physical iPhone** (push + Tap to Pay are
limited/unsupported on Simulator). Exercise **both** demo accounts.

- [ ] **Supervisor:** voice → proposal → **approve** (with 5s undo); Money
      dashboard loads; notification permission granted → `POST /api/devices`
      registers the push token.
- [ ] **Technician:** Today shows assigned jobs; en route / running late; job
      **photo** + **voice note** while online; foreground GPS while Today is open.
- [ ] **Offline:** airplane mode → reconnect banner; **no** claim/behavior of
      queued offline recordings.
- [ ] **Permission prompts** all show **Rivet** copy (mic, camera, location,
      Bluetooth, notifications).
- [ ] **Push end-to-end:** trigger a real approval/dispatch push from the
      backend → confirm receipt on device.
- [ ] (Optional) **Stripe Terminal / Tap to Pay:** grant location + Bluetooth,
      run the reader flow. Deny-path still leaves core flows working.

**Gate 6:** every dual-persona box passes on a real device; push confirmed.

---

## Phase 7 — Submit for App Review & release

**Human-gated. Prepare fully, then ask the user before the final click.**

- [ ] Select the TestFlight build for the **1.0.0** App Store version.
- [ ] All metadata, screenshots, privacy labels, age rating, URLs complete.
- [ ] App Review Information: demo creds + notes attached; contact set.
- [ ] Export compliance answered.
- [ ] **Ask the user to confirm**, then **Submit for Review**.
- [ ] On approval, choose release (manual or automatic). Confirm the listing
      is live and installable from the App Store.

**Gate 7 (Definition of Done):** Rivet `1.0.0` is **approved and live** on the
App Store, installs on a clean device, signs in, and the supervisor +
technician core loops work against the production API.

---

## Fast status checklist (mirror of the runbook)

- [x] Push `projectId` resolution (code)
- [x] Version → 1.0.0
- [x] Rivet `app.json` branding + privacy plugins
- [x] Asset scaffolds present + wired
- [x] Store listings + App Review notes
- [ ] Code gates green (typecheck, shared build, `npm test`, `test:rn`, viewport, validate:config)
- [ ] `eas init` → real `projectId`
- [ ] Production `EXPO_PUBLIC_*` env on EAS
- [ ] `ITSAppUsesNonExemptEncryption` set in `infoPlist`
- [ ] iOS submit creds (`appleId`, `ascAppId`, `appleTeamId`) resolved
- [ ] Signing + APNs credentials (EAS-managed)
- [ ] Final Rivet-mark assets + iPhone screenshots
- [ ] App Store Connect record (Free, no IAP), `ascAppId` wired
- [ ] `eas build --profile production` → `eas submit` → TestFlight processed
- [ ] Dual-persona TestFlight verification on device + push confirmed
- [ ] Submit for Review (human-approved) → **live on App Store**

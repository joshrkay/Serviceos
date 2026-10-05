# Rivet (ServiceOS) Mobile — Store Release Runbook (Blocker #2)

_What it takes to ship the Expo app to TestFlight / Play internal testing.
Pairs with `packages/mobile/README.md` (dev/QA), store copy under
`packages/mobile/store/`, and `docs/LAUNCH-READINESS-v4.md`
(the blocker analysis). The app itself is real and API-wired — these are
release-config gaps, not code gaps._

## Already fixed in code (this branch)

- ✅ **Push token in standalone builds.** `getExpoPushTokenAsync` now receives an
  explicit `projectId` (`src/push/nativePushDeps.ts:resolveProjectId`) resolved
  from `app.json` → `expo.extra.eas.projectId` (or the `EAS_PROJECT_ID` env).
  Without this, push silently dies for every production user. It stays a no-op
  in dev (Expo's dev-client auto-resolves), so behavior is unchanged locally.
- ✅ **Version** bumped `0.0.1` → `1.0.0` (`app.json` + `package.json`).
- ✅ **`extra.eas.projectId` scaffold** added to `app.json` (empty — see step 1;
  `eas init` fills it).
- ✅ **Rivet branding + privacy plugins** in `app.json` (`expo.name: Rivet`,
  mic/camera/location/notifications/Terminal permission strings, splash +
  Android adaptive icon + notification icon wired).
- ✅ **Store listing + App Review notes** under `packages/mobile/store/`
  (honest offline copy; dual-persona demo accounts).
- ✅ **Asset scaffolds present:** `assets/icon.png`, `splash.png`,
  `adaptive-icon.png`, `notification-icon.png` (replace with final Rivet mark
  before public screenshots).
- ✅ **Config guard:** `npm run validate:config` in `packages/mobile`.

## Steps to release (run from `packages/mobile`)

### 1. Create the EAS project (writes the real projectId)
```
npx eas-cli login
npx eas-cli init        # populates app.json → expo.extra.eas.projectId + owner
```
This fills the empty `projectId` scaffold. The push fix above reads it
automatically — no code change after `eas init`. Keep `""` in git until init.

### 2. Provide production runtime env to the build (no secrets in repo)
The app inlines `EXPO_PUBLIC_*` at build time (`src/lib/env.ts` falls back to
`http://localhost:3000` when unset — wrong for prod). Set them as EAS
environment variables — see `packages/mobile/eas.env.example`:
```
npx eas-cli env:create --environment production --name EXPO_PUBLIC_API_URL --value https://<api-host>
npx eas-cli env:create --environment production --name EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY --value pk_live_...
```
(Optionally `EAS_PROJECT_ID` if you prefer the env path over `app.json`.)

For Stripe Terminal Tap to Pay Test builds, also set:
```
npx eas-cli env:create --environment preview --name EXPO_PUBLIC_TERMINAL_SIMULATED --value 1
```
Terminal requires this EAS native build (config plugins in `app.json`). **Expo Go is not supported** once Terminal is linked.

### 3. Fill App Store Connect + Play submit credentials
`eas.json` → `submit.production` still has placeholders:

- **iOS:** `appleId`, `ascAppId`, `appleTeamId` (`REPLACE_WITH_…`). Requires an
  **Apple Developer Program** membership.
- **Android:** `serviceAccountKeyPath: REPLACE_WITH_PLAY_SERVICE_ACCOUNT.json`,
  `track: internal`. Point the path at a Play Console service-account JSON
  (local or CI secret — do not commit the key).

Fill them (or pass via `eas submit` flags / EAS secrets).

### 4. Store assets
Scaffold PNGs are **present and wired** in `app.json`. Before public listing
screenshots, replace with the final Rivet mark:

- **App icon** — 1024×1024 → `./assets/icon.png`
- **Splash** — `./assets/splash.png` (background `#030213`)
- **Android adaptive** — `./assets/adaptive-icon.png`
- **Notification icon** — `./assets/notification-icon.png` (plugin tint `#1F5FD6`)

Run `npm run validate:config` to confirm referenced files exist and permission
strings no longer say “ServiceOS”.

### 5. OTA updates — out of scope for v1
No `expo-updates` / `updates` block / `runtimeVersion` is configured.
**OTA is out of scope for v1** — ship fixes via store builds (TestFlight /
Play internal → production). Revisit `expo-updates` + per-profile `channel`
only after the first dual-persona store release.

### 6. Build + submit (dual-persona TestFlight / Play internal)
Build once; the same binary covers supervisor + technician (role/mode selects
the surface). Exercise **both** demo accounts on TestFlight / Play internal
before external review (see `packages/mobile/store/app-review-notes.md`).
```
npx eas-cli build --platform ios --profile production    # store-distribution build (required for TestFlight)
npx eas-cli submit --platform ios                         # → App Store Connect → TestFlight
# Android internal testing:
npx eas-cli build --platform android --profile production
npx eas-cli submit --platform android                     # uses submit.production.android (internal track)
```
The `production` profile uses `appVersionSource: "remote"` + `autoIncrement`, so
build numbers increment server-side; the `1.0.0` marketing version is set.
Builds run on Expo's servers — trigger from your machine or CI with an
`EXPO_TOKEN`, not from this repo's cloud sandbox.

**TestFlight dual-persona checklist**

- [ ] Supervisor demo: voice → proposal → approve; Money loads; push token registers
- [ ] Technician demo: Today jobs; en route / running late; photo + voice while online
- [ ] Offline: reconnect banner; no claim of queued offline recordings
- [ ] Permission prompts use Rivet copy (mic, camera, location, Bluetooth, notifications)

### 7. Verify push end-to-end (the fix's payoff)
On a **physical device** install of the production build: sign in → grant
notifications → confirm a `POST /api/devices` lands (token registered) → send a
test push from the dispatcher/approval flow → confirm receipt. (Simulators
return `unsupported` by design.)

## Status checklist
- [x] Push `projectId` resolution (code)
- [x] Version → 1.0.0
- [x] Rivet `app.json` branding + privacy plugins
- [x] Asset scaffolds present + wired (icon / splash / adaptive / notification)
- [x] Store listings + App Review notes (dual persona; honest offline)
- [x] `eas.json` Android submit placeholders (`internal` track)
- [x] OTA documented as **out of scope for v1**
- [ ] `eas init` (projectId + owner)
- [ ] Production `EXPO_PUBLIC_*` env on EAS (`eas.env.example`)
- [ ] Replace `REPLACE_WITH_*` iOS + Android submit credentials
- [ ] Final Rivet mark assets (optional before internal TestFlight; required before public screenshots)
- [ ] Dual-persona TestFlight / Play internal verification
- [ ] First external App Review / Play production promotion

## Background audio & spoken answers (#1603) — store-review notes

Hands-free step 1 makes the app PLAY audio: memo answers on the Voice tab are
read back through `POST /api/voice/tts` (same unified TTS provider as the
in-app Assistant), per-device toggle "Speak answers aloud" (default on,
`expo-secure-store` key `voice.speakAnswers`; the text answer always stays on
screen). What changed in the native config, and what a reviewer will ask:

### iOS — `UIBackgroundModes: ["audio"]` (app.json → Info.plist)
- Lets a clip keep playing when the screen locks or the app backgrounds.
  expo-audio selects the `.playback` AVAudioSession category when
  `allowsRecording: false`, and `nativeAssistantDeps.play` sets
  `shouldPlayInBackground: true` + `playsInSilentMode: true` before playing.
- **App Review guideline 2.5.4** (background modes only for their stated
  purpose): the audio background mode is justified ONLY by user-initiated
  audible playback — the spoken answer / Assistant reply. Do not add silent or
  looping audio to "keep the app alive"; that is the classic rejection. In the
  review notes, describe it as "reads the assistant's answer aloud so a
  technician can keep working hands-free; playback ends with the clip."
- No new permission prompt: playback needs none. `NSMicrophoneUsageDescription`
  (recording) is unchanged.

### Android — `shouldPlayInBackground` only on Expo SDK 52 (expo-audio 0.3.5)
- `shouldPlayInBackground: true` stops expo-audio 0.3.5 from pausing players
  when the activity goes to the background, so a short answer finishes with the
  screen off. That is the whole of what this SDK exposes.
- A **media-playback foreground service** (survives Doze / process trimming
  for LONG playback, lock-screen controls) does NOT exist in expo-audio 0.3.5.
  Upstream ships `AudioControlsService` + a config plugin that adds/removes the
  service and its `FOREGROUND_SERVICE` / `FOREGROUND_SERVICE_MEDIA_PLAYBACK`
  permissions only in the SDK-numbered expo-audio releases (SDK 54+). We did
  NOT pre-declare those permissions: Google Play requires a Play Console
  foreground-service declaration (type + use case + demo video) for every
  declared FGS type on Android 14 targets, and declaring them with no backing
  service invites a policy flag for nothing. Follow-up: on the Expo SDK
  upgrade, enable expo-audio's plugin for the media-playback service and file
  the Play Console FGS declaration ("Media playback — reads assistant answers
  aloud") at the same time.
- Technicians now hold the Voice tab + Assistant screen; no new Android
  permission is requested for either.

### Review-ready wording (both stores)
"Rivet reads the assistant's answers aloud (text-to-speech from our server) so
field technicians can keep their hands on the job. Playback is started by the
user, finishes with the clip, and can be turned off per device under Speak
answers aloud. In the app, approvals are never taken by voice — proposals are
reviewed and approved on screen." (D-025 in docs/decisions.md ratifies owner
voice approval on the phone line with readback + challenge; that is a separate
surface and is not part of the mobile app.)

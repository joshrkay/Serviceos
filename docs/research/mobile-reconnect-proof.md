---
title: "Device-Level Proof for the Mobile Offline Reconnect Edge (5.4)"
date: 2026-09-11
status: research-complete
tags: [mobile, offline, e2e, maestro, detox, simctl, adb, wayfinder]
issue: joshrkay/Serviceos#1002
---

# Device-Level Proof for the Mobile Offline Reconnect Edge (5.4)

> **Scope note.** This ticket decides nothing about whether to build the harness — it
> hands the §8.5 move ticket a sourced recommendation. All claims below are cited to a
> primary doc (Expo, Maestro, Detox, Apple, or Android) unless explicitly marked
> **[inference]**.

## Recommendation

**Maestro, driving the Android emulator**, is the only contender whose own docs show
both a real network-connectivity toggle and a real process-kill in the same product,
though not the same single doc page:

- Network toggle: [`toggleAirplaneMode` / `setAirplaneMode`](https://docs.maestro.dev/reference/commands-available/toggleairplanemode)
  — Maestro's own docs state plainly: *"This command is only useful on Android. iOS
  simulators do not have an airplane mode. On iOS or web, the command will pass but has
  no effect."*
- Process kill: [`killApp`](https://docs.maestro.dev/reference/commands-available/killapp)
  — *"The killApp command kills the app on Android... Killing the app on Android
  triggers a System-initiated Process Death."* On iOS/web, `killApp` is only an alias
  for `stopApp` (a clean stop, not a crash-equivalent kill) — so the crash-replay clause
  (3) is only provable as a real OS-level kill on **Android**, not iOS, in Maestro today.

Maestro has no built-in filesystem-assertion command, so clause (4) (audio deleted only
on confirmed flush) is proven by a **wrapping CI shell step**, not the Maestro flow
itself: `adb -s <emulator-serial> shell run-as com.serviceos.app ls files/offline-audio/`
(app must be a **debug-signed / `debuggable`** build for `run-as` to work — confirmed
requirement per [Android Studio's debug docs](https://developer.android.com/studio/debug)).
Detox was the runner-up (see "Why not Detox" below) — its process-kill API is
clean and Node-native, but **its own docs and issue tracker show no network-toggle
primitive at all**, which is the harder half of this problem.

## Assertion mapping (the 4 acceptance clauses)

| # | Acceptance clause | Concrete assertion mechanism |
|---|---|---|
| 1 | Given an offline capture, when connectivity returns, the journal flushes | Maestro flow: `setAirplaneMode: enable` → drive the record-note UI → `assertVisible` the queued/pending state → `setAirplaneMode: disable` → `assertVisible` the item transitioning to done/removed from the pending list. [`setAirplaneMode`](https://docs.maestro.dev/reference/commands-available/toggleairplanemode) is Android-only per Maestro's own docs (no-op on iOS Simulator). |
| 2 | Same idempotency key twice → **one** row, one effective job | Not provable from the app's UI alone — the row-count guarantee is a *server-side* invariant. Concrete mechanism: flow triggers **two flush attempts of the same still-queued item** (e.g. via `killApp` + relaunch between the upload succeeding and `markDone` persisting, per the crash window flush.ts documents), then a `runScript` HTTP call (or a post-flow `curl`/API call in the CI step) hits the API to assert exactly one recording/job row exists for that idempotency key. This is the same invariant `voice-idempotency.test.ts` already proves server-side (rung 4) — the device harness only needs to prove the **client reuses the same key on replay**, which is a filesystem/journal read (see clause 3's mechanism), not a new server assertion. |
| 3 | Create-then-crash replay re-enqueues | Maestro: `killApp` (Android — real "System-initiated Process Death" per [Maestro's killApp docs](https://docs.maestro.dev/reference/commands-available/killapp)) issued mid-flush (timed after the upload step but before the flow would normally complete, exploiting the checkpoint window `flush.ts` documents: "Persist the checkpoint BEFORE POST /recordings so a crash between verify and create resumes past the upload next time"), then `launchApp` to relaunch, then assert (via the wrapping CI shell step) that `offline-queue.json` in the app's data container still lists the item as `pending`/`inflight→pending` with the **same** `idempotencyKey` value it had before the kill — proving replay reuses the key rather than minting a new one. |
| 4 | Local audio deleted **only** on confirmed flush | Two-part filesystem check via the wrapping CI shell step, not the Maestro DSL: (a) immediately after capture (while still offline), `adb shell run-as com.serviceos.app ls files/offline-audio/` must show the file present; (b) immediately after the flush completes (item reaches `done`), the same command must show it **gone**. A third check — kill the app mid-flush (as in clause 3) and confirm the file is **still present** post-relaunch — proves "only on confirmed flush," not "eventually." `run-as` requires a debuggable build and device support, confirmed via `run-as your-package-name pwd` per [Android Studio's debug docs](https://developer.android.com/studio/debug). |

## Honest cost

| Dimension | Answer |
|---|---|
| Build type | A **development build** (`expo-dev-client`), not Expo Go. The app already ships `@stripe/stripe-terminal-react-native`, a third-party native module; Expo's own FAQ explains the mechanism: Expo Go is a fixed pre-built binary, and "there is no way to get the native code into the Expo Go app unless it was already included in the bundle that was uploaded to the app stores" ([Expo dev-builds FAQ](https://docs.expo.dev/develop/development-builds/faq/)). `eas.json`'s existing `development` profile (`developmentClient: true`) is the right starting point, but it has no `android.simulator`/emulator-friendly APK output configured today — that's additive work, not reuse. |
| macOS-only? | **No, if scoped to Android** (the recommended path). The iOS Simulator and `simctl` require macOS + Xcode — Expo's own docs state it plainly: "the iOS Simulator can only be installed on macOS. If you are developing an iOS app from a Windows or a Linux machine, you will need a physical iOS device" ([Expo iOS Simulator docs](https://docs.expo.dev/workflow/ios-simulator/)). The Android emulator has no such OS restriction. Repo reality check: `.github/workflows/pr-checks.yml`'s `mobile-typecheck` job runs on `runs-on: ubuntu-latest` today — there is **no existing macOS runner and no device-testing job anywhere in this repo's CI**. Choosing Android keeps the harness on the existing `ubuntu-latest` runner family (with KVM/nested-virt enabled for the emulator); choosing iOS would add a new, pricier macOS runner class net-new. |
| Minutes per run | Not documented precisely by Maestro for this shape of test. Maestro's own GitHub Actions doc exposes a configurable **`timeout-minutes` defaulting to 30** ([Maestro Cloud GitHub Actions doc](https://docs.maestro.dev/maestro-cloud/ci-cd-integration/github-actions)) but states no typical/median duration. **[inference]** — for a single flow this narrow (capture → toggle airplane mode → kill/relaunch → toggle back → assert), expect low single-digit minutes of flow time plus emulator boot (typically 1–3 min cold-start on a CI runner), i.e. roughly 5–8 minutes end-to-end per run; this is an estimate, not a sourced figure. |
| Known flakiness | Maestro's own marketing/insights content acknowledges the tool's built-in retry/flakiness handling has documented gaps under CI-specific conditions ("slow CI, complex animations, third-party SDKs") ([Maestro Insights: reducing test flakiness](https://maestro.dev/insights/checklist-reducing-test-flakiness)) — this is Maestro's own first-party site, not a third party, though it is blog/marketing content rather than reference docs. Detox, for comparison, documents synchronization-driven hangs directly in its reference docs: *"The test will appear to hang and fail with timeout. This happens because Detox thinks an asynchronous operation is currently taking place and is waiting for it endlessly... It's difficult for an automatic mechanism to be correct in 100% of the cases"* ([Detox synchronization troubleshooting](https://wix.github.io/Detox/docs/19.x/troubleshooting/synchronization/)). Net: both tools carry documented, self-acknowledged flakiness surface; neither publishes a hard failure-rate number. |

## Why not Detox

Detox's process-lifecycle API is clean and framework-native for this use case:
`device.terminateApp()` / `device.launchApp({newInstance: true})` are documented,
stable primitives ([Detox Device API](https://wix.github.io/Detox/docs/api/device/)),
and because Detox specs are plain Node/Jest code, the filesystem assertion
(shelling out to `adb`/`simctl` via `child_process`) can live in the **same test file**
as the app-driving steps — more colocated than Maestro's YAML+external-shell-step split.

But Detox has **no documented network-connectivity-toggle primitive**. Its only
network-related API is `device.setURLBlacklist([urls])`, which *excludes URLs from
Detox's synchronization wait-for-idle mechanism* — it does not cut the app's actual
network access ([Detox Device API](https://wix.github.io/Detox/docs/api/device/)). A
live, unresolved issue on Detox's own repository — *"How does one go about testing an
offline scenario?"* (wix/Detox#1501) — confirms this is a known, unaddressed gap rather
than an oversight in this research. Detox would have to fall back to the same
underlying `simctl`/`adb` network commands Maestro uses anyway (see next section), at
which point Maestro's built-in `setAirplaneMode` command is strictly less scripting to
maintain for the Android path specifically.

## The three network-toggle mechanisms actually available

1. **Maestro `setAirplaneMode`/`toggleAirplaneMode`** — Android-only, no-op on iOS
   Simulator, per Maestro's own docs (cited above). Simplest to author (one YAML line).
2. **Android emulator console `gsm` / `network` commands** — `gsm voice unregistered`
   and `gsm data unregistered` ("No network available") simulate a full disconnect;
   `gsm voice home` / `gsm data home` restore it; `network speed`/`network delay`
   throttle rather than cut. Reachable via `adb -s <serial> emu gsm data unregistered`
   ([Android Emulator console docs](https://developer.android.com/studio/run/emulator-console)).
   This is what Maestro's Android `setAirplaneMode` almost certainly wraps, and is
   available directly to a raw-`adb` harness with no framework at all.
3. **Android emulator `-http-proxy` at launch** — routes all TCP through a specified
   proxy ([Android Emulator command-line docs](https://developer.android.com/studio/run/emulator-commandline)),
   which supports the issue's "narrower alternative" (see below) by letting a CI script
   blackhole the proxy mid-test rather than touching device radio state at all. This is
   a **documented, real Android emulator flag** — not an invented mechanism.

No equivalent was found in any of the four source sets for **iOS Simulator**: Apple's
own `simctl` has no documented network-conditioning or airplane-mode subcommand in the
pages checked, and Maestro's docs explicitly disclaim iOS support for its airplane-mode
command. Proving this edge on iOS would require either a physical device or Apple's
separate Network Link Conditioner tooling, which is out of scope for a CI simulator and
was not chased further given the recommendation is Android-first.

## Filesystem assertion mechanics (both platforms, for completeness)

- **Android**: `adb shell run-as <package> ls files/offline-audio/` and
  `adb exec-out run-as <package> cat files/offline-queue.json` reach the app's private
  data directory without root, **provided the build is `debuggable`**
  ([Android Studio debug docs](https://developer.android.com/studio/debug) — confirms
  `run-as` requires a debuggable build variant and device support, checked via
  `run-as <package> pwd`).
- **iOS** (for a future iOS lane): `xcrun simctl get_app_container <device> <bundle-id>
  data` prints the app's data-container path, inside which `Documents/` holds
  `offline-queue.json` and `offline-audio/` (this app's `documentDirectory`, per
  `nativeOfflineDeps.ts`). This command's existence and container-type options (`app`,
  `data`, `groups`) are corroborated by simctl usage guides; Apple's own web docs do not
  carry a dedicated simctl reference page (it ships only as a man page / `xcrun simctl
  help` bundled with Xcode), so this line item is sourced to community documentation of
  Apple's shipped tool rather than a developer.apple.com page — flagged here rather than
  overstated as first-party.

Neither Maestro's flow DSL nor Detox's `device` API executes shell commands against the
host machine directly (Maestro's `runScript` runs a **sandboxed JS engine**, not Node,
per [Maestro's JavaScript docs](https://docs.maestro.dev/maestro-flows/javascript/javascript-overview) —
it cannot itself shell out to `adb`/`simctl`). Both harnesses require the filesystem
assertion to live in the **wrapping CI script** (a shell step around `maestro test`) or,
for Detox specifically, directly in the Node/Jest spec file via `child_process`.

## The narrower alternative (question 3): local API + `DEV_AUTH_BYPASS`, network cut by proxy

The issue floats: Detox/Maestro driving the real app against a **local** API server
running with `DEV_AUTH_BYPASS=true` (confirmed to exist at
`packages/api/src/auth/dev-auth-bypass.ts`, hard-gated to `NODE_ENV=dev`), with the
network cut by a local proxy instead of real airplane-mode/radio-state toggling.

This is real and buildable on Android: the emulator's `-http-proxy` flag
([Android Emulator command-line docs](https://developer.android.com/studio/run/emulator-commandline))
lets a CI script point the emulator at a local proxy (e.g. `mitmproxy` or a one-file Node
HTTP proxy) that can be toggled to blackhole requests on command — this cuts the app's
*application-layer* connectivity without touching device radio state at all, which is
**more hermetic and CI-friendly** than emulator `gsm`/airplane-mode toggling because it
avoids emulator-console flakiness and keeps everything inside a single reproducible
process the test script controls end to end. It still exercises the real `NetInfo`
listener path only if the app's `isInternetReachable` check (see `connectivity.ts`)
is sensitive to the proxy being unreachable — **this needs verification against the
app's actual `NetInfo` configuration, not assumed**, since `@react-native-community/
netinfo` primarily reports device-level radio/Wi-Fi connectivity, not proxy reachability,
and a blackholed HTTP proxy with an otherwise-connected Wi-Fi radio may leave
`isConnected: true` / `isInternetReachable: false` — which `connectivity.ts` **does**
treat as offline ("Treat 'internet reachable === false' as offline"), so this should
work, but was not confirmed against a live run. No documented Apple or Android feature
sets a *device-wide* HTTP proxy on a *running* iOS Simulator or Android emulator without
a restart (the Android flag is launch-time only, per the same command-line doc) — so
this technique only survives a mid-test toggle if the proxy's own blackhole/passthrough
switch is what's flipped, not the emulator's proxy configuration itself. This still
qualifies as **"device-level"**: the app is unmodified, running on a real
emulator/simulator, driven through its real UI and real native filesystem — only the
network path and the identity-verification step are substituted for hermetic,
deterministic ones.

## What cannot be proven hermetically

**None of the four clauses are unprovable in principle** — all four have a concrete
mechanism above. The honest caveat is **clause 2** (idempotency → one row): the
"one row" half of that guarantee is a database invariant, and no mobile-device harness
should re-prove it — that's what `voice-idempotency.test.ts` already does server-side at
rung 4 per the issue text. The device harness's job for clause 2 is narrower and fully
provable: confirm the **client-side** idempotency key is minted once and reused
byte-for-byte across a replay (via the journal-file read in the clause-3 mechanism), not
re-run the server-side uniqueness proof. Framed that way, no clause is left unprovable;
the risk is scope creep if a future implementer tries to make the device test also own
the server invariant.

## Sources

- [Maestro — `toggleAirplaneMode`](https://docs.maestro.dev/reference/commands-available/toggleairplanemode) (Android-only; no-op on iOS/web)
- [Maestro — `killApp`](https://docs.maestro.dev/reference/commands-available/killapp) (real process death on Android; alias for `stopApp` on iOS/web)
- [Maestro — `stopApp` / `launchApp`](https://docs.maestro.dev/reference/commands-available) (command index)
- [Maestro — JavaScript overview (`runScript` sandboxing)](https://docs.maestro.dev/maestro-flows/javascript/javascript-overview)
- [Maestro Cloud — GitHub Actions integration (timeout default)](https://docs.maestro.dev/maestro-cloud/ci-cd-integration/github-actions)
- [Maestro Insights — checklist for reducing test flakiness](https://maestro.dev/insights/checklist-reducing-test-flakiness) (first-party, marketing/insights content)
- [Detox — Device API (`terminateApp`, `launchApp`, `setURLBlacklist`)](https://wix.github.io/Detox/docs/api/device/)
- [Detox — Synchronization troubleshooting](https://wix.github.io/Detox/docs/19.x/troubleshooting/synchronization/)
- [wix/Detox GitHub issue #1501 — "How does one go about testing an offline scenario?"](https://github.com/wix/Detox/issues/1501) (confirms no built-in offline-simulation primitive)
- [Android Developers — Emulator console commands (`gsm`, `network`)](https://developer.android.com/studio/run/emulator-console)
- [Android Developers — Emulator command-line (`-http-proxy`, `-netspeed`, `-netdelay`)](https://developer.android.com/studio/run/emulator-commandline)
- [Android Developers — Debug your app (`run-as` requirements)](https://developer.android.com/studio/debug)
- [Android Developers — Android Debug Bridge (`adb pull`/`push`)](https://developer.android.com/tools/adb)
- [Expo — Development builds FAQ (why custom native modules need a dev build, not Expo Go)](https://docs.expo.dev/develop/development-builds/faq/)
- [Expo — Development builds introduction](https://docs.expo.dev/develop/development-builds/introduction/)
- [Expo — iOS Simulator setup (macOS requirement)](https://docs.expo.dev/workflow/ios-simulator/)

### Repo facts used (not external docs)
- `packages/mobile/eas.json`, `app.json`, `package.json` (origin/main) — Expo SDK ~52, RN 0.76.9, dev-client profile exists, `@stripe/stripe-terminal-react-native` present.
- `packages/mobile/src/offline/{queue.ts,flush.ts,nativeOfflineDeps.ts}` (origin/main) — journal/audio persistence contract, idempotency-key-once-at-enqueue, crash-recovery-on-load, delete-only-on-markDone.
- `packages/mobile/src/lib/connectivity.ts` (origin/main) — NetInfo wrapper, offline defined as `isConnected===false || isInternetReachable===false`.
- `packages/api/src/auth/dev-auth-bypass.ts` (origin/main) — `DEV_AUTH_BYPASS=true`, hard-gated to `NODE_ENV=dev`.
- `.github/workflows/pr-checks.yml` (origin/main) — `mobile-typecheck` job runs on `ubuntu-latest`; no macOS runner or device-testing job exists in this repo's CI today.

---
title: "Add mobile nav chrome as an additive shell component, not an Expo Router (tabs) group"
date: 2026-06-24
track: knowledge
problem_type: architecture-patterns
module: packages/mobile/app, packages/mobile/src/components
tags: ["expo-router", "navigation", "mobile", "tab-bar", "tests", "jsdom"]
related: ["docs/solutions/architecture-patterns/brand-rebrand-via-semantic-token-swap.md"]
---

## Context

The redesign needed a persistent bottom tab bar (Home · Assistant · Customers ·
Jobs · Settings) and a voice-overlay affordance on every primary screen. The
idiomatic Expo Router move is a `(tabs)` route group with its own `_layout`
rendering `<Tabs>` — but that means **moving every primary screen file into
`app/(tabs)/`**.

That file move is the trap. The mobile screen tests live in `src/screens/*` and
**import the screen directly from `../../app/<route>` while mocking
`expo-router`**. Moving `app/customers.tsx` → `app/(tabs)/customers.tsx` breaks
~12 of those import paths, plus a native `<Tabs>` bar is awkward to assert in the
jsdom class-contract tests.

## Guidance

Add the nav chrome as an **additive shell component** mounted once in
`app/_layout.tsx` around the routed `<Slot/>`, instead of restructuring routes:

- `src/components/TabBar.tsx` — renders the tabs; active state from
  `usePathname()`, `router.navigate()` on press.
- `src/components/VoiceOverlay.tsx` — the mic affordance + a hold-to-talk sheet
  reusing `useVoiceCapture` (capture logic unchanged).
- `src/components/AppChrome.tsx` — wraps `{children}`, decides per-route what to
  show (hide on immersive routes: auth, proposal review, message thread), and is
  dropped into `_layout` as `<AppChrome enabled={isSignedIn}><Slot/></AppChrome>`.

No screen files move; the existing screen/hook tests are untouched. New jsdom
class-contract tests cover the components directly (tap targets, active state,
route predicates, open/close), and `_layout.tsx` stays coverage-excluded.

## Why This Matters

The additive shell shipped the full tab bar + overlay with **0 changes to the 49
existing screen/hook tests** (suite went 335→335 green, +18 new). A `(tabs)`
group would have churned ~12 test imports and the screen files for no
user-visible gain — the design's `Nav.dc.html` is itself a shared bottom-nav
*component*, not a router feature.

Trade-off accepted: one shared navigation stack (via `router.navigate`) instead
of per-tab back-stacks. For a hub app whose routes are flat lists that push to
detail, that's fine; revisit only if independent per-tab history becomes a real
requirement.

## When to Apply

- Adding persistent chrome (tab bar, FAB, global overlay) to an Expo Router app
  whose screens are flat files under `app/` and whose tests import those files
  by path. Prefer a shell component over a route-group restructure.
- Reach for a real `(tabs)` group when you genuinely need per-tab back-stacks /
  state preservation, and are willing to move screen files + fix their test
  imports.

## Examples

```tsx
// app/_layout.tsx — chrome added around Slot, no route files moved
<AppChrome enabled={Boolean(isSignedIn)}>
  <Slot />
</AppChrome>
```

```ts
// Predicates are pure + unit-tested, so visibility rules don't need a running router:
export function isImmersiveRoute(p: string): boolean {
  return p.startsWith('/sign-in') || p.startsWith('/proposals/') || p.startsWith('/messages/');
}
```

Test the components in jsdom by mocking `expo-router` (`useRouter`,
`usePathname`) and `useVoiceCapture` — the same pattern the screen tests already
use. The RN test stub has no `Modal`, so build overlays as absolutely-positioned
`View`s (which is also how the `.dc.html` design sheets work).

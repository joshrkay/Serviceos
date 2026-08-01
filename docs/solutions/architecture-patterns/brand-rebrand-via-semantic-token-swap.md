---
title: "Rebrand both apps by swapping semantic token values, not markup"
date: 2026-06-24
last_updated: 2026-06-24
track: knowledge
problem_type: architecture-patterns
module: packages/mobile/src/theme, packages/web/src/index.css
tags: ["design-tokens", "theming", "nativewind", "tailwind", "rebrand", "tests", "dark-mode"]
related: ["docs/solutions/architecture-patterns/web-palette-to-token-class-migration.md"]
---

## Context

The prototype redesign (Path A) required changing the entire visual brand of
both front-ends — `packages/mobile` (Expo/NativeWind) and `packages/web`
(Vite/Tailwind v4) — from a monochrome palette to brand blue + warm canvas +
ink. The apps have ~250 + 1330 tests respectively, and the instinct is to fear a
rebrand as a sprawling, test-breaking change.

It isn't, **because both apps already drive every color through semantic token
classes** (`bg-primary`, `text-foreground`, `border-border`, …) that resolve to
CSS variables from a single source: `packages/mobile/src/theme/tokens.js`
(mirrored to `packages/web/src/index.css`). A rebrand is therefore a *value*
edit in those two files — not a per-screen restyle.

> **Caveat (web):** this premise held for **mobile** but proved **false for
> `packages/web`**, which hard-coded the raw Tailwind palette (`bg-slate-900`,
> `text-blue-600`, …) in ~6,000 spots, bypassing the tokens. There the value
> swap rebrands nothing; you must migrate the classes cluster by cluster — see
> `web-palette-to-token-class-migration.md`. Grep a target file for
> `-(slate|blue|green|amber|red)-\d` to tell which world you're in before
> assuming a value swap suffices.

## Guidance

To re-skin the apps:

1. Edit the **values** in `packages/mobile/src/theme/tokens.js` (`light` + `dark`
   maps; RN needs hex/rgba, never `oklch()`) and the matching `:root` / `.dark`
   custom properties in `packages/web/src/index.css`. Keep the shared keys in
   sync between the two files.
2. Do **not** touch component markup. Class names are unchanged, so every screen
   — and any shell chrome like the tab bar — inherits the new brand for free.
3. Update only the tests that assert **token values** (e.g. mobile
   `src/theme/tokens.test.ts` pins `light.primary`). Tests that assert class
   **names** (the jsdom class-contract pattern: `min-h-11`, grid classes,
   `w-full`) are unaffected — they never look at computed color.
4. Keep token **keys** identical between `light` and `dark` (the dark-mode CSS
   var swap depends on it; `tokens.test.ts` enforces it) and supply both light
   and dark values for any token. If a design only specifies light, derive a
   contrast-safe dark set and say so in a comment.

## Why This Matters

The blast radius of a full rebrand collapses from "every screen + its tests" to
"two token files + a handful of value-asserting tests." On this codebase the
swap moved 0 screen tests and 0 web class-contract tests (mobile 335 + web 1330
stayed green; only `tokens.test.ts`'s `#1f5fd6` assertion changed). jsdom doesn't
load `index.css`, so web component tests can't even observe color — another
reason they don't churn.

## When to Apply

- Any global visual change (brand, palette, dark-mode tuning) where the apps
  already use semantic token classes rather than hard-coded hex.
- Before a rebrand, grep for hard-coded brand hex that bypasses tokens
  (`grep -rE '#030213|#1f5fd6' packages`) — those are the only spots needing
  manual edits. On this repo the strays were native config (`mobile/app.json`
  splash) and email templates (`api/.../notifications/templates.ts`).

## Examples

```js
// packages/mobile/src/theme/tokens.js — change values, keep keys
const light = {
  background: '#f6f4ef',   // was '#ffffff'
  foreground: '#16202e',   // was '#252525'
  primary: '#1f5fd6',      // was '#030213'  ← the only token test that changed
  // …keys unchanged → CSS-var dark swap + all class-contract tests still hold
};
```

```ts
// The one test that must change — it asserts a value, not a class name:
expect(light.primary).toBe('#1f5fd6'); // was '#030213'
```

Radii and fonts are separate axes: changing `--radius` ripples through
`sm/md/lg/xl` everywhere, so treat it as its own unit rather than bundling it
into the color swap.

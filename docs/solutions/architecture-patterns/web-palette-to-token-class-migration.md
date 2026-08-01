---
title: "Re-brand web by migrating raw palette classes to tokens (when the value-swap doesn't apply)"
date: 2026-06-24
last_updated: 2026-06-25
track: knowledge
problem_type: architecture-patterns
module: packages/web/src/components
tags: ["design-tokens", "tailwind", "rebrand", "sed", "recolor", "migration", "web", "class-contract-test"]
related: ["docs/solutions/architecture-patterns/brand-rebrand-via-semantic-token-swap.md"]
---

## Context

The companion doc (`brand-rebrand-via-semantic-token-swap.md`) says a rebrand is a
*value* edit in two token files because "both apps already drive every color
through semantic token classes." That premise held for **mobile** but was **false
for web**: `packages/web` hard-coded the raw Tailwind palette (`bg-slate-900`,
`text-blue-600`, `bg-green-50`, …) in ~6,000 occurrences across ~180 files,
bypassing the tokens entirely. Swapping `--primary` in `index.css` rebrands
*nothing* those files render.

So the web rebrand was not a value swap — it was a **semantic-class migration**,
done cluster by cluster (home, inbox, customers, …) as one commit each. This doc
is the repeatable technique; it compounds across the remaining clusters.

## Guidance

Per cluster:

1. **Enumerate the exact distinct tokens first** — don't eyeball it:
   ```bash
   grep -rhoE '(bg|text|border|ring|hover:bg|hover:text|focus:border|...)-(slate|gray|red|orange|amber|green|emerald|blue|indigo|violet|...)-[0-9]{2,3}(/[0-9]{1,3})?' <files> \
     | sort | uniq -c | sort -rn
   ```
   This is the input to a precise map and surfaces the color-coded *semantic*
   constructs (confidence bars, severity tiers, category chips) that need a
   judgment call, not a mechanical swap.

2. **Build an EXPLICIT, collision-ordered `sed` map — never a loose
   `s/blue/primary/`.** Tailwind's `-50`/`-500`/`/opacity` suffixes make naive
   substitution mangle classes. Two real failures seen here:
   - `s#bg-amber-50#bg-warning/10#` also matches inside `bg-amber-500` →
     `bg-warning/100` (broken), and inside `bg-amber-50/50` → `bg-warning/10/50`
     (broken).
   - `s#bg-blue-50#bg-primary/10#` matches inside `hover:bg-blue-50/60` →
     `hover:bg-primary/10/60` (broken).

   Order the rules so longer/more-specific tokens are replaced first:
   **(1) opacity-suffixed (`…-50/50`, `hover:…-50/60`) → (2) prefixed
   (`hover:`/`focus:`/`placeholder`) → (3) base 3-digit shades (`-100…-900`,
   `-500`, `-400`) → (4) base `-50` LAST.** sed applies rules top-to-bottom per
   line, so once a longer token is rewritten the shorter rule can't re-match it.

3. **Use the consistent semantic mapping** (matches StatusBadge/StatCard
   conventions):
   - `slate/gray/zinc → neutrals`: text `900–600 → text-foreground`,
     `500–300 → text-muted-foreground`; `bg-900/800 → bg-primary` (dark CTAs &
     avatar initials — confirm they're CTAs, not dark surfaces); `bg-200 →
     bg-border`, `bg-100 → bg-secondary`; `border-* → border-border`; dark
     `text-white → text-primary-foreground`, `bg-white → bg-card`.
   - `blue, indigo → primary` (all shades; `-100 → /15`, `-50 → /10`).
   - `green, emerald → success`; `amber, orange, yellow → warning`;
     `red, rose → destructive` (tints map to `/10`–`/20`).

4. **Hand-fix categorical color maps — collapse, don't translate.** A
   per-*category* hue map (service-type chips, proposal-type configs) is NOT a
   status; Path A only has primary/success/warning/destructive, so forcing a
   category onto `warning` is semantically wrong. Collapse the whole map to one
   neutral token (`bg-secondary text-foreground border-border`) and let the
   existing icon/emoji + label carry the distinction — same call StatusBadge made
   for its 24-status rainbow.

5. **Verify** (the whole point — the migration is mechanical, the proof is the
   grep): re-grep the cluster for raw palette → must be empty; scan for mangled
   artifacts (`grep -nE '/[0-9]+/[0-9]+|/100'`); and pin it with a **class-
   contract test** so it can't regress. Two blind spots make the **source grep**,
   not the jsdom test, the authoritative check:

   - **The guard regex must list EVERY prefix family, not just `bg|text|border`.**
     A narrow regex passes green while `shadow-slate-900`, `border-t-indigo-600`,
     `placeholder-amber-400`, `divide-slate-100`, `ring-*`, and directional
     `border-{l,r,t,b}-*` leak straight through. This is not hypothetical: U8
     (`NewEstimateFlow`) shipped "done" with 5 such classes because its guard only
     listed `(bg|text|border|ring|divide)`; they surfaced two clusters later. Use
     the full prefix set (and keep the brand-map generator's prefix list in sync —
     it had the same gaps for `shadow`/directional-border/`placeholder` until U10):
     ```ts
     const { container } = render(<Page />);
     expect(container.innerHTML).not.toMatch(
       /(bg|text|border|border-l|border-t|placeholder|ring|divide|shadow)-(slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}/,
     );
     ```
   - **A jsdom guard only sees the states it renders.** Leaks on deeper states a
     test never reaches (a step-2 form, a loading spinner, an error banner, a
     warning-tinted picker) escape even a broad regex. U8's 5 leaks lived on inner
     flow steps, so an entry-screen-only guard couldn't have caught them at any
     regex width. Multi-step components (`NewEstimateFlow`, `NewJobFlow`) need the
     per-cluster **source grep** as the source of truth; render-state guards are a
     regression tripwire for the states they mount, not proof of coverage.

## Why This Matters

A loose regex rebrand silently produces broken classes (`bg-warning/100`) that
Tailwind drops — the screen looks half-migrated and no test catches it. The
explicit ordered map is deterministic, and the **grep-clean** turns "did I get all
80 occurrences?" into a binary check. The class-contract test is the regression
*tripwire*, not the coverage proof — it only sees the states it renders and only
the prefixes its regex lists, so a too-narrow regex (or an entry-screen-only
render) reads as a confident green while raw classes survive on inner states. Keep
the regex at the full prefix set and treat the source grep as the authority.
Cluster-at-a-time commits keep each diff reviewable and bisectable.

## When to Apply

Any `packages/web` cluster still on the raw palette (grep a cluster; if
`-(slate|blue|green|amber|red)-\d` returns hits, it needs migration, not a value
swap). For mobile, the value-swap doc still applies — it genuinely uses tokens.

## Examples

```sed
# ordered fragment — opacity & 3-digit BEFORE the bare -50
s#bg-amber-50/50#bg-warning/5#g
s#hover:bg-blue-50/60#hover:bg-primary/10#g
s#bg-amber-500#bg-warning#g
s#bg-amber-200#bg-warning/20#g
s#bg-amber-50#bg-warning/10#g      # safe only because -500/-50/50 ran above
```

```tsx
// categorical map: collapse, don't translate
const SVC_CHIP = {                 // was blue / green / violet tints
  HVAC:     'bg-secondary text-foreground border-border',
  Plumbing: 'bg-secondary text-foreground border-border',
  Painting: 'bg-secondary text-foreground border-border',
}; // ❄️🔧🎨 + label still distinguish them
```

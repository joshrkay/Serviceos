# Rivet — Color Palette

Product: **ServiceOS** · Company: **Rivet**
Tagline: *You handle the work. We handle the business.*

## The idea

A rivet is a **forged fastener** — heated until it glows, driven into steel, and
permanent. The palette is built from that image:

- **Gunmetal** — the steel plate. Deep, cool, load-bearing. Our ink and our
  primary. Not startup navy-blue; a near-black blue-gray that reads as metal.
- **Hot Rivet** — the forge orange of a rivet the instant before it's driven.
  One saturated accent, used with discipline. This is the brand's spark.
- **Steel neutrals** — a cool, slightly blue-gray ramp. Everything that isn't
  ink or fire is machined steel.

This deliberately evolves the earlier navy+amber draft: navy → cooler gunmetal
(more metal, less corporate-SaaS), amber → forge orange (a specific, ownable
story tied to the name, and further from the generic amber every SaaS uses).

Light theme is primary — the marketing site is mobile-first and reads on a
phone in a truck cab in daylight.

---

## Core roles

| Role | Token | Hex | Notes |
|------|-------|-----|-------|
| Primary (ink) | `--color-primary` | `#16212B` | Gunmetal. Headers, primary buttons, body ink. |
| Primary hover | `--color-primary-hover` | `#0F1922` | Pressed state. |
| Accent (bright) | `--color-accent` | `#E5551B` | Hot Rivet. **Large text / buttons / the mark only.** |
| Accent strong | `--color-accent-strong` | `#C4470F` | Rivet-600. Accent as **normal-size text/links** on light (AA). |
| Accent tint | `--color-accent-tint` | `#F6A87F` | Rivet-300. Accent on **dark** surfaces; the dome highlight. |
| Secondary | `--color-secondary` | `#5A6B7D` | Cool Steel. Quiet chrome, secondary UI, rivet details. |

**The one accent rule that matters:** the bright Hot Rivet `#E5551B` only clears
WCAG AA at *large* sizes (3.72:1 as text on white). For any accent text at body
size, or any link, use **`--color-accent-strong` `#C4470F`** (4.93:1, AA). On
dark surfaces, use **`--color-accent-tint` `#F6A87F`** (8.41:1, AAA). Never set
small body text in bright `#E5551B` on white.

---

## Neutral ramp (steel, cool-tinted) — 50→950

| Step | Hex | Typical use |
|------|-----|-------------|
| `--color-neutral-50`  | `#F5F7FA` | Page/section surface, lightest wells |
| `--color-neutral-100` | `#E9EDF2` | Sunk surfaces, code wells, dark-theme text |
| `--color-neutral-200` | `#D4DBE3` | Hairlines, card borders |
| `--color-neutral-300` | `#B2BDC9` | Strong dividers, disabled text on dark |
| `--color-neutral-400` | `#8493A3` | Placeholder, subtle text on dark |
| `--color-neutral-500` | `#647383` | Subtle/caption text on white (AA) |
| `--color-neutral-600` | `#4C5A69` | Muted body/secondary text on white (AAA) |
| `--color-neutral-700` | `#3A4553` | Strong secondary text |
| `--color-neutral-800` | `#27313D` | Dark surface borders |
| `--color-neutral-900` | `#18212B` | Dark surface (near-primary) |
| `--color-neutral-950` | `#0E151C` | Deepest wells, countersink seat in the mark |

---

## Semantic

Chosen to map onto the product's honest, one-tap voice — **warn = "needs you /
I'm not sure"**, which is a first-class state in ServiceOS, not an edge case.

| Role | Base | Tint (for dark) | Meaning in-product |
|------|------|-----------------|--------------------|
| Success | `#1E7A46` | `#3BAE6B` | Paid · booked · done · approved |
| Warn | `#B26A00` | `#E0922B` | Needs you · flagged · low-confidence |
| Error | `#C22E22` | `#F0645A` | Overdue · failed · declined |

> Note: warn base is a **brown-amber**, not yellow — legible with white text and
> visually distinct from the Hot Rivet accent so "caution" never reads as "brand."

---

## WCAG contrast — computed, not guessed

Ratios computed with the WCAG 2.1 relative-luminance formula (sRGB linearization
→ `(L1+0.05)/(L2+0.05)`). Script: `_contrast.py`. Thresholds: AA = 4.5:1 normal /
3.0:1 large; AAA = 7.0:1 normal. "Large" = ≥24px, or ≥18.66px bold.

### Light theme

| Foreground | Background | Ratio | Grade | Pair |
|---|---|---|---|---|
| `#16212B` | `#FFFFFF` | 16.32:1 | AAA | Body text on page |
| `#4C5A69` | `#FFFFFF` | 7.06:1 | AAA | Muted text (`text-muted`) on white |
| `#647383` | `#FFFFFF` | 4.86:1 | AA | Subtle/caption (`text-subtle`) on white |
| `#C4470F` | `#FFFFFF` | 4.93:1 | AA | Link / accent text on white |
| `#16212B` | `#F5F7FA` | 15.21:1 | AAA | Body text on surface |
| `#4C5A69` | `#F5F7FA` | 6.58:1 | AA | Muted text on surface |
| `#C4470F` | `#F5F7FA` | 4.60:1 | AA | Link on surface |
| `#FFFFFF` | `#16212B` | 16.32:1 | AAA | White label on primary button |
| `#16212B` | `#E5551B` | 4.39:1 | AA (lg) | Ink label on bright-accent button (large only) |
| `#FFFFFF` | `#C4470F` | 4.93:1 | AA | White label on accent-strong button (all sizes) |
| `#E5551B` | `#FFFFFF` | 3.72:1 | AA (lg) | Bright accent as large text on white |
| `#FFFFFF` | `#1E7A46` | 5.35:1 | AA | White on success |
| `#FFFFFF` | `#B26A00` | 4.24:1 | AA (lg) | White on warn (use ≥18px bold, or ink-on-tint below) |
| `#16212B` | `#E0922B` | 6.46:1 | AA | Ink on warn-tint (preferred small-text warn) |
| `#FFFFFF` | `#C22E22` | 5.66:1 | AA | White on error |

### Dark theme

| Foreground | Background | Ratio | Grade | Pair |
|---|---|---|---|---|
| `#E9EDF2` | `#16212B` | 13.88:1 | AAA | Body text on dark bg |
| `#B2BDC9` | `#16212B` | 8.56:1 | AAA | Muted text on dark bg |
| `#8493A3` | `#16212B` | 5.19:1 | AA | Subtle text on dark bg |
| `#F6A87F` | `#16212B` | 8.41:1 | AAA | Link / accent-tint on dark bg |
| `#F6A87F` | `#18212B` | 8.38:1 | AAA | Accent-tint on dark surface |
| `#3BAE6B` | `#16212B` | 5.79:1 | AA | Success-tint on dark bg |
| `#F0645A` | `#16212B` | 5.19:1 | AA | Error-tint on dark bg |

**No shipped pair fails AA.** The two AA-large pairs (bright accent as text /
ink on bright accent) are constrained by usage rules above to large contexts.

---

## Usage discipline

1. **One accent.** Hot Rivet is a spark, not a wash. On a given screen it should
   appear a few times — a primary CTA, an active state, the mark — not as
   background fills, big blocks, or every heading. Restraint is what makes it
   read as "forged," not "toy."
2. **Ink does the heavy lifting.** Gunmetal + steel neutrals carry ~90% of the
   surface. This is a workwear palette: mostly steel, one hot spot.
3. **Never small-text-bright-orange on white.** Use `accent-strong` (`#C4470F`).
4. **Warn ≠ brand.** Keep the caution amber-brown clearly separate from the
   accent so "I'm not sure" never looks like a promotion.
5. **Backgrounds pick the accent variant:** light bg → `accent` / `accent-strong`;
   dark bg → `accent-tint`.

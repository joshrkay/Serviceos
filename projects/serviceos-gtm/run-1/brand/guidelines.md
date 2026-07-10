# Rivet — Brand Guidelines

**Company:** Rivet · **Product:** ServiceOS
**Tagline (locked):** *You handle the work. We handle the business.*
**One line:** A voice-AI back office for 1–3-truck owner-operator HVAC & plumbing shops.

This document is standalone. With this file plus `tokens.css` and the five SVG
logo files, a stranger can build an on-brand asset without asking anyone.

---

## 1. What Rivet is (and isn't)

A **rivet** is a forged fastener: heated until it glows, driven through steel,
and permanent — load-bearing, honest, built to last. That's the brand.

Rivet must read as credible to a **38-year-old HVAC owner in Phoenix** and a
**41-year-old solo plumber in Cleveland**. Every visual decision passes one test:

> *Would this look at home on the side of a work truck, and would the person
> driving it trust it?*

**We are:** sturdy, honest, industrial, plainspoken, precise.
**We are not:** pastel SaaS, crypto-slick, gradient-heavy, "playful startup,"
clip-art-wrench, or corporate-consultant navy. No stock "AI" glow, no neon, no
3D blobs, no hard-selling superlatives.

The trust wedge is honesty: *the only AI back office that tells you what it got
wrong.* The brand should feel like it would admit a mistake to your face.

---

## 2. Logo

### Files
| File | What | Use on |
|------|------|--------|
| `logo.svg` | Full lockup: hex-rivet mark + "RIVET" wordmark | Light backgrounds |
| `logo-dark.svg` | Full lockup, light steel + white | Dark / gunmetal backgrounds |
| `logo-mark.svg` | Mark only, square | App tiles, avatars, stamps (light bg) |
| `logo-mark-dark.svg` | Mark only, square | Same, on dark bg |
| `favicon.svg` | Mark, tuned for tiny sizes | Browser tab, 16–64px |

### The mark
A **flat-top hexagon** (a bolt/fastener head — pure hardware-store language)
seating a **forged domed rivet** in Hot Rivet orange, two-tone so it reads as
lit from the upper-left: a rivet the instant before it's driven. The wordmark
"RIVET" is drawn as **heavy geometric letterforms** (no font dependency), in the
spirit of Archivo Black — sturdy, stamped, industrial.

The mark is fully geometric with a set `viewBox` and no external references, so
it renders identically everywhere and stays legible down to 16px.

### Clearspace
Keep clear space equal to **the height of the hexagon's flat top edge** (≈ ¼ of
the mark's height, call it `x`) on all sides of the lockup. Nothing —
text, edges, other logos — inside that margin. When in doubt, more air.

### Minimum sizes
- Full lockup: **120px** wide (digital) / **1 inch** (print).
- Mark alone: **16px** (favicon floor — verified legible at this size).
Below 24px, prefer the mark alone; the wordmark closes up.

### Placement & color
- On white/`neutral-50`: `logo.svg` (ink mark + ink wordmark, orange dome).
- On gunmetal/dark photos: `logo-dark.svg` (light-steel hex, white wordmark,
  orange dome).
- On a busy photo, place the lockup on a solid gunmetal chip or a legible flat
  area — never floating over clutter.
- The dome stays **Hot Rivet orange in every version** — it's the one constant
  spark. Don't recolor it.

### Don'ts
- ❌ Don't recolor the mark or wordmark outside the two provided variants.
- ❌ Don't add gradients, bevels, drop shadows, or "glow" to the mark. It's flat.
- ❌ Don't stretch, condense, skew, or rotate. Scale uniformly only.
- ❌ Don't rebuild the wordmark in a different font (use the SVG; for live text
  fall back to Archivo Black all-caps).
- ❌ Don't put the light lockup on a light background or vice-versa — respect
  contrast.
- ❌ Don't outline, emboss, or "3D" the hexagon. No screw slots (a rivet is
  smooth — a slot would make it a screw).
- ❌ Don't crowd it — honor clearspace.
- ❌ Don't use the mark as a repeating background pattern or watermark.

---

## 3. Color (summary — full detail in `palette.md`)

| Role | Token | Hex |
|------|-------|-----|
| Primary (Gunmetal ink) | `--color-primary` | `#16212B` |
| Accent bright (Hot Rivet) | `--color-accent` | `#E5551B` |
| Accent text/link (light bg) | `--color-accent-strong` | `#C4470F` |
| Accent on dark | `--color-accent-tint` | `#F6A87F` |
| Secondary (Cool Steel) | `--color-secondary` | `#5A6B7D` |
| Neutral ramp | `--color-neutral-50 … 950` | `#F5F7FA … #0E151C` |
| Success / Warn / Error | semantic tokens | `#1E7A46` / `#B26A00` / `#C22E22` |

**Roles:** Gunmetal + steel neutrals do ~90% of the work (this is a workwear
palette — mostly steel, one hot spot). Hot Rivet is a *spark*, used a few times
per screen: primary CTA, active state, the mark. **Never** set small body text
in bright orange on white — use `accent-strong` (`#C4470F`). On dark, use
`accent-tint`. Keep the caution amber-brown (`warn`) clearly distinct from the
accent so "I'm not sure" never reads as a promotion. All contrast pairs are
computed and pass WCAG AA (table in `palette.md`).

---

## 4. Typography (summary — full detail in `typography.md`)

- **Display: Archivo** (700–900) — heavy, tight, sturdy headlines.
- **Body: IBM Plex Sans** (400/500/600) — honest, precise, 16px min on mobile.
- **Data: IBM Plex Mono** (500) — prices, IDs, confidence scores, phone numbers.

Rules: headlines Archivo 800/900, `-0.02em`, line-height 1.05, **sentence case**.
Body Plex 400 at ≥16px, line-height 1.6, ≤68 chars/line. Eyebrows uppercase Plex
600, 12–14px, `+0.08em`, in `accent-strong`. Never a third family.

---

## 5. Voice & tone

We sound like a straight-talking shop owner who happens to be reliable — not a
tech company. **Read the room: the reader is tired, busy, and has been burned by
software before.**

**Principles**
- **Direct and plain.** Short sentences. Say the thing. "AI answers your phone,
  books your jobs, and chases your invoices." Not "leverage our AI-powered
  platform to optimize customer engagement workflows."
- **Working-class register, never condescending.** Talk to a pro like a pro.
  They know their trade better than we ever will; we just run the paperwork.
- **Honest about limits.** This is the whole brand: *"the only AI that tells you
  what it got wrong."* We surface uncertainty. We don't oversell. If it might be
  wrong, we say so.
- **Concrete over abstract.** Dollars, hours, a real Tuesday. "Recover 15 hours a
  week." "Approve a $1,400 estimate from your truck in 30 seconds."
- **Respect their time.** Every sentence earns its place. If Mike, in an attic
  with gloves on, can't get it in 5 seconds, cut it.
- **Confident, not boastful.** No "revolutionary," "game-changing," "seamless,"
  "unleash," "supercharge," "10x," or exclamation-point hype.

**No startup jargon.** Banned: synergy, leverage (as verb), seamless, frictionless,
robust, cutting-edge, next-gen, disrupt, empower, unlock, holistic, ecosystem,
solutions (as a noun for the product), "reach out."

**Do / Don't examples**
- ✅ "You handle the work. We handle the business."
- ✅ "It answers every call, even when you're under a condenser."
- ✅ "Sometimes it gets a part number wrong. When it's not sure, it tells you —
  before the quote goes out."
- ❌ "Revolutionize your service business with our seamless AI platform!"
- ❌ "Unlock next-gen operational efficiency."

**Tone by context:** Marketing = confident and warm. Product SMS = short, useful,
one decision at a time. Errors/uncertainty = plain and accountable ("I wasn't
sure about this part — want me to check with Carlos?"). Never chirpy, never
robotic.

---

## 6. Photography & illustration

**Photography — the primary visual mode.** Real tradespeople, real trucks, real
job sites.
- **Do:** authentic HVAC/plumbing work — hands on tools, a tech at a condenser,
  a van at a curb, a phone in a work-gloved hand, early light in Phoenix, a
  flooded Cleveland basement. Natural light. Slightly desaturated, cool
  steel-leaning grade so images sit with the palette; let the one warm hit be
  a real-world orange (safety vest, sunset, sodium light) echoing the accent.
- **Don't:** stock "diverse team high-fiving at laptops," headset call-center
  smiles, glossy influencer gloss, staged perfection, or anything that's clearly
  never touched a jobsite. No fake AI/robot imagery. No literal wrenches-as-logos.
- **Framing:** give people dignity and competence. The hero is the tradesperson,
  not the software. We're the quiet partner in the passenger seat.

**Illustration & iconography.**
- **Icons:** simple, geometric, line or solid, 2px-equivalent weight, square
  corners softened to `radius-sm`. Industrial/utilitarian — think equipment
  plates and gauges, not rounded "friendly" blobs. Ink or steel by default;
  accent only for the single active/important icon.
- **Motifs derived from the mark:** the hexagon, the rivet dome, and a "seam of
  rivets" (a row of dots) can be used as quiet dividers, list bullets, or
  step-markers. Use sparingly — texture, not decoration.
- **No 3D renders, no gradients-as-illustration, no mascot.**

---

## 7. UI components

Built from `tokens.css`. Sturdy, high-contrast, generous tap targets — this is
used one-handed, in daylight, sometimes with gloves.

**Buttons**
- **Primary:** `--color-accent` (`#E5551B`) background, ink label
  (`--color-accent-contrast`), `radius-md`, `font-body` 600, min height
  `--tap-min` (44px), horizontal padding `--space-6`. Label ≥16px (keeps it in
  AA-large territory on the bright accent). Hover: darken to `accent-strong`.
  Focus: `--shadow-focus` ring.
  - For **small** primary buttons or any button under 18px label, use
    `--color-accent-strong` (`#C4470F`) bg + **white** label (AA at all sizes).
- **Secondary:** transparent bg, `--color-primary` label, 1px
  `--color-border-strong` border, `radius-md`. Hover: `--color-surface` fill.
- **Ghost/tertiary:** ink/steel text link, no border; link color
  `--color-link`.
- All buttons: `min-height: var(--tap-min)`; never below 44px on touch.

**Cards**
- `--color-surface` (or `bg` with 1px `--color-border`), `radius-md`/`lg`,
  padding `--space-6`, `--shadow-sm` (raise to `md` on hover for interactive
  cards). Restrained shadows — the brand is sturdy, not floaty. Title in Archivo
  700 `text-2xl`, body Plex 400 `text-base` `text-muted`.

**Forms & inputs**
- Inputs: `bg`, 1px `--color-border-strong`, `radius-sm`, min-height 44px, 16px
  text (prevents iOS zoom). Focus: accent ring `--shadow-focus`. Labels Plex 500
  `text-sm`. Error text `--color-error`, helper text `--color-text-subtle`.

**Confidence / status chips** (the product's signature)
- Pills, `radius-full`, `text-xs` Plex 600 uppercase `+0.08em`.
- "Booked/Paid" → success. "Needs you / Low confidence" → warn (ink on
  `warn-tint`). "Overdue/Failed" → error. Use the honest ones proudly — the
  "I'm not sure" state is a feature, style it as first-class, not as an alarm.

**General UI**
- No horizontal overflow at 320px. Tap targets ≥44px. Mobile-first: design the
  phone layout first, enhance up.

---

## 8. Example applications

### A. Business card (3.5 × 2 in)
- **Front:** solid Gunmetal (`--color-primary`). `logo-dark.svg` lockup
  top-left, honoring clearspace. Nothing else. The orange dome is the only
  color. Sturdy and quiet.
- **Back:** `neutral-50` background. Name in Archivo 700 (`text-xl`), role in
  Plex 500 `text-sm` `text-muted` ("Owner · M&R Mechanical" style). Phone/email
  in **Plex Mono 500** `text-sm`, ink. A single Hot Rivet seam (three small
  rivet dots) as a divider above the contact block. No QR clutter; if used, one
  small code bottom-right.
- Feels like a stamped equipment plate, not a networking card.

### B. Truck decal / door magnet (~24 × 18 in, high visibility)
- Reads at 40 feet in sunlight. **Mark alone** (`logo-mark.svg` or its
  vinyl-cut equivalent) at large size, with "RIVET" wordmark beneath OR the shop's
  own name — Rivet plays supporting partner here, co-branded with the operator.
- Two-color vinyl minimum: Gunmetal + Hot Rivet on white/steel truck; or
  white + Hot Rivet on a dark wrap (`logo-dark` logic). The dome stays orange.
- Massive tap-target logic applies to the eye: bold shapes, no fine detail, no
  gradients (vinyl can't hold them anyway — the flat mark is built for this).
- Optional strip: tagline in Archivo 800 uppercase, or the phone number in big
  Plex Mono. Keep it to logo + one line.

### C. Social banner (1200 × 630, link/OG card)
- Left ⅔: Gunmetal field. Headline in Archivo 900, sentence case, `-0.02em`,
  white — e.g. *"You handle the work. We handle the business."* with "the
  business" allowed to sit on its own line. One eyebrow above in
  `accent-tint` uppercase Plex 600 `+0.08em` ("AI back office for HVAC & plumbing").
- Right ⅓: a real, cool-graded jobsite photo (tech + truck) bleeding off the
  edge, OR a large `logo-mark` watermark in `neutral-800` (subtle, tone-on-tone).
- `logo-dark.svg` lockup bottom-left, clearspace honored. One accent element
  max (a CTA chip or the eyebrow). Never crowd; let the gunmetal breathe.

---

## 9. Quick checklist before shipping any asset
- [ ] Right logo variant for the background (contrast respected)?
- [ ] Clearspace honored; mark ≥16px / lockup ≥120px?
- [ ] Accent used as a spark (a few hits), not a wash? No small orange-on-white text?
- [ ] Headlines Archivo heavy + sentence case; body Plex ≥16px; data in Plex Mono?
- [ ] Copy passes the 5-second, no-jargon, honest-not-hype test?
- [ ] Photography real and cool-graded — no stock high-fives, no fake AI glow?
- [ ] Tap targets ≥44px; no horizontal scroll at 320px?
- [ ] Would it look right on the side of a work truck — and would the driver trust it?

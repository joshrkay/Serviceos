# Rivet — Typography

Two faces, both on Google Fonts, both verified available (see "Verification").
The pairing is a **characterful industrial display + a machined workhorse body** —
deliberately not Inter-only, and deliberately not a decorative "tech" font.

- **Display — Archivo** (grotesque). Engineered, sturdy, slightly wide stance.
  Reads like fleet lettering and equipment plates: honest, load-bearing,
  American-industrial. Used heavy (700–900) for headlines and the feel of the
  wordmark. Not overused the way Oswald/Bebas/Anton are.
- **Body — IBM Plex Sans** (humanist grotesque). Designed by a hardware company
  to feel precise and honest — a perfect match for a product whose wedge is
  *"the only AI that tells you what it got wrong."* Highly legible at 16px on a
  phone in sunlight. Its companion **IBM Plex Mono** carries data (prices,
  invoice IDs, confidence scores).

> The logo wordmark ("RIVET") is **drawn as geometric paths**, not set in
> Archivo — so the SVGs carry no font dependency. Archivo is the *spiritual*
> match (same heavy grotesque character); when you need "RIVET" in live text
> (e.g. a nav that can't use the SVG), set it in Archivo Black, all-caps,
> letter-spacing `-0.01em`.

---

## Load

```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Archivo:wght@600;700;800;900&family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@500&display=swap" rel="stylesheet">
```

Use `font-display: swap`. Preload the display weight (Archivo 800) if the hero
headline is above the fold.

## Fallback stacks

```
--font-display: 'Archivo', 'Arial Narrow', 'Helvetica Neue', Arial, sans-serif;
--font-body:    'IBM Plex Sans', system-ui, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;
--font-mono:    'IBM Plex Mono', ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace;
```

The body fallback resolves to the platform UI sans instantly, so text is
readable before/if Plex loads. Archivo falls back to a narrow grotesque so
headline line-lengths stay close.

---

## Scale (rem, mobile-first · 1rem = 16px)

| Token | rem | px | Face / weight | Use |
|-------|-----|----|---------------|-----|
| `--text-display` | clamp 2.25→3.75 | 36→60 | Archivo 800/900 | Hero H1 (fluid) |
| `--text-6xl` | 3.75 | 60 | Archivo 900 | Desktop hero |
| `--text-5xl` | 3 | 48 | Archivo 800 | Section H2 (desktop) |
| `--text-4xl` | 2.25 | 36 | Archivo 800 | Section H2 (mobile) / big stat |
| `--text-3xl` | 1.875 | 30 | Archivo 700 | H3 |
| `--text-2xl` | 1.5 | 24 | Archivo 700 | H4 / card title |
| `--text-xl` | 1.25 | 20 | Plex 600 | Lead paragraph, large label |
| `--text-lg` | 1.125 | 18 | Plex 400/500 | Intro body |
| `--text-base` | 1 | 16 | Plex 400 | **Body — min size on mobile** |
| `--text-sm` | 0.875 | 14 | Plex 400/500 | Secondary, captions |
| `--text-xs` | 0.75 | 12 | Plex 500 / Plex Mono | Eyebrows, meta, legal |

## Weights

- Archivo: **700** bold, **800** extrabold (default for headlines), **900** black
  (hero + wordmark contexts). Avoid Archivo under 600 — it loses its sturdiness.
- IBM Plex Sans: **400** regular (body), **500** medium (emphasis/labels),
  **600** semibold (buttons, small headings), **700** for rare strong emphasis.
- IBM Plex Mono: **500** only, for numeric/data.

## Line-height & tracking

| Context | line-height | letter-spacing |
|---------|-------------|----------------|
| Display / hero | 1.05 (`--leading-tight`) | −0.02em (`--tracking-tight`) |
| H2–H4 | 1.1–1.2 (`--leading-snug`) | −0.01em |
| Body | 1.6 (`--leading-normal`) | 0 |
| Eyebrow / all-caps label | 1.2 | +0.08em (`--tracking-wide`), uppercase |
| Buttons | 1 | +0.01em |

---

## Usage rules

1. **Headlines are Archivo, heavy, tight.** 800 default, 900 for the hero.
   Set `letter-spacing: -0.02em` and `line-height: 1.05`. Big, sturdy, confident
   — the way a headline stamped on a nameplate looks.
2. **Body is Plex Sans 400 at 16px minimum.** Never ship body text below 16px on
   mobile. Lead paragraphs at 18–20px.
3. **Eyebrows are uppercase Plex 600, 12–14px, `+0.08em`, in `accent-strong`**
   (or `accent-tint` on dark). This is the small "section label" motif from the
   marketing site.
4. **Numbers and IDs go in Plex Mono 500** — prices, `$4,200`, invoice numbers,
   confidence scores, phone numbers. Monospaced data reads as *precise and
   auditable*, reinforcing the trust story. (Money is rendered from integer
   cents; the mono face is presentation only.)
5. **Sentence case for headlines and UI.** Not Title Case, not ALL CAPS bodies.
   The voice is a person talking, not a billboard shouting. (All-caps is reserved
   for the wordmark and eyebrows.)
6. **Measure:** body copy max ~68 characters per line for readability.
7. **Don't mix in a third family.** Display + body + mono is the whole system.

---

## Pairing example

```
Eyebrow      IBM Plex Sans 600 · 13px · +0.08em · UPPERCASE · accent-strong
Headline     Archivo 900 · clamp(36–60px) · -0.02em · line-height 1.05 · ink
Lead         IBM Plex Sans 400 · 20px · 1.6 · text-muted
Body         IBM Plex Sans 400 · 16px · 1.6 · text
Stat number  Archivo 800 · 36px · ink   (or accent for the one hero stat)
Data / price IBM Plex Mono 500 · 16px · ink
Button       IBM Plex Sans 600 · 16px · +0.01em
```

---

## Verification

Confirmed available on Google Fonts via the authoritative CSS2 API (the specimen
pages block bots, but the API only returns `@font-face` rules for families/weights
that actually exist):

- **Archivo** — `@font-face` returned for weights 400–900 (variable, incl. width
  axis). `https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600;700;800;900`
- **IBM Plex Sans** — `@font-face` returned for weights 400/500/600/700.
  `https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700`
- **IBM Plex Mono** — available (companion family). `...family=IBM+Plex+Mono:wght@500`

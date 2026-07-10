# Rivet brand — decision log

Provenance for the visual calls. Reproducible scripts kept in this folder:
`_generate.py` (assembles all logo SVGs from shared geometry) and `_contrast.py`
(computes every WCAG ratio cited in `palette.md`).

## Logo — generate → critique → iterate
Four hand-authored SVG concepts, rendered with cairosvg and judged at 16/32/64px:
- **A · Rivet dome** — clean but a bullseye; low originality, confusable with any
  round app icon. Rejected.
- **B · Riveted plate (4 corner rivets)** — best *story*, but corner rivets vanish
  at 16px → muddy "square + dot" favicon. Rejected.
- **C · Hex fastener + dome** — **winner.** Hexagon = universal hardware language;
  distinct non-circular silhouette survives 16px; most trade-credible and most
  original of the set.
- **D · Monogram R (geometric)** — cleanest letterform but R-in-squircle is
  crowded territory (Reddit/Robinhood-adjacent) and the rivet dot dies at 16px.
  Rejected as the mark; its geometric-letter approach was reused to hand-draw the
  RIVET wordmark.

Refine pass 1: flat-top hex (bolt-head/mechanical, not pointy "crypto gem") + a
countersink seat + a two-tone **forged** dome (lit upper-left) so it reads as a
real domed rivet, not a flat dot. Refine pass 2: compared three dome-highlight
treatments (half-dome / small cap / glossy specular). Chose **half-dome** — it's
the only one that keeps dimension at 16px and reads as matte forged metal, not a
glossy app icon. Dark variant: ink hex disappears on dark, so the mark flips to a
light-steel hex; the orange dome is the one constant across all variants.

Wordmark "RIVET" is drawn as heavy geometric paths (Archivo-Black spirit) → zero
font dependency inside the SVGs; verified no `<text>`/font/raster/external refs.

## Palette — evolved, not kept
Earlier draft was navy + amber. Kept the dark+warm bones but shifted both for a
more ownable, less generic-SaaS read:
- navy `#0f1729` → **Gunmetal `#16212B`** (cooler, more "steel plate," less
  corporate blue).
- amber `#f59e0b` → **Hot Rivet `#E5551B`** (the forge-orange of a rivet before
  it's driven — a story tied to the name, and further from the amber every SaaS
  ships). Neutrals rebuilt as a cool steel-tinted 50–950 ramp.
All contrast computed (not guessed); no shipped pair fails AA.

## Type — deliberately not Inter-only
Display **Archivo** (heavy industrial grotesque, fleet-lettering feel) + body
**IBM Plex Sans** (a hardware company's honest, precise workhorse — on-voice for
"tells you what it got wrong") + **IBM Plex Mono** for prices/IDs/confidence.
All verified live on Google Fonts via the CSS2 API.

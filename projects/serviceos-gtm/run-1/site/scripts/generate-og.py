#!/usr/bin/env python3
"""Generate public/og.png (1200x630) from brand assets.

Composition follows brand/guidelines.md section 8C (social banner): solid
Gunmetal field, the dark logo lockup, the locked tagline as the headline in a
heavy sans, an eyebrow in accent-tint, and a single Hot Rivet seam. The logo
wordmark is geometric (no font dependency); the tagline uses DejaVu Sans Bold
as an Archivo stand-in for this raster asset. Re-run: python3 scripts/generate-og.py
"""
import base64
import os
import cairosvg

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOGO = os.path.join(ROOT, "public", "brand", "logo-dark.svg")
OUT = os.path.join(ROOT, "public", "og.png")

GUNMETAL = "#16212B"
GUNMETAL_800 = "#1E2C39"
WHITE = "#FFFFFF"
ACCENT = "#E5551B"
ACCENT_TINT = "#F6A87F"
STEEL = "#8A99A8"

# Rasterize the dark logo lockup to a PNG we embed (keeps the geometric wordmark
# crisp and avoids any font dependency for the brand mark).
LOGO_W = 300
logo_png = cairosvg.svg2png(url=LOGO, output_width=LOGO_W, output_height=round(LOGO_W * 100 / 362))
logo_b64 = base64.b64encode(logo_png).decode("ascii")
logo_h = round(LOGO_W * 100 / 362)

FONT = "DejaVu Sans"

svg = f"""<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="1200" height="630" viewBox="0 0 1200 630">
  <rect width="1200" height="630" fill="{GUNMETAL}"/>
  <!-- subtle tone-on-tone hexagon motif, bottom-right (quiet texture, not decoration) -->
  <path d="M980,120 L1120,120 L1190,241 L1120,362 L980,362 L910,241 Z" fill="{GUNMETAL_800}" opacity="0.6"/>

  <!-- logo lockup, top-left, clearspace honored -->
  <image x="80" y="70" width="{LOGO_W}" height="{logo_h}"
    xlink:href="data:image/png;base64,{logo_b64}"
    href="data:image/png;base64,{logo_b64}"/>

  <!-- eyebrow -->
  <text x="82" y="248" font-family="{FONT}" font-weight="bold" font-size="24"
    letter-spacing="3" fill="{ACCENT_TINT}">AI BACK OFFICE FOR HVAC &amp; PLUMBING</text>

  <!-- headline (locked tagline), two lines -->
  <text x="80" y="345" font-family="{FONT}" font-weight="bold" font-size="70"
    fill="{WHITE}">You handle the work.</text>
  <text x="80" y="430" font-family="{FONT}" font-weight="bold" font-size="70"
    fill="{WHITE}">We handle the business.</text>

  <!-- Hot Rivet seam: three dots as a divider -->
  <circle cx="92" cy="500" r="7" fill="{ACCENT}"/>
  <circle cx="120" cy="500" r="7" fill="{ACCENT}"/>
  <circle cx="148" cy="500" r="7" fill="{ACCENT}"/>

  <!-- support line -->
  <text x="176" y="507" font-family="{FONT}" font-size="26" fill="{STEEL}">Answers the phone. Books the job. Sends the invoice. You approve.</text>
</svg>"""

cairosvg.svg2png(bytestring=svg.encode("utf-8"), write_to=OUT, output_width=1200, output_height=630)
print(f"wrote {OUT} ({os.path.getsize(OUT)} bytes)")

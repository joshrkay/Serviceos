#!/usr/bin/env python3
"""Assemble all final Rivet logo SVGs from shared geometry. No divergence."""

# ---- shared palette ----
INK   = "#16212B"
SEAT  = "#0E151C"
RIVET = "#E5551B"
HL    = "#F6A87F"
N50   = "#F5F7FA"
ST100 = "#E9EDF2"
ST300 = "#B2BDC9"

# ---- hex mark art, 64x64 coordinate space ----
HEX = "M19,5 L45,5 L58,32 L45,59 L19,59 L6,32 Z"          # flat-top hex, near full-bleed
# forged dome: base circle + upper-left lit half-disc (terminator on NE-SW diagonal)
def mark(hex_fill, seat_fill, dome_fill, hl_fill):
    return f'''  <path d="{HEX}" fill="{hex_fill}"/>
  <circle cx="32" cy="32" r="15.5" fill="{seat_fill}"/>
  <circle cx="32" cy="32" r="13.5" fill="{dome_fill}"/>
  <path d="M41.6,22.4 A13.5,13.5 0 0 0 22.4,41.6 Z" fill="{hl_fill}"/>'''

MARK_LIGHT = mark(INK, SEAT, RIVET, HL)          # for light backgrounds
MARK_DARK  = mark(ST100, ST300, RIVET, HL)        # for dark backgrounds

# ---- geometric RIVET wordmark, cap-height 100 glyph space, total 384 wide ----
GLYPHS = '''    <g transform="translate(0,0)"><path fill-rule="evenodd" d="M0,0 L44,0 C60,0 70,10 70,27 C70,44 60,54 44,54 L72,100 L46,100 L20,64 L20,100 L0,100 Z M20,20 L43,20 C52,20 58,23 58,27 C58,31 52,34 43,34 L20,34 Z"/></g>
    <g transform="translate(88,0)"><path d="M0,0 H20 V100 H0 Z"/></g>
    <g transform="translate(124,0)"><path d="M0,0 L20,0 L42,66 L64,0 L84,0 L52,100 L32,100 Z"/></g>
    <g transform="translate(224,0)"><path d="M0,0 H66 V20 H20 V40 H58 V58 H20 V80 H66 V100 H0 Z"/></g>
    <g transform="translate(306,0)"><path d="M0,0 H78 V20 H49 V100 H29 V20 H0 Z"/></g>'''
WORDMARK_W = 384

def wordmark(fill, tx, ty, scale):
    return f'  <g transform="translate({tx},{ty}) scale({scale})" fill="{fill}">\n{GLYPHS}\n  </g>'

def svg(vb_w, vb_h, body, title):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {vb_w} {vb_h}" '
            f'role="img" aria-label="{title}">\n{body}\n</svg>\n')

files = {}

# 1. logo-mark.svg (light), square 64
files['logo-mark.svg'] = svg(64, 64, MARK_LIGHT, "Rivet")
# 2. logo-mark-dark.svg
files['logo-mark-dark.svg'] = svg(64, 64, MARK_DARK, "Rivet")
# 3. favicon.svg  (identical geometry, square, minimal — same as mark for consistency)
files['favicon.svg'] = svg(64, 64, MARK_LIGHT, "Rivet")

# 4. logo.svg full lockup (light).  Mark scaled 64->88 (x1.375) at left; wordmark cap 64.
#    mark occupies x4..92, y6..94 (center y=50). wordmark cap-height 64 centered y18..82.
mark_g_light = f'  <g transform="translate(4,6) scale(1.375)">\n{MARK_LIGHT}\n  </g>'
wm_scale = 0.64
wm_tx = 108
wm_w = WORDMARK_W * wm_scale         # 245.76
total_w = wm_tx + wm_w + 8           # right pad
files['logo.svg'] = svg(round(total_w), 100,
    mark_g_light + "\n" + wordmark(INK, wm_tx, 18, wm_scale),
    "Rivet")

# 5. logo-dark.svg full lockup (dark bg): light mark + light wordmark
mark_g_dark = f'  <g transform="translate(4,6) scale(1.375)">\n{MARK_DARK}\n  </g>'
files['logo-dark.svg'] = svg(round(total_w), 100,
    mark_g_dark + "\n" + wordmark(N50, wm_tx, 18, wm_scale),
    "Rivet")

import os
for name, content in files.items():
    with open(name, 'w') as f:
        f.write(content)
    print('wrote', name)

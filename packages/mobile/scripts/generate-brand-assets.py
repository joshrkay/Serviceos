#!/usr/bin/env python3
"""Regenerate the Rivet store assets from the brand mark.

The mark is the one the marketing site renders from code
(rivet-marketing/src/app/icon.tsx): an ExtraBold "R" with an orange period on
the dark brand background. Rendering it here, rather than keeping a binary
nobody can regenerate, keeps the app icon in sync with that definition.

Usage (from packages/mobile):
    npm pack @expo-google-fonts/archivo --pack-destination /tmp && tar -xzf /tmp/expo-google-fonts-archivo-*.tgz -C /tmp
    python3 scripts/generate-brand-assets.py /tmp/package/800ExtraBold/Archivo_800ExtraBold.ttf assets

Outputs (all referenced from app.json):
    icon.png               1024x1024 opaque  — App Store / Play icon
    adaptive-icon.png      1024x1024 alpha   — Android adaptive foreground (mark inside the 66% safe zone)
    splash.png             1024x1024 alpha   — expo-splash-screen image (drawn at imageWidth on the brand background)
    notification-icon.png  96x96 alpha       — Android notification silhouette (white; the OS tints it)
"""
import sys

from PIL import Image, ImageDraw, ImageFont

FONT = sys.argv[1]; OUT = sys.argv[2]
BG = (0x14, 0x18, 0x1D, 255); WHITE = (255, 255, 255, 255); ORANGE = (0xF5, 0x81, 0x1E, 255)

def mark(size, scale, bg, r_color=WHITE, dot_color=ORANGE):
    """Render the marketing-site mark: an ExtraBold 'R' with an orange period,
    baseline-aligned and optically centred, at `scale` of the canvas."""
    im = Image.new('RGBA', (size, size), bg)
    d = ImageDraw.Draw(im)
    f = ImageFont.truetype(FONT, int(size * scale))
    tracking = -0.03 * f.size
    rb = d.textbbox((0, 0), 'R', font=f); db = d.textbbox((0, 0), '.', font=f)
    rw = rb[2] - rb[0]; dw = db[2] - db[0]
    total = rw + tracking + dw
    x = (size - total) / 2 - rb[0]
    # vertical: centre the cap height of the R
    cap_h = rb[3] - rb[1]
    y = (size - cap_h) / 2 - rb[1]
    d.text((x, y), 'R', font=f, fill=r_color)
    d.text((x + rw + tracking + (rb[0] - db[0]), y), '.', font=f, fill=dot_color)
    return im

# App Store icon: opaque, no alpha (Apple rejects transparency), mark at ~70%.
mark(1024, 0.70, BG).convert('RGB').save(f'{OUT}/icon.png')
# Android adaptive foreground: transparent canvas, mark inside the 66% safe zone.
mark(1024, 0.46, (0, 0, 0, 0)).save(f'{OUT}/adaptive-icon.png')
# Splash: expo-splash-screen renders this at imageWidth on the dark background.
mark(1024, 0.70, (0, 0, 0, 0)).save(f'{OUT}/splash.png')
# Notification icon: white silhouette on transparent (Android tints it).
mark(96, 0.78, (0, 0, 0, 0), WHITE, WHITE).save(f'{OUT}/notification-icon.png')
print('ok')

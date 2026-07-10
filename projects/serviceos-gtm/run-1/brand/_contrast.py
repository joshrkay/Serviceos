#!/usr/bin/env python3
"""Compute WCAG 2.1 contrast ratios for the Rivet palette. No guessing."""

def lin(c):
    c = c / 255.0
    return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4

def L(hexstr):
    h = hexstr.lstrip('#')
    r, g, b = (int(h[i:i+2], 16) for i in (0, 2, 4))
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)

def ratio(fg, bg):
    l1, l2 = L(fg), L(bg)
    hi, lo = max(l1, l2), min(l1, l2)
    return (hi + 0.05) / (lo + 0.05)

def grade(r, large=False):
    if large:
        return "AAA" if r >= 4.5 else ("AA" if r >= 3.0 else "FAIL")
    return "AAA" if r >= 7.0 else ("AA" if r >= 4.5 else ("AA-large" if r >= 3.0 else "FAIL"))

# ---- Palette ----
C = {
    # brand
    'ink':        '#16212B',  # primary gunmetal
    'ink-hover':  '#0F1922',
    'rivet':      '#E5551B',  # hot-rivet accent (bright)
    'rivet-600':  '#C4470F',  # accent, text-safe on white
    'rivet-300':  '#F6A87F',  # accent tint for dark bg
    'steel':      '#5A6B7D',  # secondary cool steel
    # neutral ramp (cool steel-tinted)
    'n-50':  '#F5F7FA',
    'n-100': '#E9EDF2',
    'n-200': '#D4DBE3',
    'n-300': '#B2BDC9',
    'n-400': '#8493A3',
    'n-500': '#647383',
    'n-600': '#4C5A69',
    'n-700': '#3A4553',
    'n-800': '#27313D',
    'n-900': '#18212B',
    'n-950': '#0E151C',
    'white': '#FFFFFF',
    # semantic
    'success':  '#1E7A46',
    'success-tint': '#3BAE6B',
    'warn':     '#B26A00',
    'warn-tint':'#E0922B',
    'error':    '#C22E22',
    'error-tint':'#F0645A',
}

pairs = [
    # (fg, bg, label, large?)
    ('white', 'ink',        'White text on Primary (ink) button', False),
    ('n-100', 'ink',        'Light text on ink surface', False),
    ('n-300', 'ink',        'Muted text on ink surface', False),
    ('n-400', 'ink',        'Dim/caption on ink', False),
    ('ink', 'white',        'Ink body text on white', False),
    ('n-700', 'white',      'Secondary text on white', False),
    ('n-500', 'white',      'Muted text on white', False),
    ('ink', 'n-50',         'Ink text on n-50 surface', False),
    ('n-700', 'n-50',       'Secondary text on n-50', False),
    ('rivet', 'white',      'Bright rivet as TEXT on white', False),
    ('rivet-600', 'white',  'Rivet-600 as text/link on white', False),
    ('ink', 'rivet',        'Ink text on rivet button', False),
    ('white', 'rivet',      'White text on rivet button', False),
    ('white', 'rivet-600',  'White text on rivet-600 button', False),
    ('rivet', 'ink',        'Rivet accent on ink (dark UI)', False),
    ('rivet-300', 'ink',    'Rivet-300 tint on ink', False),
    ('white', 'success',    'White on success', False),
    ('white', 'warn',       'White on warn', False),
    ('ink', 'warn-tint',    'Ink on warn-tint', False),
    ('white', 'error',      'White on error', False),
    ('success-tint', 'ink', 'Success tint on ink (dark UI)', False),
    ('error-tint', 'ink',   'Error tint on ink (dark UI)', False),
    ('rivet', 'n-950',      'Rivet on near-black', False),
    # large display headline uses
    ('ink', 'white',        'Ink display headline on white (large)', True),
]

print(f"{'RATIO':>7}  {'GRADE':<9} PAIR")
print("-" * 70)
worst = []
for fg, bg, label, large in pairs:
    r = ratio(C[fg], C[bg])
    g = grade(r, large)
    if g == 'FAIL':
        worst.append(label)
    print(f"{r:6.2f}:1  {g:<9} {label}  [{C[fg]} on {C[bg]}]")

print("-" * 70)
print("FAILURES:", worst if worst else "none")

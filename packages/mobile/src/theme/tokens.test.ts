import { describe, it, expect } from 'vitest';
import { colors, light, dark, radii, tapTarget, cssVars, colorVars } from './tokens';

// React Native cannot parse the CSS oklch() function, so every token must be a
// hex or rgba string. This contract test guards against an oklch() literal (or
// any other unparseable value) slipping into the palette.
const HEX_OR_RGBA = /^(#([0-9a-f]{3}|[0-9a-f]{6})|rgba?\([^)]*\))$/i;

describe('mobile design tokens', () => {
  it('exposes light and dark palettes with an identical set of token keys', () => {
    expect(Object.keys(light).sort()).toEqual(Object.keys(dark).sort());
    expect(colors.light).toBe(light);
    expect(colors.dark).toBe(dark);
  });

  it('uses only RN-parseable hex/rgba colors (no oklch())', () => {
    for (const palette of [light, dark]) {
      for (const [key, value] of Object.entries(palette)) {
        expect(value, `${key}=${value}`).toMatch(HEX_OR_RGBA);
      }
    }
  });

  it('carries the web --radius scale (0.625rem = 10px) as numbers', () => {
    expect(radii).toEqual({ sm: 6, md: 8, lg: 10, xl: 14 });
  });

  it('pins the >=44px tap-target minimum (CLAUDE.md mobile rule)', () => {
    expect(tapTarget).toBe(44);
  });

  it('keeps the brand primary in sync with the web theme (#030213)', () => {
    expect(light.primary).toBe('#030213');
  });

  it('differs between light and dark for the core surfaces (dark mode is real)', () => {
    // Guards the bug where the Tailwind config froze to the light palette: if
    // these matched, `dark:` / scheme-aware classes would render identically.
    expect(dark.background).not.toBe(light.background);
    expect(dark.foreground).not.toBe(light.foreground);
    expect(dark.primary).not.toBe(light.primary);
  });

  it('colorVars maps every token to its CSS variable reference', () => {
    const vars = colorVars(light);
    expect(Object.keys(vars).sort()).toEqual(Object.keys(light).sort());
    expect(vars.background).toBe('var(--background)');
    expect(vars.primaryForeground).toBe('var(--primaryForeground)');
  });

  it('cssVars emits --token declarations carrying the palette values', () => {
    expect(cssVars(light)['--background']).toBe(light.background);
    expect(cssVars(dark)['--background']).toBe(dark.background);
    expect(cssVars(dark)['--foreground']).toBe(dark.foreground);
    // Light and dark produce the same variable names (so they swap cleanly).
    expect(Object.keys(cssVars(light)).sort()).toEqual(Object.keys(cssVars(dark)).sort());
  });
});

// Design tokens for the ServiceOS mobile app.
//
// Single source of truth, mirrored from the web theme
// (packages/web/src/index.css: the OKLch palette + `--radius`). Authored as a
// CommonJS module so it can be `require`d by tailwind.config.js (Node) and
// imported by the TypeScript app + tests (via tokens.d.ts).
//
// The web theme expresses several colors with the CSS `oklch()` function.
// React Native style values cannot parse `oklch()`, so those are converted to
// the nearest hex here (the source OKLch is noted in a comment); hex/rgba
// values are carried through verbatim. Keep in sync with the web theme.

// Path A brand (design handoff). Warm canvas + brand blue + ink. Light values
// are the prototype's; dark values are derived (the prototype is light-only) to
// keep dark mode real and contrast-safe — refine when a dark comp lands.
/** @type {Record<string, string>} */
const light = {
  background: '#f6f4ef', // warm page canvas
  foreground: '#16202e', // ink
  card: '#ffffff',
  cardForeground: '#16202e',
  popover: '#ffffff',
  popoverForeground: '#16202e',
  primary: '#1f5fd6', // brand blue
  primaryForeground: '#ffffff',
  secondary: '#ece8e0', // warm neutral fill (chips, inactive)
  secondaryForeground: '#28323f',
  muted: '#efece5',
  mutedForeground: '#5b6675', // secondary text
  accent: '#e7eefb', // light brand-blue tint
  accentForeground: '#1a4fb5',
  destructive: '#c23b3b',
  destructiveForeground: '#ffffff',
  border: '#e2ded4', // warm hairline
  input: '#f0eee7', // input background
  ring: '#1f5fd6', // focus ring = brand
  chart1: '#e0703a', // oklch(0.646 0.222 41.116)
  chart2: '#2a9d8f', // oklch(0.6 0.118 184.704)
  chart3: '#3a5a78', // oklch(0.398 0.07 227.392)
  chart4: '#e2c044', // oklch(0.828 0.189 84.429)
  chart5: '#e8a838', // oklch(0.769 0.188 70.08)
  success: '#1f8a5b',
  warning: '#b5642e',
};

/** @type {Record<string, string>} */
const dark = {
  background: '#16202e', // ink becomes the dark canvas
  foreground: '#f4f6f9',
  card: '#1c2836',
  cardForeground: '#f4f6f9',
  popover: '#1c2836',
  popoverForeground: '#f4f6f9',
  primary: '#5b8def', // lighter blue for contrast on dark
  primaryForeground: '#ffffff',
  secondary: '#243244',
  secondaryForeground: '#f4f6f9',
  muted: '#243244',
  mutedForeground: '#9aa6b4',
  accent: '#1e3a5f',
  accentForeground: '#cfe0ff',
  destructive: '#d14343',
  destructiveForeground: '#ffffff',
  border: '#2c3a4c',
  input: '#243244',
  ring: '#5b8def',
  chart1: '#5a6fe0',
  chart2: '#3fcaa0',
  chart3: '#e8a838',
  chart4: '#a065e8',
  chart5: '#e85f7a',
  success: '#2fa56f',
  warning: '#d08a4a',
};

// --radius: 0.625rem = 10px (lg). sm/md/xl mirror the web `@theme inline`
// calc(): -4 / -2 / +4 around the base.
const radii = { sm: 6, md: 8, lg: 10, xl: 14 };

// CLAUDE.md hard rule: >=44px tap targets on mobile/public UI.
const tapTarget = 44;

const colors = { light, dark };

// Dark-mode wiring (mirrors how the web theme uses CSS variables). Rather than
// baking one palette into the Tailwind config — which made `dark:` classes
// resolve to light values — the config points each color at a CSS variable and
// emits both palettes (`:root` = light, `.dark` = dark). NativeWind swaps the
// active scope, so `bg-background`/`text-foreground` become theme-aware with no
// per-class `dark:` prefixes, and tokens.js stays the single source.

/** CSS custom-property declarations for a palette: { '--background': '#fff', … }. */
function cssVars(palette) {
  const out = {};
  for (const [key, value] of Object.entries(palette)) out[`--${key}`] = value;
  return out;
}

/** Tailwind color map pointing at the CSS variables: { background: 'var(--background)', … }. */
function colorVars(palette) {
  const out = {};
  for (const key of Object.keys(palette)) out[key] = `var(--${key})`;
  return out;
}

module.exports = { colors, light, dark, radii, tapTarget, cssVars, colorVars };

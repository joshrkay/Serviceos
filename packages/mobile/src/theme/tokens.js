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

/** @type {Record<string, string>} */
const light = {
  background: '#ffffff',
  foreground: '#252525', // oklch(0.145 0 0)
  card: '#ffffff',
  cardForeground: '#252525', // oklch(0.145 0 0)
  popover: '#ffffff', // oklch(1 0 0)
  popoverForeground: '#252525', // oklch(0.145 0 0)
  primary: '#030213',
  primaryForeground: '#ffffff', // oklch(1 0 0)
  secondary: '#f1f1f4', // oklch(0.95 0.0058 264.53)
  secondaryForeground: '#030213',
  muted: '#ececf0',
  mutedForeground: '#717182',
  accent: '#e9ebef',
  accentForeground: '#030213',
  destructive: '#d4183d',
  destructiveForeground: '#ffffff',
  border: 'rgba(0, 0, 0, 0.1)',
  input: '#f3f3f5', // --input-background
  ring: '#b5b5b5', // oklch(0.708 0 0)
  chart1: '#e0703a', // oklch(0.646 0.222 41.116)
  chart2: '#2a9d8f', // oklch(0.6 0.118 184.704)
  chart3: '#3a5a78', // oklch(0.398 0.07 227.392)
  chart4: '#e2c044', // oklch(0.828 0.189 84.429)
  chart5: '#e8a838', // oklch(0.769 0.188 70.08)
  success: '#16a34a',
  warning: '#d97706',
};

/** @type {Record<string, string>} */
const dark = {
  background: '#252525', // oklch(0.145 0 0)
  foreground: '#fafafa', // oklch(0.985 0 0)
  card: '#252525',
  cardForeground: '#fafafa',
  popover: '#252525',
  popoverForeground: '#fafafa',
  primary: '#fafafa', // oklch(0.985 0 0)
  primaryForeground: '#333333', // oklch(0.205 0 0)
  secondary: '#404040', // oklch(0.269 0 0)
  secondaryForeground: '#fafafa',
  muted: '#404040',
  mutedForeground: '#b5b5b5', // oklch(0.708 0 0)
  accent: '#404040',
  accentForeground: '#fafafa',
  destructive: '#7a2d2a', // oklch(0.396 0.141 25.723)
  destructiveForeground: '#e06a5f', // oklch(0.637 0.237 25.331)
  border: '#404040',
  input: '#404040',
  ring: '#6f6f6f', // oklch(0.439 0 0)
  chart1: '#5a6fe0',
  chart2: '#3fcaa0',
  chart3: '#e8a838',
  chart4: '#a065e8',
  chart5: '#e85f7a',
  success: '#22c55e',
  warning: '#f59e0b',
};

// --radius: 0.625rem = 10px (lg). sm/md/xl mirror the web `@theme inline`
// calc(): -4 / -2 / +4 around the base.
const radii = { sm: 6, md: 8, lg: 10, xl: 14 };

// CLAUDE.md hard rule: >=44px tap targets on mobile/public UI.
const tapTarget = 44;

const colors = { light, dark };

module.exports = { colors, light, dark, radii, tapTarget };

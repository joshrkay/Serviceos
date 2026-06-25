// Design tokens for the ServiceOS mobile app.
//
// Path A brand palette from the mobile design handoff (prototype → semantic tokens).
// Mirrored to packages/web/src/index.css. Authored as CommonJS so tailwind.config.js
// can require it; TypeScript imports via tokens.d.ts.

/** @type {Record<string, string>} */
const light = {
  background: '#F6F4EF',
  foreground: '#16202E',
  card: '#FFFFFF',
  cardForeground: '#16202E',
  popover: '#FFFFFF',
  popoverForeground: '#16202E',
  primary: '#1F5FD6',
  primaryForeground: '#FFFFFF',
  secondary: '#F4F1EA',
  secondaryForeground: '#28323F',
  muted: '#ECE8E0',
  mutedForeground: '#5B6675',
  accent: '#8FB2FF',
  accentForeground: '#16202E',
  destructive: '#C23B3B',
  destructiveForeground: '#FFFFFF',
  border: '#ECE8E0',
  input: '#F4F1EA',
  ring: '#1F5FD6',
  chart1: '#1F5FD6',
  chart2: '#1F8A5B',
  chart3: '#28323F',
  chart4: '#8FB2FF',
  chart5: '#5B6675',
  success: '#1F8A5B',
  warning: '#d97706',
};

/** @type {Record<string, string>} */
const dark = {
  background: '#16202E',
  foreground: '#F6F4EF',
  card: '#28323F',
  cardForeground: '#F6F4EF',
  popover: '#28323F',
  popoverForeground: '#F6F4EF',
  primary: '#8FB2FF',
  primaryForeground: '#16202E',
  secondary: '#28323F',
  secondaryForeground: '#F6F4EF',
  muted: '#28323F',
  mutedForeground: '#8A93A0',
  accent: '#1F5FD6',
  accentForeground: '#FFFFFF',
  destructive: '#D14343',
  destructiveForeground: '#FFFFFF',
  border: '#3D4A5C',
  input: '#28323F',
  ring: '#8FB2FF',
  chart1: '#8FB2FF',
  chart2: '#1F8A5B',
  chart3: '#5B6675',
  chart4: '#1F5FD6',
  chart5: '#8A93A0',
  success: '#1F8A5B',
  warning: '#f59e0b',
};

// Prototype card radius 18px; inputs 10–12px.
const radii = { sm: 10, md: 12, lg: 18, xl: 22 };

// CLAUDE.md hard rule: >=44px tap targets on mobile/public UI.
const tapTarget = 44;

const colors = { light, dark };

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

// NativeWind v4 Tailwind config. The palette + radii + tap-target come from the
// single token source (src/theme/tokens.js), which mirrors the web theme
// (packages/web/src/index.css). Keep colors in tokens.js, not here.
const { colors, radii, tapTarget } = require('./src/theme/tokens');

/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./app/**/*.{ts,tsx}', './src/**/*.{ts,tsx}'],
  presets: [require('nativewind/preset')],
  darkMode: 'class',
  theme: {
    extend: {
      colors: colors.light,
      borderRadius: {
        sm: radii.sm,
        md: radii.md,
        lg: radii.lg,
        xl: radii.xl,
      },
      // CLAUDE.md hard rule: >=44px tap targets on mobile UI.
      minHeight: { 11: tapTarget },
      minWidth: { 11: tapTarget },
      spacing: { 11: tapTarget },
    },
  },
  plugins: [],
};

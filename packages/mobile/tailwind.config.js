// NativeWind v4 Tailwind config. The palette + radii + tap-target come from the
// single token source (src/theme/tokens.js), which mirrors the web theme
// (packages/web/src/index.css). Keep colors in tokens.js, not here.
const plugin = require('tailwindcss/plugin');
const { colors, radii, tapTarget, cssVars, colorVars } = require('./src/theme/tokens');

/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./app/**/*.{ts,tsx}', './src/**/*.{ts,tsx}'],
  presets: [require('nativewind/preset')],
  darkMode: 'class',
  theme: {
    extend: {
      // Colors point at CSS variables; the plugin below emits the light/dark
      // values, so `bg-background` etc. follow the active color scheme instead
      // of being frozen to the light palette.
      colors: colorVars(colors.light),
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
      fontFamily: {
        heading: ['BricolageGrotesque_600SemiBold', 'System'],
        sans: ['HankenGrotesk_400Regular', 'System'],
        medium: ['HankenGrotesk_500Medium', 'System'],
        semibold: ['HankenGrotesk_600SemiBold', 'System'],
      },
    },
  },
  plugins: [
    plugin(({ addBase }) => {
      addBase({
        ':root': cssVars(colors.light),
        '.dark': cssVars(colors.dark),
      });
    }),
  ],
};

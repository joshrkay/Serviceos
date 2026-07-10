import type { Config } from 'tailwindcss';

/**
 * Tailwind is wired to the CSS custom properties in src/app/tokens.css (the
 * Rivet brand tokens). This config only references var() names, never literal
 * colors, so the token file stays the single source of truth.
 *
 * Legacy keys (primary-fg, fg, fg-muted, surface-muted, warning, danger) are
 * kept and mapped onto the brand tokens so sibling pages built against the
 * original scaffold keep working. New keys expose the full brand palette.
 */
const config: Config = {
  content: ['./src/**/*.{ts,tsx,mdx}'],
  theme: {
    extend: {
      colors: {
        // --- brand core ---
        primary: 'var(--color-primary)',
        'primary-hover': 'var(--color-primary-hover)',
        'primary-fg': 'var(--color-primary-contrast)',
        secondary: 'var(--color-secondary)',
        accent: 'var(--color-accent)',
        'accent-strong': 'var(--color-accent-strong)',
        'accent-tint': 'var(--color-accent-tint)',
        'accent-contrast': 'var(--color-accent-contrast)',
        link: 'var(--color-link)',

        // --- surfaces & lines ---
        bg: 'var(--color-bg)',
        surface: 'var(--color-surface)',
        'surface-sunk': 'var(--color-surface-sunk)',
        'surface-muted': 'var(--color-surface-sunk)', // legacy alias
        border: 'var(--color-border)',
        'border-strong': 'var(--color-border-strong)',

        // --- text ---
        fg: 'var(--color-text)',
        'fg-muted': 'var(--color-text-muted)',
        'fg-subtle': 'var(--color-text-subtle)',

        // --- steel neutral ramp ---
        neutral: {
          50: 'var(--color-neutral-50)',
          100: 'var(--color-neutral-100)',
          200: 'var(--color-neutral-200)',
          300: 'var(--color-neutral-300)',
          400: 'var(--color-neutral-400)',
          500: 'var(--color-neutral-500)',
          600: 'var(--color-neutral-600)',
          700: 'var(--color-neutral-700)',
          800: 'var(--color-neutral-800)',
          900: 'var(--color-neutral-900)',
          950: 'var(--color-neutral-950)',
        },

        // --- semantic ---
        success: 'var(--color-success)',
        'success-tint': 'var(--color-success-tint)',
        warn: 'var(--color-warn)',
        'warn-tint': 'var(--color-warn-tint)',
        error: 'var(--color-error)',
        'error-tint': 'var(--color-error-tint)',
        warning: 'var(--color-warn)', // legacy alias
        danger: 'var(--color-error)', // legacy alias
      },
      fontFamily: {
        sans: 'var(--font-body)',
        body: 'var(--font-body)',
        display: 'var(--font-display)',
        mono: 'var(--font-mono)',
      },
      borderRadius: {
        DEFAULT: 'var(--radius)',
        sm: 'var(--radius-sm)',
        md: 'var(--radius-md)',
        lg: 'var(--radius-lg)',
        xl: 'var(--radius-xl)',
      },
      boxShadow: {
        sm: 'var(--shadow-sm)',
        md: 'var(--shadow-md)',
        lg: 'var(--shadow-lg)',
        focus: 'var(--shadow-focus)',
      },
      maxWidth: {
        content: 'var(--max-width-content)',
      },
    },
  },
  plugins: [],
};

export default config;

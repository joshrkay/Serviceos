import { expect } from 'vitest';

/**
 * Assert a rendered surface carries no raw Tailwind palette classes
 * (`bg-slate-900`, `text-blue-600`, `fill-amber-400`, …) — everything must
 * go through the design tokens. Shared by the portal/customer cluster's
 * class-contract tests so the guard regex (incl. the `fill`/`stroke` SVG
 * prefixes) lives in one place.
 *
 * Brand colour is fine here — the portal is ServiceOS-branded, so this guard
 * deliberately does NOT forbid `bg-primary`/`ring-ring`. It's a regression
 * tripwire for un-tokenized leaks in the states a test mounts; the per-cluster
 * source grep remains the authoritative coverage check.
 */
const RAW_PALETTE =
  /(bg|text|border|border-l|border-r|border-t|border-b|placeholder|ring|divide|shadow|fill|stroke|from|via|to)-(slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}/;

export function expectNoRawPalette(html: string): void {
  expect(html).not.toMatch(RAW_PALETTE);
}

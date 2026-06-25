import { expect } from 'vitest';

/**
 * Assert a rendered portal/customer surface carries no raw Tailwind palette
 * and no ServiceOS brand blue (`--primary`/`--ring`/brand-tinted `accent`).
 *
 * Shared by the U13 cluster's per-page class-contract tests so the guard regex
 * lives in ONE place — including the `fill`/`stroke` SVG prefixes (icons that
 * colour via fill would slip past a bg/text/border-only regex) and the
 * brand-blue tokens the kit emits statically in the `class` attribute
 * (`ring-ring`, `border-primary`), which is what makes a missed neutral
 * override catchable here.
 *
 * This is a regression tripwire for the states a test actually mounts; the
 * per-cluster source grep remains the authoritative coverage check (a jsdom
 * guard never sees the states it doesn't render).
 */
const RAW_PALETTE =
  /(bg|text|border|border-l|border-r|border-t|border-b|placeholder|ring|divide|shadow|fill|stroke|from|via|to)-(slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}/;

export function expectTenantNeutral(html: string): void {
  expect(html).not.toMatch(RAW_PALETTE);
  expect(html).not.toMatch(/\b(bg|text|border|ring)-primary\b/);
  expect(html).not.toMatch(/\bring-ring\b/);
  expect(html).not.toMatch(/\b(bg|text|border)-accent\b|accent-foreground/);
}

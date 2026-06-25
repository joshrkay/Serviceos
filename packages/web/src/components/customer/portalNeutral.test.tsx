import { describe, it, expect } from 'vitest';
import { NEUTRAL_FIELD, NEUTRAL_CTA, NEUTRAL_BTN } from './portalNeutral';

/**
 * The portal cluster must stay tenant-neutral: no ServiceOS brand blue
 * (`--primary`/`--ring`) and no brand-tinted `accent`. These constants are the
 * single source of truth for the kit overrides, so lock their tenant-neutrality
 * here — if someone re-introduces `primary`/`ring-ring`/`accent` into an
 * override, the whole cluster regresses at once and this fails first.
 */
describe('portalNeutral constants', () => {
  const all = [NEUTRAL_FIELD, NEUTRAL_CTA, NEUTRAL_BTN];

  it('never reference the ServiceOS brand blue or accent tokens', () => {
    for (const cls of all) {
      expect(cls).not.toMatch(/\b(bg|text|border|ring)-primary\b/);
      expect(cls).not.toMatch(/\bring-ring\b/);
      expect(cls).not.toMatch(/\b(bg|text|border)-accent\b|accent-foreground/);
    }
  });

  it('never reference the raw Tailwind palette', () => {
    for (const cls of all) {
      expect(cls).not.toMatch(
        /\b(bg|text|border|ring)-(slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}/,
      );
    }
  });

  it('keep the 44px tap target on fields and a neutral focus ring on CTAs', () => {
    expect(NEUTRAL_FIELD).toContain('min-h-11');
    expect(NEUTRAL_FIELD).toContain('focus:border-foreground');
    expect(NEUTRAL_CTA).toContain('bg-foreground');
    expect(NEUTRAL_CTA).toContain('focus-visible:ring-foreground/40');
  });
});

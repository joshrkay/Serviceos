/**
 * Tenant-neutral overrides for the customer/portal cluster (U13).
 *
 * These pages represent the TENANT's business, not ServiceOS — there is no
 * tenant-color mechanism (PortalCustomer carries only companyName), so per
 * OQ1 they get Path A shape + typography but NOT Path A blue. The shared kit
 * (Input/Textarea/Select/Button) defaults to `--primary`/`--ring` (the
 * ServiceOS brand blue) on focus and fill; applying it verbatim would make a
 * tenant's quote read as a ServiceOS quote. These constants strip the brand
 * blue down to neutral ink/secondary.
 *
 * `cn` is `twMerge(clsx(...))`, so passing one of these via `className` after
 * the kit's own classes reliably wins the border-color / ring-color conflict.
 * Keep every portal field/CTA pointing at these constants so there's a single
 * place to audit and the class-contract guard has one thing to enforce.
 */

/**
 * Kit `Input`/`Textarea`/`Select` on portal pages. Overrides the kit's
 * `focus:border-primary` + `focus-visible:ring-ring/30` to neutral ink, and
 * guarantees the 44px tap target.
 */
export const NEUTRAL_FIELD =
  'min-h-11 focus:border-foreground focus-visible:ring-foreground/20';

/**
 * Primary portal CTA (Accept / Pay / Submit / Continue). Ink fill + neutral
 * focus ring instead of `bg-primary`/`ring-ring`. Pair with kit `<Button>`
 * (any variant — `className` wins the conflict).
 */
export const NEUTRAL_CTA =
  'bg-foreground text-background hover:bg-foreground/90 active:bg-foreground/80 ' +
  'focus-visible:ring-foreground/40';

/**
 * Secondary/outline/ghost portal button — kills the brand-blue focus ring and
 * the brand-tinted `accent` hover that kit `variant="outline"` applies.
 */
export const NEUTRAL_BTN =
  'focus-visible:ring-foreground/40 hover:bg-secondary hover:text-foreground';

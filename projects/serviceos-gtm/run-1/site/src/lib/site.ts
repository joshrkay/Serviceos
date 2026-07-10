/** Site-wide constants and navigation. */

/**
 * Brand = "Rivet" (company + site name). Product = "ServiceOS". The formal
 * entity name is "Rivet ServiceOS", used where fuller context helps (the
 * one-line definition and structured data). SITE_NAME is the short brand used
 * in the title template ("<Page> — Rivet") and the OG siteName. Keep the
 * literal "ServiceOS" only where it names the product itself, never as the
 * site brand.
 */
export const SITE_NAME = 'Rivet';

export function getSiteUrl(): string {
  return process.env.NEXT_PUBLIC_SITE_URL ?? 'https://example.com';
}

export const PRIMARY_NAV: { href: string; label: string }[] = [
  { href: '/how-it-works', label: 'How it works' },
  { href: '/vs-jobber', label: 'Compare' },
  { href: '/pricing', label: 'Pricing' },
  { href: '/resources', label: 'Resources' },
  { href: '/faq', label: 'FAQ' },
];

export const FOOTER_NAV: { heading: string; links: { href: string; label: string }[] }[] = [
  {
    heading: 'Product',
    links: [
      { href: '/how-it-works', label: 'How it works' },
      { href: '/pricing', label: 'Pricing' },
      { href: '/faq', label: 'FAQ' },
    ],
  },
  {
    heading: 'Compare',
    links: [
      { href: '/vs-jobber', label: 'Rivet vs Jobber' },
      { href: '/vs-housecall-pro', label: 'Rivet vs Housecall Pro' },
    ],
  },
  {
    heading: 'Company',
    links: [{ href: '/resources', label: 'Resources' }],
  },
  {
    heading: 'Legal',
    links: [
      { href: '/legal/privacy', label: 'Privacy' },
      { href: '/legal/terms', label: 'Terms' },
    ],
  },
];

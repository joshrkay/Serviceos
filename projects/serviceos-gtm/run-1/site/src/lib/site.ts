/** Site-wide constants and navigation. */

export const SITE_NAME = 'ServiceOS'; /* COPY-TODO: confirm Rivet vs ServiceOS branding */

export function getSiteUrl(): string {
  return process.env.NEXT_PUBLIC_SITE_URL ?? 'https://example.com';
}

export const PRIMARY_NAV: { href: string; label: string }[] = [
  { href: '/how-it-works', label: 'How it works' },
  { href: '/vs-jobber', label: 'vs Jobber' },
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
      { href: '/vs-jobber', label: 'vs Jobber' },
    ],
  },
  {
    heading: 'Company',
    links: [
      { href: '/resources', label: 'Resources' },
      { href: '/faq', label: 'FAQ' },
    ],
  },
  {
    heading: 'Legal',
    links: [
      { href: '/legal/privacy', label: 'Privacy' },
      { href: '/legal/terms', label: 'Terms' },
    ],
  },
];

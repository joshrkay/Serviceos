/**
 * schema.org / JSON-LD builders. Centralized so every page emits consistent,
 * validated structured data and so the shapes can be unit-tested. Absolute URLs
 * are built from getSiteUrl().
 *
 * Hard rule (see claims.md): no `aggregateRating` and no `review` anywhere —
 * we have no real reviews and never fabricate them. None of these builders emit
 * those fields. scripts/validate-schema.mjs asserts their absence in built HTML.
 */
import { getSiteUrl } from './site';
import { PLAN_ORDER, PLANS } from './plans';

function base(): string {
  return getSiteUrl().replace(/\/$/, '');
}

/** Absolute URL for a site-relative path (e.g. "/pricing" → "https://…/pricing"). */
export function absoluteUrl(path: string): string {
  if (/^https?:\/\//.test(path)) return path;
  return `${base()}${path.startsWith('/') ? path : `/${path}`}`;
}

/** Site-wide Organization. Rendered once in the root layout. */
export function organizationJsonLd(): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: 'Rivet',
    alternateName: 'Rivet ServiceOS',
    url: base(),
    logo: absoluteUrl('/brand/logo.svg'),
    description:
      'Rivet ServiceOS is an AI back office for one-to-three-truck HVAC and plumbing companies that answers the phone, books jobs, sends estimates and invoices by voice, and never acts without the owner’s approval.',
  };
}

/**
 * SoftwareApplication for the product itself, with the three real tiers as
 * Offer objects. Rendered on home + pricing. No aggregateRating (no real
 * reviews). Prices come from lib/plans.ts (integer cents → dollar string).
 */
export function softwareApplicationJsonLd(): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: 'Rivet ServiceOS',
    applicationCategory: 'BusinessApplication',
    operatingSystem: 'Web',
    url: base(),
    description:
      'AI back office for 1–3-truck HVAC and plumbing shops: it answers the phone, books jobs, and drafts estimates and invoices by voice — every action approved by the owner.',
    offers: {
      '@type': 'AggregateOffer',
      priceCurrency: 'USD',
      lowPrice: (PLANS[PLAN_ORDER[0]].priceCents / 100).toFixed(2),
      highPrice: (PLANS[PLAN_ORDER[PLAN_ORDER.length - 1]].priceCents / 100).toFixed(2),
      offerCount: PLAN_ORDER.length,
      offers: PLAN_ORDER.map((id) => ({
        '@type': 'Offer',
        name: `${PLANS[id].name} plan`,
        price: (PLANS[id].priceCents / 100).toFixed(2),
        priceCurrency: 'USD',
        url: absoluteUrl('/pricing'),
      })),
    },
  };
}

/** Ordered breadcrumb trail. Pass items in order (Home first). */
export function breadcrumbJsonLd(items: { name: string; path: string }[]): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((item, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: item.name,
      item: absoluteUrl(item.path),
    })),
  };
}

/**
 * FAQPage from visible Q&A pairs. `answer` is plain text — callers must strip
 * any markdown link syntax first (see plainText) so the JSON-LD matches the
 * rendered text exactly (Google requires parity).
 */
export function faqPageJsonLd(items: { q: string; a: string }[]): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: items.map((item) => ({
      '@type': 'Question',
      name: item.q,
      acceptedAnswer: { '@type': 'Answer', text: item.a },
    })),
  };
}

/** Article structured data for a resource post. */
export function articleJsonLd(input: {
  title: string;
  description: string;
  datePublished: string;
  authorName: string;
  path: string;
}): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: input.title,
    description: input.description,
    datePublished: input.datePublished,
    author: { '@type': 'Organization', name: input.authorName },
    publisher: { '@type': 'Organization', name: 'Rivet' },
    mainEntityOfPage: absoluteUrl(input.path),
  };
}

/**
 * Collapse the minimal `[label](url)` markdown-link syntax used in article
 * bodies down to its visible label, so FAQ JSON-LD answer text matches what a
 * reader sees on the page (no raw brackets/URLs in structured data).
 */
export function plainText(text: string): string {
  return text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1');
}

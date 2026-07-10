import { describe, it, expect } from 'vitest';
import {
  absoluteUrl,
  organizationJsonLd,
  softwareApplicationJsonLd,
  breadcrumbJsonLd,
  faqPageJsonLd,
  articleJsonLd,
  plainText,
} from './schema';
import { PLAN_ORDER } from './plans';

/** Recursively test whether any object key matches one of `keys`. */
function deepHasKey(obj: unknown, keys: string[]): boolean {
  if (obj == null || typeof obj !== 'object') return false;
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (keys.includes(k)) return true;
    if (deepHasKey(v, keys)) return true;
  }
  return false;
}

describe('absoluteUrl', () => {
  it('prefixes site origin onto a relative path', () => {
    expect(absoluteUrl('/pricing')).toBe('https://example.com/pricing');
  });
  it('adds a leading slash when missing', () => {
    expect(absoluteUrl('faq')).toBe('https://example.com/faq');
  });
  it('passes through an already-absolute url', () => {
    expect(absoluteUrl('https://x.test/y')).toBe('https://x.test/y');
  });
});

describe('organizationJsonLd', () => {
  const org = organizationJsonLd();
  it('is a schema.org Organization named Rivet', () => {
    expect(org['@type']).toBe('Organization');
    expect(org.name).toBe('Rivet');
    expect(org.alternateName).toBe('Rivet ServiceOS');
  });
  it('uses absolute url + logo', () => {
    expect(String(org.url)).toMatch(/^https?:\/\//);
    expect(String(org.logo)).toMatch(/^https?:\/\//);
  });
  it('omits sameAs (no real social profiles)', () => {
    expect(org.sameAs).toBeUndefined();
  });
});

describe('softwareApplicationJsonLd', () => {
  const app = softwareApplicationJsonLd();
  it('has the required top-level fields', () => {
    expect(app['@type']).toBe('SoftwareApplication');
    expect(app.name).toBe('Rivet ServiceOS');
    expect(app.applicationCategory).toBe('BusinessApplication');
    expect(app.operatingSystem).toBe('Web');
  });
  it('lists all three tiers as priced Offers with a pricing url', () => {
    const offers = (app.offers as Record<string, unknown>).offers as Record<string, unknown>[];
    expect(offers).toHaveLength(PLAN_ORDER.length);
    for (const o of offers) {
      expect(o.priceCurrency).toBe('USD');
      expect(String(o.price)).toMatch(/^\d+\.\d{2}$/);
      expect(String(o.url)).toBe('https://example.com/pricing');
    }
  });
  it('NEVER emits aggregateRating or review', () => {
    expect(deepHasKey(app, ['aggregateRating', 'review', 'ratingValue'])).toBe(false);
  });
});

describe('breadcrumbJsonLd', () => {
  const bc = breadcrumbJsonLd([
    { name: 'Home', path: '/' },
    { name: 'Resources', path: '/resources' },
    { name: 'Article', path: '/resources/x' },
  ]);
  it('emits ordered ListItems with absolute item URLs', () => {
    const items = bc.itemListElement as Record<string, unknown>[];
    expect(items.map((i) => i.position)).toEqual([1, 2, 3]);
    expect(items[0].item).toBe('https://example.com/');
    expect(items[2].item).toBe('https://example.com/resources/x');
  });
});

describe('faqPageJsonLd', () => {
  const faq = faqPageJsonLd([
    { q: 'Q1?', a: 'A1.' },
    { q: 'Q2?', a: 'A2.' },
  ]);
  it('maps each Q&A to a Question with an acceptedAnswer.text', () => {
    const items = faq.mainEntity as Record<string, unknown>[];
    expect(items).toHaveLength(2);
    expect(items[0]['@type']).toBe('Question');
    expect(items[0].name).toBe('Q1?');
    expect((items[0].acceptedAnswer as Record<string, unknown>).text).toBe('A1.');
  });
});

describe('articleJsonLd', () => {
  const a = articleJsonLd({
    title: 'T',
    description: 'D',
    datePublished: '2026-07-10',
    authorName: 'Rivet team',
    path: '/resources/t',
  });
  it('carries headline, datePublished, author and absolute mainEntityOfPage', () => {
    expect(a['@type']).toBe('Article');
    expect(a.headline).toBe('T');
    expect(a.datePublished).toBe('2026-07-10');
    expect((a.author as Record<string, unknown>).name).toBe('Rivet team');
    expect(a.mainEntityOfPage).toBe('https://example.com/resources/t');
  });
});

describe('plainText', () => {
  it('collapses markdown links to their visible label (FAQ JSON-LD parity)', () => {
    expect(plainText('See [Jobber](https://x.test) pricing.')).toBe('See Jobber pricing.');
  });
  it('leaves plain text untouched', () => {
    expect(plainText('No links here.')).toBe('No links here.');
  });
});

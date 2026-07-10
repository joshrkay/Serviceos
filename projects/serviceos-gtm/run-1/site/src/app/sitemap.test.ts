import { describe, it, expect } from 'vitest';
import sitemap from './sitemap';
import { allArticleSlugs } from '@/lib/articles';

describe('sitemap', () => {
  const entries = sitemap();
  const urls = entries.map((e) => e.url);

  it('includes both comparison pages', () => {
    expect(urls).toContain('https://example.com/vs-jobber');
    expect(urls).toContain('https://example.com/vs-housecall-pro');
  });

  it('includes the core marketing + legal pages', () => {
    for (const path of ['/', '/how-it-works', '/pricing', '/faq', '/resources', '/legal/privacy', '/legal/terms', '/signup']) {
      expect(urls).toContain(`https://example.com${path}`);
    }
  });

  it('includes every resource article', () => {
    for (const slug of allArticleSlugs()) {
      expect(urls).toContain(`https://example.com/resources/${slug}`);
    }
  });

  it('excludes internal / transactional-only routes', () => {
    for (const path of ['/nurture-preview', '/signup/demo-checkout', '/go-live-pending', '/signup/success']) {
      expect(urls).not.toContain(`https://example.com${path}`);
    }
  });

  it('gives the homepage top priority', () => {
    const home = entries.find((e) => e.url === 'https://example.com/');
    expect(home?.priority).toBe(1);
  });
});

import type { MetadataRoute } from 'next';
import { getSiteUrl } from '@/lib/site';
import { allArticleSlugs } from '@/lib/articles';

export default function sitemap(): MetadataRoute.Sitemap {
  const base = getSiteUrl().replace(/\/$/, '');
  const staticPaths = [
    '/',
    '/how-it-works',
    '/vs-jobber',
    '/vs-housecall-pro',
    '/pricing',
    '/faq',
    '/resources',
    '/legal/privacy',
    '/legal/terms',
    '/signup',
  ];

  const now = new Date();
  const staticEntries: MetadataRoute.Sitemap = staticPaths.map((path) => ({
    url: `${base}${path}`,
    lastModified: now,
    changeFrequency: 'weekly',
    priority: path === '/' ? 1 : 0.7,
  }));

  const articleEntries: MetadataRoute.Sitemap = allArticleSlugs().map((slug) => ({
    url: `${base}/resources/${slug}`,
    lastModified: now,
    changeFrequency: 'monthly',
    priority: 0.5,
  }));

  return [...staticEntries, ...articleEntries];
}

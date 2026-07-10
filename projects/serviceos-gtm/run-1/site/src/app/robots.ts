import type { MetadataRoute } from 'next';
import { getSiteUrl } from '@/lib/site';

/**
 * Preview-safety: only the PRODUCTION Vercel deploy is indexable. Every other
 * environment (preview, development, local) returns disallow-all so preview URLs
 * never leak into search. This complements the X-Robots-Tag header in
 * next.config.mjs. We log the decision so it's visible in build/runtime logs.
 */
export default function robots(): MetadataRoute.Robots {
  const isProduction = process.env.VERCEL_ENV === 'production';
  console.log(
    JSON.stringify({
      source: 'robots',
      vercelEnv: process.env.VERCEL_ENV ?? '(unset)',
      indexable: isProduction,
    }),
  );

  const base = getSiteUrl().replace(/\/$/, '');

  if (!isProduction) {
    return {
      rules: [{ userAgent: '*', disallow: '/' }],
    };
  }

  return {
    rules: [{ userAgent: '*', allow: '/' }],
    sitemap: `${base}/sitemap.xml`,
    host: base,
  };
}

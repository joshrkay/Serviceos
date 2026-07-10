import type { Metadata } from 'next';
import { getSiteUrl, SITE_NAME } from './site';

/** Shared 1200×630 social card (public/og.png), resolved absolute via metadataBase. */
export const OG_IMAGE = {
  url: '/og.png',
  width: 1200,
  height: 630,
  alt: 'Rivet — you handle the work, we handle the business.',
} as const;

/**
 * Per-page metadata helper. metadataBase drives absolute canonical + OG URLs
 * from NEXT_PUBLIC_SITE_URL. The root layout applies the "<Page> — Rivet" title
 * template; pass `titleAbsolute` for pages whose title already reads cleanly on
 * its own (e.g. "Rivet vs Jobber…") so the brand suffix isn't doubled.
 */
export function pageMetadata(input: {
  title: string;
  description: string;
  path?: string;
  titleAbsolute?: boolean;
}): Metadata {
  return {
    title: input.titleAbsolute ? { absolute: input.title } : input.title,
    description: input.description,
    alternates: input.path ? { canonical: input.path } : undefined,
    openGraph: {
      title: input.title,
      description: input.description,
      siteName: SITE_NAME,
      url: input.path ?? '/',
      type: 'website',
      images: [OG_IMAGE],
    },
    twitter: {
      card: 'summary_large_image',
      title: input.title,
      description: input.description,
      images: [OG_IMAGE.url],
    },
  };
}

export const siteMetadataBase = new URL(getSiteUrl());

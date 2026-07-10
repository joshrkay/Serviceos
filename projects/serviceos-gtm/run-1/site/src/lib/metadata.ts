import type { Metadata } from 'next';
import { getSiteUrl, SITE_NAME } from './site';

/**
 * Per-page metadata helper. Titles/descriptions are PLACEHOLDER; content workers
 * refine. metadataBase drives absolute canonical + OG URLs from NEXT_PUBLIC_SITE_URL.
 */
export function pageMetadata(input: {
  title: string;
  description: string;
  path?: string;
}): Metadata {
  return {
    title: input.title,
    description: input.description,
    alternates: input.path ? { canonical: input.path } : undefined,
    openGraph: {
      title: input.title,
      description: input.description,
      siteName: SITE_NAME,
      url: input.path ?? '/',
      type: 'website',
    },
    twitter: {
      card: 'summary_large_image',
      title: input.title,
      description: input.description,
    },
  };
}

export const siteMetadataBase = new URL(getSiteUrl());

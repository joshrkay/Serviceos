import type { Metadata } from 'next';
import './globals.css';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { JsonLd } from '@/components/JsonLd';
import { siteMetadataBase } from '@/lib/metadata';
import { getSiteUrl, SITE_NAME } from '@/lib/site';

export const metadata: Metadata = {
  metadataBase: siteMetadataBase,
  title: {
    default: `${SITE_NAME} — {/* COPY-TODO: brand tagline */}`,
    template: `%s · ${SITE_NAME}`,
  },
  description: 'Placeholder site description. {/* COPY-TODO */}',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const orgJsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: SITE_NAME,
    url: getSiteUrl(),
    // COPY-TODO: logo, sameAs social profiles, contactPoint
  };

  return (
    <html lang="en">
      <body className="flex min-h-screen flex-col">
        <JsonLd data={orgJsonLd} />
        <Header />
        <main className="flex-1">{children}</main>
        <Footer />
      </body>
    </html>
  );
}

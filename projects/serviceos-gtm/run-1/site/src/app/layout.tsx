import type { Metadata } from 'next';
import { Archivo, IBM_Plex_Sans, IBM_Plex_Mono } from 'next/font/google';
import './globals.css';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { JsonLd } from '@/components/JsonLd';
import { siteMetadataBase, OG_IMAGE } from '@/lib/metadata';
import { SITE_NAME } from '@/lib/site';
import { organizationJsonLd } from '@/lib/schema';

/**
 * Brand faces, loaded self-hosted via next/font (no render-blocking Google
 * <link>, latin subset, display: swap). Exposed as CSS variables that
 * tokens.css feeds into --font-display / --font-body / --font-mono.
 *   Display — Archivo (700 bold, 900 black) for headlines + the wordmark feel.
 *   Body    — IBM Plex Sans (400/500/600).
 *   Data    — IBM Plex Mono (500) for prices, IDs, phone numbers.
 */
const archivo = Archivo({
  subsets: ['latin'],
  weight: ['700', '900'],
  display: 'swap',
  variable: '--font-archivo',
});
const plexSans = IBM_Plex_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  display: 'swap',
  variable: '--font-plex-sans',
});
const plexMono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['500'],
  display: 'swap',
  variable: '--font-plex-mono',
});

export const metadata: Metadata = {
  metadataBase: siteMetadataBase,
  title: {
    default: 'Rivet ServiceOS — AI back office for HVAC & plumbing',
    template: `%s — ${SITE_NAME}`,
  },
  description:
    'An AI back office for 1–3-truck HVAC and plumbing shops. It answers the phone, books jobs, and sends estimates and invoices — you approve everything.',
  icons: {
    icon: [{ url: '/brand/favicon.svg', type: 'image/svg+xml' }],
  },
  openGraph: {
    type: 'website',
    siteName: SITE_NAME,
    title: 'Rivet ServiceOS — AI back office for HVAC & plumbing',
    description:
      'An AI back office for 1–3-truck HVAC and plumbing shops. It answers the phone, books jobs, and sends estimates and invoices — you approve everything.',
    url: '/',
    images: [OG_IMAGE],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Rivet ServiceOS — AI back office for HVAC & plumbing',
    description:
      'An AI back office for 1–3-truck HVAC and plumbing shops. It answers the phone, books jobs, and sends estimates and invoices — you approve everything.',
    images: [OG_IMAGE.url],
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const orgJsonLd = organizationJsonLd();

  return (
    <html
      lang="en"
      className={`${archivo.variable} ${plexSans.variable} ${plexMono.variable}`}
    >
      <body className="flex min-h-screen flex-col">
        <JsonLd data={orgJsonLd} />
        <Header />
        <main className="flex-1">{children}</main>
        <Footer />
      </body>
    </html>
  );
}

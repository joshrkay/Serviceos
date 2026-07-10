import Link from 'next/link';
import { FOOTER_NAV } from '@/lib/site';

export function Footer() {
  const year = new Date().getFullYear();
  return (
    <footer className="theme-dark mt-24 border-t border-border bg-bg text-fg">
      <div className="container-page grid gap-10 py-12 sm:grid-cols-2 lg:grid-cols-5">
        <div className="space-y-4">
          <Link href="/" className="inline-flex min-h-11 items-center" aria-label="Rivet — home">
            {/* Dark lockup on the gunmetal footer (light steel hex, white wordmark, orange dome). */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/brand/logo-dark.svg" alt="Rivet" width={132} height={36} className="h-8 w-auto" />
          </Link>
          {/* Entity definition — one sentence, for humans and answer engines. */}
          <p className="max-w-sm text-sm leading-relaxed text-fg-muted">
            Rivet ServiceOS is an AI back office for one-to-three-truck HVAC and plumbing companies
            that answers the phone, books jobs, sends estimates and invoices by voice, and never acts
            without the owner&rsquo;s approval.
          </p>
        </div>

        {FOOTER_NAV.map((col) => (
          <nav key={col.heading} aria-label={col.heading}>
            <h2 className="mb-3 text-xs font-semibold uppercase tracking-[0.08em] text-fg-subtle">
              {col.heading}
            </h2>
            <ul className="space-y-1">
              {col.links.map((link) => (
                <li key={link.href}>
                  <Link
                    href={link.href}
                    className="flex min-h-11 items-center text-sm text-fg-muted hover:text-fg"
                  >
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        ))}
      </div>

      <div className="border-t border-border">
        <div className="container-page flex flex-col gap-2 py-6 text-xs text-fg-subtle sm:flex-row sm:items-center sm:justify-between">
          <p>&copy; {year} Rivet. All rights reserved.</p>
          <p>
            Rivet and ServiceOS are product and company names. Card payments processed by Stripe.
          </p>
        </div>
      </div>
    </footer>
  );
}

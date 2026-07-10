import Link from 'next/link';
import { FOOTER_NAV, SITE_NAME } from '@/lib/site';

export function Footer() {
  const year = new Date().getFullYear();
  return (
    <footer className="mt-24 border-t border-border bg-surface-muted">
      <div className="container-page grid gap-10 py-12 sm:grid-cols-2 lg:grid-cols-4">
        <div className="space-y-3">
          <div className="flex items-center gap-2 font-display text-base font-bold text-fg">
            <span
              aria-hidden
              className="inline-flex h-7 w-7 items-center justify-center rounded bg-primary text-primary-fg"
            >
              S
            </span>
            {SITE_NAME}
          </div>
          {/* Entity one-liner slot — legal entity + address filled by content worker. */}
          <p className="text-sm text-fg-muted">{/* COPY-TODO: entity one-liner */}Placeholder entity one-liner.</p>
        </div>

        {FOOTER_NAV.map((col) => (
          <nav key={col.heading} aria-label={col.heading}>
            <h2 className="mb-3 text-xs font-semibold uppercase tracking-widest text-fg-muted">
              {col.heading}
            </h2>
            <ul className="space-y-2">
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
        <div className="container-page py-6 text-xs text-fg-muted">
          &copy; {year} {SITE_NAME}. {/* COPY-TODO: rights / legal footer line */}All rights reserved.
        </div>
      </div>
    </footer>
  );
}

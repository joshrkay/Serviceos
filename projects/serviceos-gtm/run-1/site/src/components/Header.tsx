import Link from 'next/link';
import { PRIMARY_NAV } from '@/lib/site';

export function Header() {
  return (
    <header className="sticky top-0 z-40 border-b border-border bg-bg/90 backdrop-blur">
      <div className="container-page flex h-16 items-center justify-between gap-4">
        {/* Full lockup on the light header bg (ink mark + wordmark, orange dome). */}
        <Link href="/" className="flex min-h-11 items-center" aria-label="Rivet — home">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/brand/logo.svg"
            alt="Rivet"
            width={132}
            height={36}
            className="h-8 w-auto"
          />
        </Link>

        <nav aria-label="Primary" className="hidden items-center gap-6 md:flex">
          {PRIMARY_NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="flex min-h-11 items-center text-sm font-medium text-fg-muted hover:text-fg"
            >
              {item.label}
            </Link>
          ))}
        </nav>

        <div className="flex items-center gap-2">
          <Link href="/signup" className="btn-primary">
            Start free trial
          </Link>
        </div>
      </div>

      {/* Mobile nav — horizontal scroll strip, no overflow at 320px. */}
      <nav
        aria-label="Primary mobile"
        className="container-page flex gap-4 overflow-x-auto border-t border-border py-2 md:hidden"
      >
        {PRIMARY_NAV.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className="flex min-h-11 shrink-0 items-center whitespace-nowrap text-sm font-medium text-fg-muted"
          >
            {item.label}
          </Link>
        ))}
      </nav>
    </header>
  );
}

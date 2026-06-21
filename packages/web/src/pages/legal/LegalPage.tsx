import { Zap } from 'lucide-react';
import type { ReactNode } from 'react';

/**
 * Shared chrome for the public legal pages (`/privacy`, `/terms`). These are
 * unauthenticated, no-Shell routes — Apple App Store Review requires a reachable
 * Privacy Policy URL, and both are linked from the marketing footer.
 *
 * Mirrors the landing page's slate palette and container widths. Mobile-first:
 * a single `max-w-3xl` column with `px-6`, so there is no horizontal overflow at
 * 320px, and the back link is a ≥44px (`min-h-11`) tap target per CLAUDE.md.
 */
export function LegalPage({
  title,
  lastUpdated,
  children,
}: {
  title: string;
  lastUpdated: string;
  children: ReactNode;
}) {
  return (
    <div className="min-h-screen bg-white text-slate-700">
      <header className="border-b border-slate-200">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-6 py-4">
          <a href="/" className="flex items-center gap-2.5" aria-label="Rivet home">
            <span className="flex size-7 items-center justify-center rounded-lg bg-slate-900">
              <Zap size={13} className="text-white" />
            </span>
            <span className="text-sm tracking-tight text-slate-900">Rivet</span>
          </a>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-6 py-12">
        <h1 className="text-3xl font-semibold tracking-tight text-slate-900">{title}</h1>
        <p className="mt-2 text-sm text-slate-500">Last updated {lastUpdated}</p>

        {/* Draft notice — copy is a starting point pending legal review. */}
        <p className="mt-6 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          This is a draft for review and does not yet constitute legal advice.
          Have counsel review before public launch.
        </p>

        <div className="mt-8 space-y-8 text-[15px] leading-relaxed">{children}</div>

        <div className="mt-12 border-t border-slate-200 pt-8">
          <a
            href="/"
            className="inline-flex min-h-11 items-center text-sm font-medium text-slate-900 hover:underline"
          >
            ← Back to home
          </a>
        </div>
      </main>
    </div>
  );
}

/** A titled section within a legal document. */
export function LegalSection({ heading, children }: { heading: string; children: ReactNode }) {
  return (
    <section>
      <h2 className="text-lg font-semibold text-slate-900">{heading}</h2>
      <div className="mt-3 space-y-3">{children}</div>
    </section>
  );
}

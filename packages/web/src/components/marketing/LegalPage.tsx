import { AlertCircle } from 'lucide-react';

export interface LegalSection {
  heading: string;
  /** Paragraphs of body text. Render as plain strings (no HTML). */
  paragraphs?: string[];
  /** Optional bullet list rendered under the paragraphs. */
  bullets?: string[];
}

/**
 * Shared presentational shell for the Privacy and Terms pages. Renders a
 * draft banner, the title + last-updated line, and the section list.
 *
 * NOTE: the copy these pages carry is a good-faith draft for launch and
 * MUST be reviewed by counsel before it is relied on. The banner makes
 * that explicit to anyone reading it.
 */
export function LegalPage({
  title,
  lastUpdated,
  intro,
  sections,
}: {
  title: string;
  lastUpdated: string;
  intro: string;
  sections: LegalSection[];
}) {
  return (
    <section className="bg-white">
      <div className="mx-auto max-w-3xl px-6 py-16">
        <div className="mb-8 inline-flex items-center gap-2 rounded-full bg-amber-50 px-3 py-1 text-xs text-amber-700">
          <AlertCircle size={12} />
          Draft — pending legal review. Not yet a binding agreement.
        </div>
        <h1 className="text-3xl font-medium tracking-tight text-slate-900 sm:text-4xl">
          {title}
        </h1>
        <p className="mt-2 text-sm text-slate-500">Last updated: {lastUpdated}</p>
        <p className="mt-6 text-base leading-relaxed text-slate-600">{intro}</p>

        <div className="mt-10 space-y-10">
          {sections.map((section) => (
            <div key={section.heading}>
              <h2 className="text-lg font-medium text-slate-900">{section.heading}</h2>
              {section.paragraphs?.map((p, i) => (
                <p key={i} className="mt-3 text-sm leading-relaxed text-slate-600">
                  {p}
                </p>
              ))}
              {section.bullets && (
                <ul className="mt-3 list-disc space-y-1.5 pl-5 text-sm leading-relaxed text-slate-600">
                  {section.bullets.map((b) => (
                    <li key={b}>{b}</li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>

        <p className="mt-12 border-t border-slate-200 pt-6 text-sm text-slate-500">
          Questions about this document? Email{' '}
          <a className="text-slate-900 underline" href="mailto:support@rivet.ai">
            support@rivet.ai
          </a>
          .
        </p>
      </div>
    </section>
  );
}

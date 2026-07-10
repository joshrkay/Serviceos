import Link from 'next/link';
import type { Metadata } from 'next';
import { Section } from '@/components/Section';
import { pageMetadata } from '@/lib/metadata';
import { SITE_NAME } from '@/lib/site';

export const metadata: Metadata = pageMetadata({
  title: 'vs Jobber', // COPY-TODO
  description: 'Placeholder comparison description.', // COPY-TODO
  path: '/vs-jobber',
});

const ROWS = [
  { feature: 'COPY-TODO capability one', us: true, them: false },
  { feature: 'COPY-TODO capability two', us: true, them: true },
  { feature: 'COPY-TODO capability three', us: true, them: false },
  { feature: 'COPY-TODO capability four', us: true, them: true },
];

function Cell({ value }: { value: boolean }) {
  return (
    <span className={value ? 'text-success' : 'text-fg-muted'} aria-label={value ? 'Yes' : 'No'}>
      {value ? '✓' : '—'}
    </span>
  );
}

export default function VsJobberPage() {
  return (
    <>
      <Section as="div" className="pt-16">
        <div className="mx-auto max-w-3xl text-center">
          <p className="eyebrow">Comparison</p>
          <h1 className="mt-4 font-display text-4xl font-bold text-fg">
            {SITE_NAME} vs Jobber {/* COPY-TODO refine headline */}
          </h1>
          <p className="mt-6 text-lg text-fg-muted">{/* COPY-TODO */}Placeholder honest comparison intro.</p>
        </div>
      </Section>

      <Section aria-labelledby="compare-heading">
        <h2 id="compare-heading" className="sr-only">
          Feature comparison
        </h2>
        <div className="mx-auto max-w-3xl overflow-x-auto">
          <table className="w-full min-w-[420px] border-collapse text-left">
            <thead>
              <tr className="border-b border-border">
                <th className="py-3 pr-4 text-sm font-semibold text-fg">Capability</th>
                <th className="py-3 px-4 text-center text-sm font-semibold text-fg">{SITE_NAME}</th>
                <th className="py-3 px-4 text-center text-sm font-semibold text-fg-muted">Jobber</th>
              </tr>
            </thead>
            <tbody>
              {ROWS.map((row) => (
                <tr key={row.feature} className="border-b border-border">
                  <td className="py-3 pr-4 text-sm text-fg">{row.feature}</td>
                  <td className="py-3 px-4 text-center">
                    <Cell value={row.us} />
                  </td>
                  <td className="py-3 px-4 text-center">
                    <Cell value={row.them} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mx-auto mt-6 max-w-3xl text-xs text-fg-muted">
          {/* COPY-TODO: honest disclaimer / trademark note about Jobber */}Placeholder disclaimer. Jobber is a
          trademark of its respective owner.
        </p>
        <div className="mt-10 text-center">
          <Link href="/signup" className="btn-primary">
            Start free trial
          </Link>
        </div>
      </Section>
    </>
  );
}

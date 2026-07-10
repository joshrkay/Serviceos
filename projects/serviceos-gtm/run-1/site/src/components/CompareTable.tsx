import Link from 'next/link';
import type { ReactNode } from 'react';

/**
 * Machine-parseable head-to-head comparison table for AEO / answer engines.
 * Renders a semantic <table> with <caption>, grouped <tbody> sections, and
 * scope attributes so the structure is extractable by crawlers. Competitor
 * cells may carry footnote-style source refs that link to the sources list.
 */

export type CellValue = boolean | string;

export interface CompareRow {
  /** Row header (the capability being compared). */
  feature: string;
  /** Our column value. `true` = yes, `false` = no, string = nuanced value. */
  us: CellValue;
  /** Competitor column value. */
  them: CellValue;
  /** Optional source ref number(s) for the competitor cell (link to sources). */
  themRefs?: number[];
}

export interface CompareGroup {
  name: string;
  rows: CompareRow[];
}

export interface CompareSource {
  /** Footnote number, referenced by CompareRow.themRefs. */
  id: number;
  /** Human-readable label, e.g. "getjobber.com/pricing". */
  label: string;
  href: string;
}

export interface CompareTableProps {
  /** Table caption — the AEO-liftable one-line summary of what this compares. */
  caption: string;
  /** Our brand column header. */
  brand: string;
  /** Competitor column header. */
  competitor: string;
  groups: CompareGroup[];
  sources: CompareSource[];
  /** Anchor slug so multiple tables per page keep unique source ids. */
  idPrefix?: string;
}

function Cell({ value }: { value: CellValue }): ReactNode {
  if (value === true) {
    return (
      <span className="font-semibold text-success" aria-label="Yes">
        ✓ Yes
      </span>
    );
  }
  if (value === false) {
    return (
      <span className="text-fg-muted" aria-label="No">
        — No
      </span>
    );
  }
  return <span className="text-fg">{value}</span>;
}

export function CompareTable({
  caption,
  brand,
  competitor,
  groups,
  sources,
  idPrefix = 'src',
}: CompareTableProps) {
  return (
    <div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[520px] border-collapse text-left align-top">
          <caption className="mb-4 text-left text-sm text-fg-muted">{caption}</caption>
          <thead>
            <tr className="border-b-2 border-border">
              <th scope="col" className="py-3 pr-4 text-sm font-semibold text-fg">
                Capability
              </th>
              <th scope="col" className="py-3 px-4 text-sm font-semibold text-primary">
                {brand}
              </th>
              <th scope="col" className="py-3 px-4 text-sm font-semibold text-fg-muted">
                {competitor}
              </th>
            </tr>
          </thead>
          {groups.map((group) => (
            <tbody key={group.name}>
              <tr className="bg-surface-muted">
                <th
                  scope="colgroup"
                  colSpan={3}
                  className="py-2 px-4 text-xs font-semibold uppercase tracking-widest text-fg-muted"
                >
                  {group.name}
                </th>
              </tr>
              {group.rows.map((row) => (
                <tr key={row.feature} className="border-b border-border">
                  <th scope="row" className="py-3 pr-4 text-sm font-normal text-fg">
                    {row.feature}
                  </th>
                  <td className="py-3 px-4 text-sm">
                    <Cell value={row.us} />
                  </td>
                  <td className="py-3 px-4 text-sm">
                    <Cell value={row.them} />
                    {row.themRefs?.map((ref) => (
                      <sup key={ref} className="ml-0.5">
                        <a
                          href={`#${idPrefix}-${ref}`}
                          className="text-primary hover:underline"
                          aria-label={`Source ${ref}`}
                        >
                          {ref}
                        </a>
                      </sup>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          ))}
        </table>
      </div>
      <div className="mt-6 text-xs text-fg-muted">
        <p className="font-semibold text-fg">Sources</p>
        <ol className="mt-2 space-y-1">
          {sources.map((source) => (
            <li key={source.id} id={`${idPrefix}-${source.id}`}>
              <span className="mr-1">{source.id}.</span>
              <Link
                href={source.href}
                className="text-primary hover:underline"
                target="_blank"
                rel="noopener noreferrer"
              >
                {source.label}
              </Link>
              <span> — accessed July 2026.</span>
            </li>
          ))}
        </ol>
        <p className="mt-3">
          {competitor} is a trademark of its respective owner; this independent comparison is not
          affiliated with or endorsed by {competitor}. Competitor capabilities and prices are drawn
          from the cited pages as accessed July 2026 and may have changed — confirm against the live
          product before relying on them.
        </p>
      </div>
    </div>
  );
}

/**
 * #1498 — literal document numbers (JOB-0081, INV-0067, EST-0079).
 *
 * A document number is not a free-text description to score: it is the
 * record's own key, printed on every screen and PDF the operator is looking
 * at. Reading one is an exact, tenant-scoped repo lookup, so the id it yields
 * is verified by construction — the same standing `resolveLiteralJobReference`
 * gives a literal UUID (routes/assistant.ts). The fuzzy EntityResolver stays
 * the path for everything that is NOT a literal number.
 *
 * Why it is needed: the job resolver never scored `job_number` at all, so
 * "JOB-0081" matched nothing, and the classifier puts a spoken number in
 * whichever field it likes (`jobReference`, or nowhere) — the operator's own
 * words are the one place the number reliably is.
 */
import type { Job, JobRepository } from '../../jobs/job';
import type { Invoice, InvoiceRepository } from '../../invoices/invoice';
import type { Estimate, EstimateRepository } from '../../estimates/estimate';

export type DocumentKind = 'job' | 'invoice' | 'estimate';

export interface DocumentNumber {
  kind: DocumentKind;
  /** Upper-cased, as the record stores it ("JOB-0081"). */
  number: string;
}

const PREFIX_KIND: Readonly<Record<string, DocumentKind>> = {
  JOB: 'job',
  INV: 'invoice',
  EST: 'estimate',
};

const DOCUMENT_NUMBER_RE = /\b(JOB|INV|EST)-(\d+)\b/gi;

/** Every document number in `text`, in order, de-duplicated. */
export function findDocumentNumbers(text: string | undefined): DocumentNumber[] {
  if (!text) return [];
  const seen = new Set<string>();
  const out: DocumentNumber[] = [];
  for (const match of text.matchAll(DOCUMENT_NUMBER_RE)) {
    const number = `${match[1].toUpperCase()}-${match[2]}`;
    if (seen.has(number)) continue;
    seen.add(number);
    out.push({ kind: PREFIX_KIND[match[1].toUpperCase()], number });
  }
  return out;
}

export interface DocumentRepos {
  jobRepo?: Pick<JobRepository, 'findByTenant'>;
  invoiceRepo?: Pick<InvoiceRepository, 'findByTenant'>;
  estimateRepo?: Pick<EstimateRepository, 'findByTenant'>;
}

export type FoundDocument =
  | { kind: 'job'; record: Job }
  | { kind: 'invoice'; record: Invoice }
  | { kind: 'estimate'; record: Estimate };

/**
 * The ONE record carrying exactly this number, or `null` when none does.
 * `undefined` when this deployment has no repo for the kind (nothing can be
 * said either way). The list search narrows; exact equality decides — a
 * search for "JOB-008" must never answer with JOB-0081.
 */
export async function findDocumentByNumber(
  repos: DocumentRepos,
  tenantId: string,
  doc: DocumentNumber,
): Promise<FoundDocument | null | undefined> {
  const same = (n: string | undefined) => (n ?? '').toUpperCase() === doc.number;
  switch (doc.kind) {
    case 'job': {
      if (!repos.jobRepo) return undefined;
      const rows = await repos.jobRepo.findByTenant(tenantId, { search: doc.number, limit: 20 });
      const record = rows.find((j) => same(j.jobNumber));
      return record ? { kind: 'job', record } : null;
    }
    case 'invoice': {
      if (!repos.invoiceRepo) return undefined;
      const rows = await repos.invoiceRepo.findByTenant(tenantId, { search: doc.number, limit: 20 });
      const record = rows.find((i) => same(i.invoiceNumber));
      return record ? { kind: 'invoice', record } : null;
    }
    case 'estimate': {
      if (!repos.estimateRepo) return undefined;
      const rows = await repos.estimateRepo.findByTenant(tenantId, {
        documentSearch: doc.number,
        limit: 20,
      });
      const record = rows.find((e) => same(e.estimateNumber));
      return record ? { kind: 'estimate', record } : null;
    }
  }
}

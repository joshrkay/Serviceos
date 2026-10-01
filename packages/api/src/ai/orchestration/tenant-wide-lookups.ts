/**
 * #1498 — the OPERATOR's tenant-wide lookups.
 *
 * The `lookup_*` skills were written for the live phone, where the caller IS
 * the customer, so eight of them are customer-scoped and refuse to run without
 * one (`CUSTOMER_SCOPED_LOOKUP_INTENTS`). On the operator surfaces (assistant
 * chat, in-app voice) that turned "how many open invoices do we have?" into
 * "Which customer do you mean?" — a question the owner cannot answer, because
 * they did not mean a customer: they meant the business.
 *
 * This module answers those questions for the whole tenant. It is reached ONLY
 * through `lookup-dispatch.ts#dispatchAssistantLookup` — the operator
 * surfaces' one lookup entry — and never from the phone, whose caller must
 * never hear another customer's records.
 *
 * AUTHORIZATION. A tenant-wide read is the same data the list screens show,
 * so it demands the same permission those screens do (`invoices:view`,
 * `estimates:view`), read from the DB-authoritative role the shared gate uses
 * and failing CLOSED: no resolvable role, no data.
 */
import type { IntentType } from './intent-classifier';
import type { AssistantLookupOutcome } from './lookup-dispatch';
import {
  actorHolds,
  type SharedLookupRepos,
  type VoiceLookupAnswerDeps,
} from '../../workers/voice-lookup-answer';
import type { Permission } from '../../auth/rbac';
import { formatCents, plural } from '../skills/spoken-format';
import type { EstimateStatus } from '../../estimates/estimate';
import type { Invoice } from '../../invoices/invoice';
import {
  findDocumentByNumber,
  findDocumentNumbers,
  type DocumentKind,
  type DocumentNumber,
  type FoundDocument,
} from '../resolution/document-number';

export interface TenantWideAnswer {
  outcome: AssistantLookupOutcome;
  content: string;
  reasoning: string;
}

export interface TenantWideLookupInput {
  tenantId: string;
  actorId: string;
  intent: IntentType;
  message?: string;
}

export interface TenantWideLookupDeps {
  answers: VoiceLookupAnswerDeps;
  shared: SharedLookupRepos;
}

const OFFICE_REFUSAL =
  "That's an office-level view. Ask an owner or dispatcher on your team to pull it up.";

function refused(permission: Permission): TenantWideAnswer {
  return {
    outcome: 'refused',
    content: OFFICE_REFUSAL,
    reasoning: `Tenant-wide lookup refused — your role lacks ${permission}.`,
  };
}

/** Invoices a customer still owes on: issued and not settled. */
const OPEN_INVOICE_STATUSES = new Set(['open', 'partially_paid']);

async function openInvoicesAnswer(
  input: TenantWideLookupInput,
  deps: TenantWideLookupDeps,
): Promise<TenantWideAnswer | null> {
  const invoiceRepo = deps.answers.invoiceRepo;
  if (!invoiceRepo) return null;
  if (!(await actorHolds(deps.answers, input.tenantId, input.actorId, 'invoices:view'))) {
    return refused('invoices:view');
  }
  const open = (await invoiceRepo.findByTenant(input.tenantId)).filter((i) =>
    OPEN_INVOICE_STATUSES.has(i.status),
  );
  const totalDue = open.reduce((sum, i) => sum + i.amountDueCents, 0);
  return {
    outcome: 'answered',
    content: `You have ${open.length} open ${plural(open.length, 'invoice')} with ${formatCents(totalDue)} outstanding in total.`,
    reasoning: 'Answered from every open invoice in your business (read-only lookup).',
  };
}

/** A status the operator's own words name ("how many DRAFT estimates"). */
const ESTIMATE_STATUS_WORDS: ReadonlyArray<{ re: RegExp; status: EstimateStatus; label: string }> = [
  { re: /\bdrafts?\b|\bborrador(?:es)?\b/i, status: 'draft', label: 'draft' },
  { re: /\bready\s+for\s+review\b/i, status: 'ready_for_review', label: 'ready-for-review' },
  { re: /\bsent\b|\benviad[oa]s?\b/i, status: 'sent', label: 'sent' },
  { re: /\baccepted\b|\bapproved\b|\baceptad[oa]s?\b/i, status: 'accepted', label: 'accepted' },
  { re: /\brejected\b|\bdeclined\b|\brechazad[oa]s?\b/i, status: 'rejected', label: 'declined' },
  { re: /\bexpired\b|\bvencid[oa]s?\b/i, status: 'expired', label: 'expired' },
];

/** Estimates still in play: not yet answered by the customer. */
const OPEN_ESTIMATE_STATUSES = new Set<EstimateStatus>(['draft', 'ready_for_review', 'sent']);

async function estimatesAnswer(
  input: TenantWideLookupInput,
  deps: TenantWideLookupDeps,
): Promise<TenantWideAnswer | null> {
  const estimateRepo = deps.answers.estimateRepo;
  if (!estimateRepo) return null;
  if (!(await actorHolds(deps.answers, input.tenantId, input.actorId, 'estimates:view'))) {
    return refused('estimates:view');
  }
  const all = await estimateRepo.findByTenant(input.tenantId);
  const named = ESTIMATE_STATUS_WORDS.find((w) => w.re.test(input.message ?? ''));
  if (named) {
    const n = all.filter((e) => e.status === named.status).length;
    return {
      outcome: 'answered',
      content: `You have ${n} ${named.label} ${plural(n, 'estimate')}.`,
      reasoning: `Counted every ${named.label} estimate in your business (read-only lookup).`,
    };
  }
  const open = all.filter((e) => OPEN_ESTIMATE_STATUSES.has(e.status));
  const drafts = open.filter((e) => e.status !== 'sent').length;
  const sent = open.length - drafts;
  return {
    outcome: 'answered',
    content:
      `You have ${open.length} open ${plural(open.length, 'estimate')}: ` +
      `${drafts} not sent yet and ${sent} waiting on the customer.`,
    reasoning: 'Counted every open estimate in your business (read-only lookup).',
  };
}

/** The lookups a document number answers directly ("status of JOB-0081"). */
const DOCUMENT_LOOKUP_INTENTS: ReadonlySet<IntentType> = new Set<IntentType>([
  'lookup_jobs',
  'lookup_invoices',
  'lookup_estimates',
]);

const DOCUMENT_PERMISSION: Readonly<Record<DocumentKind, Permission>> = {
  job: 'jobs:view',
  invoice: 'invoices:view',
  estimate: 'estimates:view',
};

function words(status: string): string {
  return status.replace(/_/g, ' ');
}

/** What an invoice's status means for the money, in the operator's terms. */
function invoiceStatusLine(inv: Invoice): string {
  const n = inv.invoiceNumber;
  switch (inv.status) {
    case 'draft':
      return `${n} is a draft for ${formatCents(inv.totals.totalCents)} — it hasn't been sent to the customer yet.`;
    case 'open':
      return `${n} is open with ${formatCents(inv.amountDueCents)} due.`;
    case 'partially_paid':
      return `${n} is partly paid — ${formatCents(inv.amountDueCents)} is still due.`;
    case 'paid':
      return `${n} is paid in full (${formatCents(inv.totals.totalCents)}).`;
    default:
      return `${n} is ${words(inv.status)}.`;
  }
}

function documentStatusLine(found: FoundDocument): string {
  switch (found.kind) {
    case 'job':
      return `${found.record.jobNumber} (${found.record.summary}) is ${words(found.record.status)}.`;
    case 'invoice':
      return invoiceStatusLine(found.record);
    case 'estimate':
      return `${found.record.estimateNumber} is ${words(found.record.status)}.`;
  }
}

/**
 * The document number the operator named for a document lookup — read from
 * any string the classifier extracted AND the operator's own words, because
 * the classifier files a spoken number in whichever field it likes.
 */
function namedDocument(
  entities: Record<string, unknown>,
  message: string | undefined,
): DocumentNumber | undefined {
  const extracted = Object.values(entities).filter((v): v is string => typeof v === 'string');
  return findDocumentNumbers([...extracted, message ?? ''].join(' '))[0];
}

/**
 * "What's the status of JOB-0081?" — answered from the record carrying that
 * exact number, whatever the lookup intent's usual customer scope. `null` when
 * no number was named (or the intent is not a document lookup).
 */
export async function answerDocumentLookup(
  input: TenantWideLookupInput & { entities: Record<string, unknown> },
  deps: TenantWideLookupDeps,
): Promise<TenantWideAnswer | null> {
  if (!DOCUMENT_LOOKUP_INTENTS.has(input.intent)) return null;
  const doc = namedDocument(input.entities, input.message);
  if (!doc) return null;
  const permission = DOCUMENT_PERMISSION[doc.kind];
  if (!(await actorHolds(deps.answers, input.tenantId, input.actorId, permission))) return refused(permission);
  const found = await findDocumentByNumber(
    {
      ...(deps.shared.jobRepo ? { jobRepo: deps.shared.jobRepo } : {}),
      ...(deps.answers.invoiceRepo ? { invoiceRepo: deps.answers.invoiceRepo } : {}),
      ...(deps.answers.estimateRepo ? { estimateRepo: deps.answers.estimateRepo } : {}),
    },
    input.tenantId,
    doc,
  );
  if (found === undefined) return null;
  if (found === null) {
    return {
      outcome: 'not_found',
      content: `I couldn't find ${doc.number}.`,
      reasoning: `No record carries the number ${doc.number}.`,
    };
  }
  return {
    outcome: 'answered',
    content: documentStatusLine(found),
    reasoning: `Answered from ${doc.number} (read-only lookup).`,
  };
}

/**
 * Answer a customer-scoped lookup intent for the WHOLE tenant, when the
 * operator named no customer. `null` means this intent has no tenant-wide
 * reading (a balance, a contact record) — the caller keeps asking which
 * customer.
 */
export async function answerTenantWideLookup(
  input: TenantWideLookupInput,
  deps: TenantWideLookupDeps,
): Promise<TenantWideAnswer | null> {
  switch (input.intent) {
    case 'lookup_invoices':
      return openInvoicesAnswer(input, deps);
    case 'lookup_estimates':
      return estimatesAnswer(input, deps);
    default:
      return null;
  }
}

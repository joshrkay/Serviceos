/**
 * Screen context for a chat or voice turn: "this job", "her", "that invoice"
 * resolve to the record the operator had open when they spoke.
 *
 * The web client sends `{ entityType, entityId }` for the detail page the turn
 * started on. Nothing here trusts that id: `loadPageContext` re-reads the
 * record tenant-scoped (a foreign or deleted id yields nothing), and the ids it
 * returns are repo lookups, so they are as verified as the entity resolver's.
 *
 * `mergePageContextIds` decides whether those ids may fill a draft. The page is
 * a tiebreaker for words that point at nothing, never an override for words
 * that name something:
 *   - the operator named no record at all ("add a note: gate code 4471"), or
 *     only pointed at one ("this job", "them") → the page fills the gaps;
 *   - the operator named a record and the resolver confirmed it is the one on
 *     screen ("the Garcia job" on Garcia's page) → the page fills the gaps;
 *   - the operator named anything else, or something the resolver could not
 *     confirm → the page is ignored, and the normal resolver/clarification
 *     path runs exactly as before. A name that failed to resolve is never
 *     swapped for the record on screen.
 */

import { z } from 'zod';
import type { CustomerRepository } from '../../customers/customer';
import type { JobRepository } from '../../jobs/job';
import type { InvoiceRepository } from '../../invoices/invoice';
import type { EstimateRepository } from '../../estimates/estimate';
import type { AppointmentRepository } from '../../appointments/appointment';
import { findDocumentNumbers } from './document-number';
import { CUSTOMER_SCOPED_LOOKUP_INTENTS } from '../orchestration/classifier-profile';
import type { IntentType } from '../orchestration/intent-classifier';

export const PAGE_ENTITY_TYPES = ['job', 'customer', 'estimate', 'invoice', 'appointment'] as const;
export type PageEntityType = (typeof PAGE_ENTITY_TYPES)[number];

// The id is checked in loadPageContext, not here: a context the schema drops
// is one the route never hears about, and "this job" would then quietly mean
// every job. Kept bounded so a junk body stays cheap.
export const pageContextSchema = z.object({
  entityType: z.enum(PAGE_ENTITY_TYPES),
  entityId: z.string().trim().min(1).max(200),
});

const isUuid = (value: string): boolean => z.string().uuid().safeParse(value).success;
export type PageContext = z.infer<typeof pageContextSchema>;

/** The page's record, verified, as the payload ids it can fill. */
export interface LoadedPageContext {
  context: PageContext;
  ids: Record<string, string>;
  /** What the operator sees it called, for the reply ("Garcia – AC not cooling"). */
  label: string;
  /** The page record's own number (JOB-0081, INV-0042, EST-0007), when it has one. */
  documentNumber?: string;
}

export interface PageContextRepos {
  customerRepo?: Pick<CustomerRepository, 'findById'>;
  jobRepo?: Pick<JobRepository, 'findById'>;
  invoiceRepo?: Pick<InvoiceRepository, 'findById'>;
  estimateRepo?: Pick<EstimateRepository, 'findById'>;
  appointmentRepo?: Pick<AppointmentRepository, 'findById'>;
}

/**
 * Re-read the page's record tenant-scoped and expand it to the ids a draft can
 * use (an invoice page also names its job and customer). Failure-soft: any
 * missing repo, missing row or error returns undefined and the turn runs
 * without screen context.
 */
export async function loadPageContext(
  repos: PageContextRepos,
  tenantId: string,
  context: PageContext,
): Promise<LoadedPageContext | undefined> {
  try {
    const { entityType, entityId } = context;
    if (!isUuid(entityId)) return undefined;
    if (entityType === 'customer') {
      const customer = await repos.customerRepo?.findById(tenantId, entityId);
      if (!customer) return undefined;
      return { context, ids: { customerId: customer.id }, label: customer.displayName };
    }

    let jobId: string;
    let ids: Record<string, string>;
    let documentLabel: string | undefined;
    if (entityType === 'job') {
      jobId = entityId;
      ids = {};
    } else if (entityType === 'invoice') {
      const invoice = await repos.invoiceRepo?.findById(tenantId, entityId);
      if (!invoice) return undefined;
      jobId = invoice.jobId;
      ids = { invoiceId: invoice.id };
      documentLabel = invoice.invoiceNumber;
    } else if (entityType === 'estimate') {
      const estimate = await repos.estimateRepo?.findById(tenantId, entityId);
      if (!estimate) return undefined;
      jobId = estimate.jobId;
      ids = { estimateId: estimate.id };
      documentLabel = estimate.estimateNumber;
    } else {
      const appointment = await repos.appointmentRepo?.findById(tenantId, entityId);
      if (!appointment) return undefined;
      jobId = appointment.jobId;
      ids = { appointmentId: appointment.id };
    }

    const job = await repos.jobRepo?.findById(tenantId, jobId);
    if (!job) {
      // A job page needs its job; a document page can still stand on its own id.
      if (entityType === 'job' || !documentLabel) return undefined;
      return { context, ids, label: documentLabel, documentNumber: documentLabel };
    }
    ids = { ...ids, jobId: job.id, customerId: job.customerId };
    const customer = await repos.customerRepo?.findById(tenantId, job.customerId);
    const jobLabel = [customer?.displayName, job.summary].filter(Boolean).join(' – ') || job.jobNumber;
    const documentNumber = entityType === 'job' ? job.jobNumber : documentLabel;
    return {
      context,
      ids,
      label: documentLabel ? `${documentLabel} (${jobLabel})` : jobLabel,
      ...(documentNumber ? { documentNumber } : {}),
    };
  } catch {
    return undefined;
  }
}

/**
 * The classifier fields that carry the operator's own name for a record. A
 * technician name is not here on purpose: naming who does the work says
 * nothing about which customer or job it is for.
 */
const RECORD_REFERENCE_FIELDS = [
  'customerName',
  'jobReference',
  'appointmentReference',
  'leadReference',
] as const;

/**
 * Which reference field names the record each key points at. When the
 * operator named that record explicitly and the resolver did not confirm it,
 * the page must not fill the key: "the Garcia water heater job" on the page of
 * Garcia's AC job is a different job, even though the customer matches.
 */
const REFERENCE_FIELDS_BY_KEY: Readonly<Record<string, readonly string[]>> = {
  customerId: ['customerName'],
  jobId: ['jobReference'],
  invoiceId: ['jobReference'],
  estimateId: ['jobReference'],
  appointmentId: ['appointmentReference'],
};

/** Words that point at a record without naming one. */
const DEICTIC_REFERENCE_RE =
  /^(?:(?:this|that|the|current|same)\s+(?:one|job|customer|client|invoice|bill|estimate|quote|appointment|visit|booking|guy|lady|house|place)|it|here|them|they|their|theirs|him|his|he|her|hers|she|this|that|our customer|a customer|customer)$/i;

/** A reference that points rather than names ("this job", "them"). */
export function isDeicticReference(value: string): boolean {
  return DEICTIC_REFERENCE_RE.test(value.trim().replace(/[.!?,]+$/g, '').trim());
}

/**
 * Intents that CREATE the kind of record a key names must never inherit that
 * key from the screen: "new customer Maria Alvarez" on Garcia's page is not
 * about Garcia.
 */
const KEYS_NEVER_FILLED_BY_INTENT: Readonly<Record<string, readonly string[]>> = {
  create_customer: ['customerId', 'jobId', 'invoiceId', 'estimateId', 'appointmentId'],
  create_job: ['jobId', 'invoiceId', 'estimateId', 'appointmentId'],
  create_booking: ['jobId', 'invoiceId', 'estimateId', 'appointmentId'],
  convert_lead: ['customerId', 'jobId', 'invoiceId', 'estimateId', 'appointmentId'],
  mark_lead_lost: ['customerId', 'jobId', 'invoiceId', 'estimateId', 'appointmentId'],
};

export interface PageContextMergeInput {
  intent: string;
  /** Classifier-extracted entities for this turn (or chain segment). */
  entities: Record<string, unknown> | undefined;
  /** The operator's words for this turn (or chain segment). */
  text: string;
  /** Ids the resolver (and literal number/UUID readers) already verified. */
  resolvedIds: Readonly<Record<string, string>>;
  ambiguousRefKeys: readonly string[];
  page: Pick<LoadedPageContext, 'ids'>;
}

export interface PageContextMergeResult {
  ids: Record<string, string>;
  ambiguousRefKeys: string[];
  /** The keys the page filled; empty when the page was not used. */
  filledKeys: string[];
}

function isExplicitReference(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0 && !isDeicticReference(value);
}

const LITERAL_UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i;

/** See the module doc for the rule. Pure. */
export function mergePageContextIds(input: PageContextMergeInput): PageContextMergeResult {
  const { intent, entities, text, resolvedIds, ambiguousRefKeys, page } = input;
  const unchanged: PageContextMergeResult = {
    ids: { ...resolvedIds },
    ambiguousRefKeys: [...ambiguousRefKeys],
    filledKeys: [],
  };

  // Anything the resolver verified that disagrees with the page means the
  // operator is talking about a different record.
  for (const [key, id] of Object.entries(resolvedIds)) {
    if (key in page.ids && page.ids[key] !== id) return unchanged;
  }

  const namedSomething =
    RECORD_REFERENCE_FIELDS.some((field) => isExplicitReference(entities?.[field])) ||
    findDocumentNumbers(text).length > 0 ||
    LITERAL_UUID_RE.test(text);
  if (namedSomething) {
    const confirmsPage = Object.entries(resolvedIds).some(([key, id]) => page.ids[key] === id);
    if (!confirmsPage) return unchanged;
  }

  const blocked = new Set(KEYS_NEVER_FILLED_BY_INTENT[intent] ?? []);
  const ids = { ...resolvedIds };
  const filledKeys: string[] = [];
  for (const [key, id] of Object.entries(page.ids)) {
    if (blocked.has(key) || key in ids) continue;
    if ((REFERENCE_FIELDS_BY_KEY[key] ?? []).some((field) => isExplicitReference(entities?.[field]))) continue;
    ids[key] = id;
    filledKeys.push(key);
  }
  return {
    ids,
    ambiguousRefKeys: ambiguousRefKeys.filter((key) => !filledKeys.includes(key)),
    filledKeys,
  };
}

/** Words in a question that point at the customer on screen without naming one. */
const POINTS_AT_CUSTOMER_RE =
  /\b(?:(?:this|that|the same)\s+(?:customer|client|guy|lady)|she|he|they|her|him|them|his|their)\b/i;
const POINTS_AT_JOB_RE = /\b(?:this|that|the same)\s+job\b/i;
/** Words that point at the page's own record, by the page's type. */
const POINTS_AT_PAGE_RECORD_RE: Readonly<Record<PageEntityType, RegExp>> = {
  customer: POINTS_AT_CUSTOMER_RE,
  job: POINTS_AT_JOB_RE,
  invoice: /\b(?:this|that|the same)\s+(?:invoice|bill)\b/i,
  estimate: /\b(?:this|that|the same)\s+(?:estimate|quote)\b/i,
  appointment: /\b(?:this|that|the same)\s+(?:appointment|visit|booking)\b/i,
};

/** The note target a document or customer page stands for. A job or appointment page keeps the job default. */
const NOTE_TARGET_BY_PAGE: Partial<Record<PageEntityType, 'customer' | 'invoice' | 'estimate'>> = {
  customer: 'customer',
  invoice: 'invoice',
  estimate: 'estimate',
};

export interface PageNoteTargetInput {
  intent: string;
  entities: Record<string, unknown> | undefined;
  text: string;
  page: { context: Pick<PageContext, 'entityType'> };
  /** The keys the page filled (`mergePageContextIds`). */
  filledKeys: readonly string[];
}

/**
 * The note target kind for "add a note: they disputed this charge" spoken on
 * an invoice, estimate or customer page. The note handler defaults to the job,
 * and a document page also fills its job, so without this the note lands on
 * the job while the reply says the open invoice was used. Only when the page
 * filled the record itself, the classifier named no kind, and the words do not
 * point past the page ("this job", or "her" on a document). Pure.
 */
export function pageNoteTargetKind(input: PageNoteTargetInput): string | undefined {
  const { intent, entities, text, page, filledKeys } = input;
  if (intent !== 'add_note') return undefined;
  const named = entities?.noteTargetKind;
  if (typeof named === 'string' && named.trim().length > 0) return undefined;
  const kind = NOTE_TARGET_BY_PAGE[page.context.entityType];
  if (!kind || !filledKeys.includes(`${kind}Id`)) return undefined;
  if (POINTS_AT_JOB_RE.test(text) || (kind !== 'customer' && POINTS_AT_CUSTOMER_RE.test(text))) return undefined;
  return kind;
}

/** The lookup that asks about a page's own record. */
const DOCUMENT_LOOKUP_BY_TYPE: Partial<Record<PageEntityType, string>> = {
  job: 'lookup_jobs',
  invoice: 'lookup_invoices',
  estimate: 'lookup_estimates',
};

export interface PageLookupInput {
  intent: string;
  entities: Record<string, unknown> | undefined;
  text: string;
  page: Pick<LoadedPageContext, 'ids' | 'documentNumber'> & { context: Pick<PageContext, 'entityType'> };
}

export interface PageLookupIds {
  customerId?: string;
  jobId?: string;
  /** The page record's own number, for "is this invoice paid?" on that invoice. */
  documentNumber?: string;
  /** The visit on screen, for "when is this appointment?" on that visit. */
  appointmentId?: string;
}

/**
 * The page ids a read-only lookup may use: "what invoices does this customer
 * have?" on Garcia's page is about Garcia, and "is this invoice paid?" on
 * INV-0042 is about INV-0042. Stricter than drafting: a lookup that names no
 * record has a tenant-wide reading ("what invoices are open?"), so the page
 * fills a key only when the operator pointed at it, either in the extracted
 * reference ("this job") or in their words ("what does she owe?"). A named
 * record, a document number or a literal UUID always wins. Pure.
 */
export function pageLookupIds(input: PageLookupInput): PageLookupIds {
  const { intent, entities, text, page } = input;
  if (findDocumentNumbers(text).length > 0 || LITERAL_UUID_RE.test(text)) return {};

  const points = (field: string, re: RegExp): boolean => {
    const value = entities?.[field];
    if (typeof value === 'string' && value.trim().length > 0) return isDeicticReference(value);
    return re.test(text);
  };
  // Pointing at the record on screen ("this invoice") points at its customer
  // and job too, since a document page expands to both.
  const pointsAtPage = POINTS_AT_PAGE_RECORD_RE[page.context.entityType].test(text);

  // A record the operator named outright ("Maria Alvarez", "the Khan
  // install") is theirs to resolve, even in a question that also says "this".
  const out: PageLookupIds = {};
  if (
    page.ids.customerId &&
    CUSTOMER_SCOPED_LOOKUP_INTENTS.has(intent as IntentType) &&
    !isExplicitReference(entities?.customerName) &&
    (pointsAtPage || points('customerName', POINTS_AT_CUSTOMER_RE))
  ) {
    out.customerId = page.ids.customerId;
  }
  if (
    page.ids.jobId &&
    !isExplicitReference(entities?.jobReference) &&
    (pointsAtPage || points('jobReference', POINTS_AT_JOB_RE))
  ) {
    out.jobId = page.ids.jobId;
  }
  // Only a question about that kind of record reads it by number: "what
  // invoices are on this job?" lists the job's invoices, not the job's status.
  if (page.documentNumber && pointsAtPage && DOCUMENT_LOOKUP_BY_TYPE[page.context.entityType] === intent) {
    out.documentNumber = page.documentNumber;
  }
  // A visit has no number, so its own id stands in: "when is this
  // appointment?" is about that visit, not the customer's next one.
  if (page.ids.appointmentId && pointsAtPage && intent === 'lookup_appointments') {
    out.appointmentId = page.ids.appointmentId;
  }
  return out;
}

const NOUN_BY_TYPE: Record<PageEntityType, string> = {
  job: 'job',
  customer: 'customer',
  estimate: 'estimate',
  invoice: 'invoice',
  appointment: 'appointment',
};

/**
 * True when the words point at the record on screen or at what it expands
 * to: "this invoice" on an invoice page, "her" on any page, and "this job" on
 * any page but a customer's (a document page names its job). Pure.
 */
export function pointsAtPageRecord(entityType: PageEntityType, text: string): boolean {
  return (
    POINTS_AT_PAGE_RECORD_RE[entityType].test(text) ||
    POINTS_AT_CUSTOMER_RE.test(text) ||
    (entityType !== 'customer' && POINTS_AT_JOB_RE.test(text))
  );
}

/**
 * The answer when the words point at the page but its record could not be
 * read (deleted, another tenant's, a bad id, or a failed read). Asks rather
 * than answering for every record, which is what "this job" would otherwise
 * quietly become.
 */
export function pageUnavailableReply(entityType: PageEntityType): string {
  const noun = NOUN_BY_TYPE[entityType];
  return `I couldn't open the ${noun} you were viewing, so I can't tell which ${noun} you mean. Which one is it?`;
}

/** The reply line that makes a screen-context pick visible. */
export function pageContextNote(page: LoadedPageContext): string {
  return `I used the ${NOUN_BY_TYPE[page.context.entityType]} you had open: ${page.label}.`;
}

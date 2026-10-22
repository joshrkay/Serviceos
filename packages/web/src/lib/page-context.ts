/**
 * The record on screen when a voice or chat turn starts, so the assistant can
 * read "this job" / "her" / "that invoice" as that record. The server re-reads
 * it tenant-scoped and only uses it when the operator's words don't name
 * something else (packages/api/src/ai/resolution/page-context.ts).
 */

export type PageEntityType = 'job' | 'customer' | 'estimate' | 'invoice' | 'appointment';

export interface PageContext {
  entityType: PageEntityType;
  entityId: string;
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

// Detail routes in routes.ts, including their sub-pages (/jobs/:id/photos,
// /customers/:id/edit). `/jobs/new` and friends never match: no uuid.
const ROUTES: Array<[RegExp, PageEntityType]> = [
  [new RegExp(`^/jobs/(${UUID})(?:/|$)`, 'i'), 'job'],
  [new RegExp(`^/customers/(${UUID})(?:/|$)`, 'i'), 'customer'],
  [new RegExp(`^/estimates/(${UUID})(?:/|$)`, 'i'), 'estimate'],
  [new RegExp(`^/invoices/(${UUID})(?:/|$)`, 'i'), 'invoice'],
  [new RegExp(`^/appointments/(${UUID})(?:/|$)`, 'i'), 'appointment'],
];

export function pageContextFromPath(pathname: string): PageContext | null {
  for (const [re, entityType] of ROUTES) {
    const match = pathname.match(re);
    if (match) return { entityType, entityId: match[1].toLowerCase() };
  }
  return null;
}

/** `?ctx=` wire form for the hand-off to /assistant. */
export function encodePageContext(context: PageContext): string {
  return `${context.entityType}:${context.entityId}`;
}

export function decodePageContext(value: string | null): PageContext | null {
  const match = value?.match(new RegExp(`^(job|customer|estimate|invoice|appointment):(${UUID})$`, 'i'));
  return match ? { entityType: match[1].toLowerCase() as PageEntityType, entityId: match[2].toLowerCase() } : null;
}

/** The assistant URL a voice turn hands off to, carrying the open record. */
export function assistantHandoffUrl(
  text: string,
  context: PageContext | null,
  opts: { spoken?: boolean } = {},
): string {
  const params = new URLSearchParams({ q: text });
  if (context) params.set('ctx', encodePageContext(context));
  // A spoken turn is sent as one (inputMode 'voice'), so the server's
  // voice-approval guard applies to it exactly as it does in conversation mode.
  if (opts.spoken) params.set('via', 'voice');
  return `/assistant?${params.toString()}`;
}

const NOUN: Record<PageEntityType, string> = {
  job: 'job',
  customer: 'customer',
  estimate: 'estimate',
  invoice: 'invoice',
  appointment: 'appointment',
};

/** Chip copy for the composer while a page context is attached. */
export function pageContextChipLabel(context: PageContext): string {
  return `About the ${NOUN[context.entityType]} you were viewing`;
}

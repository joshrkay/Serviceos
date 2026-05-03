import type { Lead } from './lead';

/**
 * Build the audit-metadata fragment for source-attribution events.
 *
 * Used by lead.created, lead.converted, customer.created_from_lead so
 * the audit log carries enough context to answer "where did this come
 * from" without joining back to leads.
 *
 * Returns a plain object that callers spread into the parent metadata.
 * Keys are present only when the corresponding lead column is set, so
 * the resulting JSONB stays compact.
 */
export function buildAttributionMetadata(
  lead: Pick<Lead, 'utmSource' | 'utmMedium' | 'utmCampaign'>,
): Record<string, string> {
  const meta: Record<string, string> = {};
  if (lead.utmSource) meta.utmSource = lead.utmSource;
  if (lead.utmMedium) meta.utmMedium = lead.utmMedium;
  if (lead.utmCampaign) meta.utmCampaign = lead.utmCampaign;
  return meta;
}

/**
 * Audit-metadata fragment for entities that inherited an originating
 * lead (jobs, invoices). Returns `undefined` when no lead was set so
 * the audit row is unchanged from pre-attribution behavior.
 */
export function buildOriginationMetadata(
  originatingLeadId: string | undefined,
): { originatingLeadId: string } | undefined {
  return originatingLeadId ? { originatingLeadId } : undefined;
}

/**
 * Canonical entity terminology — the single source of truth for how
 * ServiceOS refers to its core CRM entities, and for how a tenant's own
 * vocabulary ("Quote" for Estimate, "Project" for Job, "Visit" for
 * Appointment) maps back onto those canonical entities.
 *
 * Story 2.5 (Terminology Flexibility) needs two directions:
 *
 *  - render direction — `resolveEntityLabel` / `resolveEntityLabels`:
 *    canonical key → the label the tenant wants to see, so the captured
 *    labels can "render everywhere in the UI and in agent speech". Falls
 *    back to the platform default when a tenant hasn't overridden a term.
 *
 *  - capture direction — `canonicalEntityForTerm`: a free-text word the
 *    tenant used → the canonical entity key it denotes, so "captured
 *    labels map to canonical entities under the hood". Drives synonym
 *    normalization (bid / quote / proposal all resolve to the estimate
 *    entity) without a silent guess at the call site.
 *
 * These keys mirror the entity-label keys persisted in
 * `tenant_settings.terminology_preferences` and validated by
 * `packages/api/src/settings/settings.ts`, whose
 * `ENTITY_LABEL_TERMINOLOGY_KEYS` now derives from `ENTITY_TERM_KEYS`
 * here so the two never drift.
 */

/** The canonical CRM entities a tenant may relabel. */
export const ENTITY_TERM_KEYS = [
  'jobTerm',
  'estimateTerm',
  'invoiceTerm',
  'customerTerm',
  'appointmentTerm',
  'workerTerm',
] as const;

export type EntityTermKey = (typeof ENTITY_TERM_KEYS)[number];

export interface EntityLabelDefault {
  /** Platform-default singular label, e.g. "Estimate". */
  singular: string;
  /** Platform-default plural label, e.g. "Estimates". */
  plural: string;
}

/** Platform defaults used whenever a tenant has not overridden a term. */
export const DEFAULT_ENTITY_LABELS: Record<EntityTermKey, EntityLabelDefault> = {
  jobTerm: { singular: 'Job', plural: 'Jobs' },
  estimateTerm: { singular: 'Estimate', plural: 'Estimates' },
  invoiceTerm: { singular: 'Invoice', plural: 'Invoices' },
  customerTerm: { singular: 'Customer', plural: 'Customers' },
  appointmentTerm: { singular: 'Appointment', plural: 'Appointments' },
  workerTerm: { singular: 'Technician', plural: 'Technicians' },
};

/**
 * Shape of `tenant_settings.terminology_preferences`. A flat,
 * partially-populated map of override labels — absent / blank keys mean
 * "use the platform default". Intentionally indexed by `string` (not
 * `EntityTermKey`) because the stored object can also carry non-label
 * keys such as `teamSize` / `ownerName`; the resolvers only read the
 * canonical entity keys.
 */
export type TerminologyPreferences = Partial<Record<string, string>>;

export interface ResolveLabelOptions {
  /** Return the plural form. Defaults to the singular form. */
  plural?: boolean;
}

/**
 * Minimal English pluralizer for the small set of one-word override
 * labels owners actually use (Quote, Bid, Project, Client, Visit, Tech).
 * Not a general-purpose inflector — just enough to render "Quotes" from
 * an override of "Quote" without shipping a dependency.
 */
function pluralize(word: string): string {
  // "Tech" ends in "ch" but is pronounced with a hard /k/, so it takes a
  // plain "-s" ("Techs", not "Teches"). It's one of the documented
  // override labels, so special-case it before the sibilant rule.
  if (/tech$/i.test(word)) return `${word}s`;
  if (/(?:s|x|z|ch|sh)$/i.test(word)) return `${word}es`;
  if (/[^aeiou]y$/i.test(word)) return `${word.slice(0, -1)}ies`;
  return `${word}s`;
}

/**
 * Resolve a single canonical entity to the label the tenant wants to
 * see. A non-blank override wins; otherwise the platform default is used.
 */
export function resolveEntityLabel(
  prefs: TerminologyPreferences | null | undefined,
  key: EntityTermKey,
  options: ResolveLabelOptions = {},
): string {
  const override = prefs?.[key]?.trim();
  const def = DEFAULT_ENTITY_LABELS[key];
  if (override && override.length > 0) {
    return options.plural ? pluralize(override) : override;
  }
  return options.plural ? def.plural : def.singular;
}

/**
 * Resolve the full set of canonical entities to the tenant's labels —
 * the convenient form for handing a render layer (web UI, agent prompt)
 * everything it needs in one object.
 */
export function resolveEntityLabels(
  prefs: TerminologyPreferences | null | undefined,
): Record<EntityTermKey, string> {
  const out = {} as Record<EntityTermKey, string>;
  for (const key of ENTITY_TERM_KEYS) {
    out[key] = resolveEntityLabel(prefs, key);
  }
  return out;
}

/**
 * Synonyms a tradesperson might use for each canonical entity. Lowercased
 * and matched case-insensitively. Drives `canonicalEntityForTerm` so the
 * onboarding capture path can recognize the tenant's own word.
 */
export const ENTITY_TERM_SYNONYMS: Record<EntityTermKey, readonly string[]> = {
  estimateTerm: ['estimate', 'quote', 'bid', 'proposal'],
  invoiceTerm: ['invoice', 'bill', 'statement'],
  jobTerm: ['job', 'project', 'ticket', 'work order', 'workorder'],
  customerTerm: ['customer', 'client', 'homeowner'],
  appointmentTerm: ['appointment', 'visit', 'service call', 'booking'],
  workerTerm: ['technician', 'tech', 'pro', 'crew', 'worker', 'installer'],
};

const SYNONYM_LOOKUP: ReadonlyMap<string, EntityTermKey> = (() => {
  const m = new Map<string, EntityTermKey>();
  for (const key of ENTITY_TERM_KEYS) {
    for (const syn of ENTITY_TERM_SYNONYMS[key]) m.set(syn.toLowerCase(), key);
  }
  return m;
})();

/**
 * Map a free-text word the tenant used to the canonical entity key it
 * denotes, or `null` when it matches no known entity. Case- and
 * whitespace-insensitive, and tolerant of a trailing plural "s" so
 * "quotes" resolves like "quote". Returning `null` (rather than a guess)
 * keeps an unknown term from silently binding to the wrong entity.
 */
export function canonicalEntityForTerm(term: string): EntityTermKey | null {
  const normalized = term.trim().toLowerCase();
  if (!normalized) return null;
  const direct = SYNONYM_LOOKUP.get(normalized);
  if (direct) return direct;
  const singular = normalized.endsWith('s') ? normalized.slice(0, -1) : normalized;
  return SYNONYM_LOOKUP.get(singular) ?? null;
}

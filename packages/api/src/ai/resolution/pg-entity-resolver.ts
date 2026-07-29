/**
 * P8-001 — PgEntityResolver
 *
 * Postgres-backed entity resolver using pg_trgm similarity() for fuzzy
 * matching. Migration 051_p8_entity_resolution_indexes creates the GIN
 * trigram indexes on customers.name, jobs.title, invoices.invoice_number,
 * and a btree index on appointments.scheduled_for.
 *
 * Resolution thresholds:
 *   τ_ent = 0.80             — 1 candidate at/above → `resolved`
 *                            — 2+ at/above → `ambiguous`
 *   τ_ent_confirm_low = 0.60 — 1 candidate in [0.60, 0.80) → `low_confidence`
 *                              (voice-confirmed before use, never auto-acted)
 *                            — 2+ in that band → `ambiguous`
 *   below τ_ent_confirm_low  — `not_found`
 *
 * All queries are scoped to tenantId for tenant isolation.
 */

import { Pool } from 'pg';
import { withTenantConnection } from '../../db/tenant-transaction';
import { resolveDateTime } from '../scheduling/resolve-datetime';
import { isRuntimeTimezone } from '../../shared/timezone';
import {
  EntityCandidate,
  EntityKind,
  EntityResolver,
  EntityResolverResult,
  TAU_ENT,
  TAU_ENT_CONFIRM_LOW,
} from './entity-resolver';

/** Minimum similarity score to even consider a candidate (pre-filter). */
const SIMILARITY_PREFILTER = 0.3;

/**
 * Most jobs a one-tap picker may honestly offer. Matches the ceiling the
 * appointment fallbacks below already use; `resolveJob` reads one extra row to
 * detect overflow.
 */
const MAX_JOB_CANDIDATES = 5;

/**
 * Most estimates a one-tap picker may honestly offer. Same ceiling and same
 * reasoning as `MAX_JOB_CANDIDATES`; `resolveEstimate` reads one extra row to
 * detect overflow.
 */
const MAX_ESTIMATE_CANDIDATES = 5;

/**
 * Most technicians a one-tap picker may honestly offer. Same ceiling and same
 * reasoning as `MAX_JOB_CANDIDATES` / `MAX_ESTIMATE_CANDIDATES`: since
 * `TECH_SCORE_EXPR` scores on first name too, a shared first name (or
 * surname) matches EVERY technician who has it at 1.000, so a shop with six
 * Carloses is ordinary, not exotic, and `LIMIT 5` would hand back an
 * arbitrary five as a picker that need not even contain the right one.
 * `resolveTechnician` reads one extra row to detect overflow.
 */
const MAX_TECHNICIAN_CANDIDATES = 5;

/**
 * B4.7 / B5.3 — an appointment reference is treated as a CLOCK TIME only when
 * it contains an explicit time-of-day token. Deliberately digit-bearing and
 * narrow, for one reason: the alternative (handing every reference to
 * chrono-node) makes a customer surname a scheduling term the moment it
 * collides with a month or weekday — "the March job", "the Sunday job", "the
 * May job" all parse as dates. None of them contain a clock token, so none of
 * them reach the temporal branch.
 *
 * Covered: "2pm", "2 p.m.", "2:30", "2:30pm", "at 2", "@2", "noon",
 * "midnight" — which is every phrasing the classifier's own
 * `appointmentReference` examples produce ("tomorrow's 10am", "the 2pm").
 */
const CLOCK_TIME_PATTERN =
  /\b\d{1,2}\s*(?::\s*\d{2})?\s*[ap]\.?\s?m\.?\b|\b\d{1,2}\s*:\s*\d{2}\b|\b(?:at|@)\s*\d{1,2}(?:\s*:\s*\d{2})?\b|\bnoon\b|\bmidnight\b/i;

/**
 * How far from the STATED time an appointment may start and still be the one
 * the caller meant. Fifteen minutes absorbs the ordinary slop between "the
 * 2pm" and a slot actually booked at 2:05, without ever reaching the
 * neighbouring half-hour slot (a 1:30 or a 2:30 is a different appointment and
 * the caller would have said so). Anything inside the window that is not
 * unique stays a one-tap clarification, never a guess; anything outside it
 * falls through to the pre-existing branches rather than being answered.
 */
const CLOCK_TIME_TOLERANCE_MS = 15 * 60 * 1000;

/** True when the reference states a time of day at all. See CLOCK_TIME_PATTERN. */
function hasClockTime(reference: string): boolean {
  return CLOCK_TIME_PATTERN.test(reference);
}

/** Bare clock words left over once punctuation is flattened to spaces. */
const CLOCK_WORDS = new Set(['am', 'pm', 'at', 'noon', 'midnight', 'oclock']);

/**
 * The name token with CLOCK tokens removed, for matching against a person's
 * name. "the 2pm Garcia job" reduces to "2pm garcia" under
 * `extractNameLikeToken` (which strips filler, not times), and a customer's
 * name is never going to word-match a needle carrying "2pm" — measured,
 * `strict_word_similarity('2pm garcia','Jamie Garcia')` = 0.636, i.e. below
 * τ_ent and thus a low_confidence the appointment branch folds into not_found.
 * Against the clean needle it is 1.000.
 *
 * ONLY clock tokens are removed, and ONLY for the customer-name comparison:
 *
 *   - Day words ("tomorrow", weekday and month names) are deliberately left
 *     alone. They are real surnames — May, March, Friday — and dropping them
 *     would make a named reference match the wrong person.
 *   - `extractNameLikeToken` itself is untouched, so the named-vs-NAMELESS
 *     decision that guards the SCH-03 tenant-wide fallback (the AC-3 defect)
 *     behaves exactly as before. Stripping there could turn "tomorrow's
 *     appointment" into a NAMELESS reference and answer it with today's.
 *   - If nothing survives (the reference was ALL clock), the original token is
 *     used, so this can never match less than before.
 */
function stripClockTokens(nameToken: string): string {
  const kept = nameToken
    .split(/\s+/)
    .filter((w) => w.length > 0 && !CLOCK_WORDS.has(w) && !/^\d+(?:am|pm)?$/.test(w));
  return kept.length > 0 ? kept.join(' ') : nameToken;
}

/**
 * B5.3 (AC-3) — filler words stripped from an appointment reference to
 * decide whether ANYTHING nameable is left. "the upcoming appointment" /
 * "the appointment for that job" reduce to nothing (genuinely nameless —
 * SCH-03's fallback still applies); "the Johnson job" / "the Garcia
 * appointment" reduce to "johnson" / "garcia" (a name — never allowed to
 * fall through to the tenant-wide soonest-first fallback un-searched).
 *
 * Deliberately conservative (a short, hand-picked stopword list rather than
 * a POS tagger): false negatives here just mean a name-bearing reference
 * gets treated as nameless and takes the pre-existing SCH-03 path, which is
 * always safe (it either resolves an unambiguous tenant-wide fallback or
 * says not_found/ambiguous). False positives — treating a genuinely nameless
 * phrase as name-bearing — are the ones that matter, and every word in this
 * list is a real filler word that appears in the corpus's nameless phrasing
 * ("the appointment for that job", "the upcoming visit").
 */
const APPOINTMENT_REFERENCE_STOPWORDS = new Set([
  'the', 'a', 'an', 'my', 'our', 'that', 'this', 'it', 'its',
  'next', 'upcoming', 'coming', 'soon',
  'appointment', 'appointments', 'visit', 'visits', 'job', 'jobs',
  'for', 'to', 'on', 'of', 'with', 'about', 'from',
  'instead', 'me', 'us',
]);

/**
 * Returns the reference's remaining word(s) once stopwords are stripped, or
 * `undefined` when nothing is left (a genuinely nameless reference). Used
 * ONLY to decide whether `resolveAppointment` may fall through to the
 * nameless tenant-wide fallback — never itself used as a search string (the
 * ORIGINAL reference still drives the actual job-name lookup, so trigram
 * similarity sees full context, not a stripped fragment).
 */
function extractNameLikeToken(reference: string): string | undefined {
  const words = reference
    .toLowerCase()
    .replace(/[^a-z0-9\s']/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const nameWords = words.filter((w) => !APPOINTMENT_REFERENCE_STOPWORDS.has(w));
  return nameWords.length > 0 ? nameWords.join(' ') : undefined;
}

/**
 * Document nouns an operator hangs on a SPOKEN estimate reference: "the Garcia
 * estimate", "the Garcia quote". Stripped ONLY to build the customer-name
 * needle inside `resolveEstimate`.
 *
 * Deliberately a SEPARATE set from APPOINTMENT_REFERENCE_STOPWORDS rather than
 * more entries in it. That set also decides whether an APPOINTMENT reference
 * is nameless enough to reach the SCH-03 tenant-wide "soonest upcoming"
 * fallback, and "cancel the estimate appointment" (a real phrase — the visit
 * where you go quote the work) must not become a nameless reference answered
 * with an unrelated appointment. That is the AC-3 defect exactly, so the
 * shared set is left untouched and this one is scoped to the estimate path.
 *
 * WHY THE STRIP IS LOAD-BEARING, measured on pgvector/pgvector:pg16 with
 * pg_trgm against a customer named 'Marisol Garcia' (floor: 0.60):
 *   similarity('Marisol Garcia','the Garcia estimate')             = 0.250
 *   strict_word_similarity('the Garcia estimate','Marisol Garcia') = 0.350
 *   strict_word_similarity('garcia estimate','Marisol Garcia')     = 0.438
 *   strict_word_similarity('garcia','Marisol Garcia')              = 1.000
 * The middle row is the trap: a traversal built on the stopword-stripped
 * needle ALONE still leaves the document noun in it, still scores under
 * τ_ent_confirm_low, and still answers `not_found` — the fix would exist and
 * do nothing. Only the fully stripped needle clears the floor.
 *
 * Safe on the other side, same measurement run: a customer who merely shares
 * a prefix stays out — strict_word_similarity('garcia','Garciaparra
 * Landscaping') = 0.462, below the confirm floor. No threshold is moved.
 */
const ESTIMATE_DOC_STOPWORDS = new Set([
  'estimate', 'estimates', 'quote', 'quotes', 'bid', 'bids', 'proposal', 'proposals',
]);

/**
 * The person-name needle for an estimate reference, or '' when the reference
 * names nobody ("the estimate", "that quote").
 *
 * '' is returned rather than falling back to the original phrase on purpose:
 * `strict_word_similarity('', <any name>)` = 0 (measured), so a nameless
 * reference matches NOTHING instead of matching every customer in the tenant.
 * Same posture as `resolveJob`'s empty-needle case.
 */
function estimateNameNeedle(reference: string): string {
  const base = extractNameLikeToken(reference);
  if (!base) return '';
  const kept = base
    .split(/\s+/)
    .filter((w) => w.length > 0 && !ESTIMATE_DOC_STOPWORDS.has(w));
  return kept.length > 0 ? kept.join(' ') : '';
}

// Technicians are named the way customers are: an operator says "assign
// CARLOS", not "assign Carlos Vega". Whole-string similarity cannot see that —
// `similarity('Carlos Vega','Carlos')` = 0.583, under TAU_ENT_CONFIRM_LOW, so
// the reference resolved to nothing and the reassign proposal gated on
// `toTechnicianId`. This was the LAST resolution path still on plain
// similarity, and it was masked by every technician fixture in the repo
// speaking a full name — including B5.3's, whose utterance says "Carlos"
// while its fixture fed "Carlos Vega", contradicting the classifier launch
// fixture for the very same sentence.
//
// Same shape as `resolveCustomer`: GREATEST keeps whole-string similarity so
// nothing that resolved before changes score, and the STRICT variant keeps a
// partial first name out — `strict_word_similarity('carl','Carlos Vega')` =
// 0.500, under the floor. Two technicians named Carlos both score 1.000 and
// become an `ambiguous` clarification rather than a guess.
const TECH_NAME_EXPR = `TRIM(COALESCE(first_name,'') || ' ' || COALESCE(last_name,''))`;
const TECH_SCORE_EXPR = `GREATEST(
             similarity(${TECH_NAME_EXPR}, $2),
             strict_word_similarity($2, ${TECH_NAME_EXPR})
           )`;

export class PgEntityResolver implements EntityResolver {
  constructor(private readonly pool: Pool) {}

  async resolve(input: {
    tenantId: string;
    reference: string;
    kind: EntityKind;
    jobId?: string;
  }): Promise<EntityResolverResult> {
    const { tenantId, reference, kind, jobId } = input;

    // Guard: empty/null/whitespace-only references are not resolvable.
    if (!reference || reference.trim() === '') {
      return { kind: 'skipped' };
    }

    switch (kind) {
      case 'customer':
        return this.resolveCustomer(tenantId, reference);
      case 'job':
        return this.resolveJob(tenantId, reference);
      case 'invoice':
        return this.resolveInvoice(tenantId, reference);
      case 'appointment':
        return this.resolveAppointment(tenantId, reference, jobId);
      case 'estimate':
        return this.resolveEstimate(tenantId, reference);
      case 'technician':
        return this.resolveTechnician(tenantId, reference);
      default:
        return { kind: 'skipped' };
    }
  }

  // ---------------------------------------------------------------------------
  // Private resolution methods
  // ---------------------------------------------------------------------------

  private async resolveCustomer(
    tenantId: string,
    reference: string,
  ): Promise<EntityResolverResult> {
    // Schema columns are display_name / primary_phone (the trigram index from
    // migration 051 is on display_name). Archived customers are excluded —
    // they must not become invoice/estimate targets.
    //
    // The score is the SAME two-function GREATEST as the job path (see
    // `resolveJob` for the full reasoning and measurements), and for the same
    // reason: `similarity()` is whole-string, so the way a
    // person actually names a customer out loud — a surname — scores below
    // τ_ent_confirm_low against a full display name and returned `not_found`.
    // Measured on pgvector/pgvector:pg16 with pg_trgm:
    //   similarity('Khan Household','Khan')             = 0.333
    //   similarity('Aisha Khan','Khan')                 = 0.455   (floor: 0.60)
    //   strict_word_similarity('Khan','Khan Household') = 1.000
    //   strict_word_similarity('Khan','Aisha Khan')     = 1.000
    // This is the path `CUSTOMER_REF_INTENTS` feeds, so it is what B8.10's
    // `send_estimate_nudge` traversal stands on: before this, "nudge the Khan
    // estimate" resolved no customer at all and the whole chain stopped. Its
    // integration test only passed because the utterance it spoke was the
    // customer's FULL display name, "Khan Household", which nobody says.
    //
    // Whole-string similarity is KEPT in the GREATEST, so every reference that
    // resolved before still resolves at the same score — a strictly additive
    // change with no threshold moved. The strict variant (not `word_similarity`)
    // is what keeps it safe on the other side: a shared prefix scores
    // strict_word_similarity('khan','Khanna Enterprises') = 0.500 and
    // ('smith','Smithson Plumbing') = 0.500, both under the confirm floor, and
    // a multi-word near-miss stays low too — ('Bob Smith','Bob Jones') = 0.400.
    const SCORE_EXPR = `GREATEST(
             similarity(display_name, $2),
             strict_word_similarity($2, display_name),
             COALESCE(strict_word_similarity($2, company_name), 0)
           )`;
    const rows = await withTenantConnection(this.pool, tenantId, (client) =>
      client
        .query<{
          id: string;
          display_name: string;
          primary_phone: string | null;
          score: number;
        }>(
          `SELECT id, display_name, primary_phone, ${SCORE_EXPR} AS score
             FROM customers
            WHERE tenant_id = $1
              AND is_archived = false
              AND ${SCORE_EXPR} > $3
            ORDER BY score DESC
            LIMIT 5`,
          [tenantId, reference, SIMILARITY_PREFILTER],
        )
        .then((r) => r.rows),
    );

    const candidates: EntityCandidate[] = rows.map((row) => ({
      id: row.id,
      kind: 'customer' as EntityKind,
      label: row.display_name,
      hint: row.primary_phone ?? undefined,
      score: Number(row.score),
    }));

    return this.toResult(candidates, reference);
  }

  /**
   * Resolve a job by its own summary OR by the name of the CUSTOMER it is for.
   *
   * `jobs.summary` (the trigram index from migration 051 is on jobs.summary —
   * there is no `title` column) is operator-authored free text describing the
   * WORK: "AC repair". But "the Garcia job" names the PERSON, who lives on
   * `jobs.customer_id → customers`. Matching only the summary returned
   * not_found for every ordinarily-summarized job — the shared-resolver
   * generalization of the B5.5 en-route fix (26f2345), and the reason
   * `log_time_entry` (B6.3) and `add_note` (B7.4) failed in production on the
   * most natural phrasing there is.
   *
   * WHY TWO DIFFERENT SIMILARITY FUNCTIONS. `similarity()` is whole-string, so
   * a last-name-only reference against a full display name scores far below
   * τ_ent_confirm_low. Measured on pgvector/pgvector:pg16 with pg_trgm:
   *   similarity('Jamie Garcia','garcia')             = 0.538
   *   similarity('Jamie Garcia','the Garcia job')     = 0.400   (floor: 0.60)
   *   strict_word_similarity('garcia','Jamie Garcia') = 1.000   (τ_ent: 0.80)
   * Implementing the traversal as plain `similarity()` would have reproduced
   * the exact silent not_found it exists to fix, with extra steps.
   *
   * It is the STRICT variant, not `word_similarity`, precisely because the
   * loose one is unsafe here: word_similarity('khan','Khanna Enterprises') =
   * 0.800 and ('smith','Smithson Plumbing') = 0.833 would clear or crowd τ_ent
   * on a customer who merely SHARES A PREFIX. Forcing extent boundaries to word
   * boundaries drops those to 0.500 — below the confirm floor, so they cannot
   * resolve or even low-confidence — while real surname hits stay at 1.000.
   *
   * The customer half matches the stopword-stripped NEEDLE ("the Garcia job" →
   * "garcia"), because a word-extent match against the raw phrase means
   * nothing. The summary half deliberately still sees the ORIGINAL reference,
   * and whole-string similarity is kept inside the GREATEST, so every reference
   * that resolved before resolves at an identical score: strictly additive,
   * with no threshold moved.
   */
  private async resolveJob(
    tenantId: string,
    reference: string,
  ): Promise<EntityResolverResult> {
    // '' when the reference is pure filler ("that job"): strict_word_similarity
    // of an empty needle is 0, so such a reference keeps exactly today's
    // summary-only behavior instead of matching every customer.
    const needle = stripClockTokens(extractNameLikeToken(reference) ?? '');

    // Archived customers are excluded on the customer half for the same reason
    // `resolveCustomer` excludes them — they must not become voice targets.
    // `c.tenant_id = j.tenant_id` keeps the join inside the tenant on top of
    // the RLS session context `withTenantConnection` sets.
    const SCORE_EXPR = `GREATEST(
             similarity(j.summary, $2),
             COALESCE(strict_word_similarity($4, c.display_name), 0),
             COALESCE(strict_word_similarity($4, c.company_name), 0)
           )`;
    const rows = await withTenantConnection(this.pool, tenantId, (client) =>
      client
        .query<{
          id: string;
          summary: string;
          status: string | null;
          score: number;
        }>(
          `SELECT j.id, j.summary, j.status, ${SCORE_EXPR} AS score
             FROM jobs j
             LEFT JOIN customers c
               ON c.id = j.customer_id
              AND c.tenant_id = j.tenant_id
              AND c.is_archived = false
            WHERE j.tenant_id = $1
              AND ${SCORE_EXPR} > $3
            ORDER BY score DESC
            LIMIT ${MAX_JOB_CANDIDATES + 1}`,
          [tenantId, reference, SIMILARITY_PREFILTER, needle],
        )
        .then((r) => r.rows),
    );

    const candidates: EntityCandidate[] = rows.map((row) => ({
      id: row.id,
      kind: 'job' as EntityKind,
      label: row.summary,
      hint: row.status ?? undefined,
      score: Number(row.score),
    }));

    // A customer's name matches EVERY job of theirs at 1.000, so a commercial
    // account with eight open jobs is an ordinary case, not an exotic one —
    // and `LIMIT 5` would have handed back an arbitrary five of the eight as a
    // picker that may not even contain the right job. Escalating is the honest
    // answer, the same rule the appointment fallbacks already apply ("reading
    // back an arbitrary five of forty would be a guess wearing a
    // disambiguation costume"). Deliberately counted on the CONFIDENT band
    // only: six rows of which one is above τ_ent and five are weak trigram
    // noise must still resolve that one, exactly as before.
    const confident = candidates.filter((c) => c.score >= TAU_ENT);
    if (confident.length > MAX_JOB_CANDIDATES) return { kind: 'not_found', reference };

    return this.toResult(candidates.slice(0, MAX_JOB_CANDIDATES), reference);
  }

  private async resolveInvoice(
    tenantId: string,
    reference: string,
  ): Promise<EntityResolverResult> {
    const exact = await this.resolveExactDocumentNumber(
      tenantId,
      reference,
      'invoice',
      'invoices',
      'invoice_number',
    );
    if (exact) return exact;

    const rows = await withTenantConnection(this.pool, tenantId, (client) =>
      client
        .query<{
          id: string;
          invoice_number: string;
          status: string | null;
          score: number;
        }>(
          `SELECT id, invoice_number, status, similarity(invoice_number, $2) AS score
             FROM invoices
            WHERE tenant_id = $1
              AND similarity(invoice_number, $2) > $3
            ORDER BY score DESC
            LIMIT 5`,
          [tenantId, reference, SIMILARITY_PREFILTER],
        )
        .then((r) => r.rows),
    );

    const candidates: EntityCandidate[] = rows.map((row) => ({
      id: row.id,
      kind: 'invoice' as EntityKind,
      label: row.invoice_number,
      hint: row.status ?? undefined,
      score: Number(row.score),
    }));

    return this.toResult(candidates, reference);
  }

  /**
   * Resolve an estimate by its document number, else by the name of the
   * CUSTOMER it belongs to.
   *
   * B7.6 — before this, the estimate path was exact-document-number ONLY, so
   * "the Garcia estimate" resolved to nothing and every spoken
   * `update_estimate` / `send_estimate` reference stayed unresolved. No spoken
   * sentence produces an EST-0042; the number path answers a typed/read-back
   * reference, not an operator talking.
   *
   * THE TRAVERSAL. `estimates` has no `customer_id` — it carries `job_id`, and
   * `jobs` carries `customer_id`. So a person's name reaches their estimates
   * exactly one way: customer → jobs → estimates. That is the same hop
   * `SendEstimateNudgeTaskHandler` makes with `findByTenant({ jobIds })`
   * (voice-extended-tasks.ts, `estimatesForResolvedCustomer`) and the same one
   * the estimates list route makes with `job_id = ANY(...)`; this is the
   * resolver-level version, so a reference resolves BEFORE drafting rather
   * than each task handler re-deriving it.
   *
   * WHAT IS DELIBERATELY NOT MATCHED: `estimates.customer_message`. That is
   * the trap documented in docs/solutions/test-failures/
   * a-fixture-arranged-to-pass-proves-nothing.md — the nudge integration test
   * went green only because its fixture planted the customer's surname in that
   * optional, operator-authored column. Matching it here would re-create the
   * same illusion: references resolving in tests and not in production.
   *
   * SCORING is `resolveCustomer`'s, unchanged and with no threshold moved:
   * `strict_word_similarity` over display_name and company_name, because
   * whole-string `similarity` cannot see a surname (measurements on
   * ESTIMATE_DOC_STOPWORDS above). Whole-string similarity is NOT in this
   * GREATEST because there is nothing on the estimate row worth comparing a
   * whole phrase against — the exact-number fast path above already owns the
   * only self-describing text an estimate has, and it runs first, so no
   * reference that resolved before can score differently now.
   */
  private async resolveEstimate(
    tenantId: string,
    reference: string,
  ): Promise<EntityResolverResult> {
    const exact = await this.resolveExactDocumentNumber(
      tenantId,
      reference,
      'estimate',
      'estimates',
      'estimate_number',
      { excludeDeleted: true },
    );
    if (exact) return exact;

    // Names nobody ("the estimate") → keep exactly the pre-existing not_found
    // rather than letting an empty needle fan out across the tenant.
    const needle = estimateNameNeedle(reference);
    if (needle === '') return { kind: 'not_found', reference };

    // `c.tenant_id = j.tenant_id` / `j.tenant_id = e.tenant_id` keep both joins
    // inside the tenant on top of the RLS session context
    // `withTenantConnection` sets. Archived customers are excluded for the same
    // reason `resolveCustomer` and `resolveJob` exclude them — they must not
    // become voice targets. Soft-deleted estimates are excluded to match the
    // exact-number path's `excludeDeleted`.
    const SCORE_EXPR = `GREATEST(
             strict_word_similarity($2, c.display_name),
             COALESCE(strict_word_similarity($2, c.company_name), 0)
           )`;
    const rows = await withTenantConnection(this.pool, tenantId, (client) =>
      client
        .query<{
          id: string;
          estimate_number: string;
          status: string | null;
          score: number;
        }>(
          `SELECT e.id, e.estimate_number, e.status, ${SCORE_EXPR} AS score
             FROM estimates e
             JOIN jobs j
               ON j.id = e.job_id
              AND j.tenant_id = e.tenant_id
             JOIN customers c
               ON c.id = j.customer_id
              AND c.tenant_id = j.tenant_id
              AND c.is_archived = false
            WHERE e.tenant_id = $1
              AND e.deleted_at IS NULL
              AND ${SCORE_EXPR} > $3
            ORDER BY score DESC
            LIMIT ${MAX_ESTIMATE_CANDIDATES + 1}`,
          [tenantId, needle, SIMILARITY_PREFILTER],
        )
        .then((r) => r.rows),
    );

    const candidates: EntityCandidate[] = rows.map((row) => ({
      id: row.id,
      kind: 'estimate' as EntityKind,
      label: row.estimate_number,
      hint: row.status ?? undefined,
      score: Number(row.score),
    }));

    // THE OVERFLOW TRAP, same one `resolveJob` guards: a customer's name
    // matches EVERY estimate of theirs at 1.000, so a commercial account with
    // eight of them is ordinary, not exotic — and `LIMIT 5` would hand back an
    // arbitrary five as a picker that need not even contain the right one.
    // Escalating to not_found is the honest answer. Counted on the CONFIDENT
    // band only, so six rows of which one is above τ_ent and five are weak
    // trigram noise still resolve that one.
    const confident = candidates.filter((c) => c.score >= TAU_ENT);
    if (confident.length > MAX_ESTIMATE_CANDIDATES) return { kind: 'not_found', reference };

    return this.toResult(candidates.slice(0, MAX_ESTIMATE_CANDIDATES), reference);
  }

  /**
   * Exact document-number match (INV-0042, EST-0042) before fuzzy trigram.
   * Returns null when no rows match so callers can fall through to similarity.
   */
  private async resolveExactDocumentNumber(
    tenantId: string,
    reference: string,
    kind: 'invoice' | 'estimate',
    table: 'invoices' | 'estimates',
    numberColumn: 'invoice_number' | 'estimate_number',
    opts: { excludeDeleted?: boolean } = {},
  ): Promise<EntityResolverResult | null> {
    const deletedFilter = opts.excludeDeleted ? ' AND deleted_at IS NULL' : '';
    const rows = await withTenantConnection(this.pool, tenantId, (client) =>
      client
        .query<{
          id: string;
          doc_number: string;
          status: string | null;
        }>(
          `SELECT id, ${numberColumn} AS doc_number, status
             FROM ${table}
            WHERE tenant_id = $1
              AND UPPER(${numberColumn}) = UPPER($2)${deletedFilter}
            ORDER BY created_at DESC
            LIMIT 5`,
          [tenantId, reference],
        )
        .then((r) => r.rows),
    );

    if (rows.length === 0) return null;

    const candidates: EntityCandidate[] = rows.map((row) => ({
      id: row.id,
      kind,
      label: row.doc_number,
      hint: row.status ?? undefined,
      score: 1.0,
    }));

    if (candidates.length === 1) {
      return { kind: 'resolved', candidate: candidates[0] };
    }
    return { kind: 'ambiguous', candidates };
  }

  private async resolveAppointment(
    tenantId: string,
    reference: string,
    jobId?: string,
  ): Promise<EntityResolverResult> {
    const parsed = parseDateReference(reference);
    if (!parsed) {
      // B4.7/B5.3 (review finding B) — a TIME-OF-DAY reference ("the 2pm",
      // "tomorrow at 2", "push tomorrow's 10am to 3pm"). `parseDateReference`
      // above only accepts whole-day strings, so these fell through with
      // `extractNameLikeToken` happily treating `2pm` / `tomorrow` / `at` as
      // name content — the reference went into a fuzzy job-SUMMARY search and
      // came back not_found, so cancel/reschedule/reassign failed even when
      // exactly one appointment sat at the stated time. Resolved against
      // `scheduled_start` in the TENANT's zone before the named-job branch.
      //
      // Returns null ONLY when the reference states no clock time — then the
      // branches below get their turn. When a clock time IS stated it answers
      // definitively, including `not_found` if nothing sits at that time.
      // It is deliberately not "purely additive": that framing is what made
      // an unmatched explicit time fall through to a different appointment.
      const byClock = await this.resolveAppointmentByClockTime(tenantId, reference, jobId);
      if (byClock) return byClock;

      // A job anchor is the tighter scope, so it wins when we have one.
      if (jobId) {
        return this.resolveAppointmentByJob(tenantId, reference, jobId);
      }

      // B5.3 (AC-3, the delicate fix — see b5.3-design.md §3). Before this
      // branch, EVERY non-date, non-job-anchored reference fell straight to
      // `resolveUpcomingAppointment`'s tenant-wide "soonest upcoming"
      // fallback — including a reference that names someone ("the Johnson
      // job") the tenant has NO record of. That silently swapped the
      // caller's named target for an unrelated appointment instead of
      // saying "I couldn't find that". The fix is narrow: only a reference
      // with NO name-like content at all (a genuinely nameless "cancel the
      // upcoming appointment", SCH-03's case) is allowed to reach the
      // nameless fallback. A reference that DOES carry a name is resolved
      // against jobs by that name first — never silently discarded.
      const nameToken = extractNameLikeToken(reference);
      if (nameToken) {
        // Named reference, no job anchor yet: resolve the name against jobs —
        // by their own summary AND by their linked CUSTOMER — and build on
        // `resolveAppointmentByJob` for the unique-match case, exactly the
        // AC-3 positive path. `resolveJob` derives the same customer needle
        // from the same `extractNameLikeToken(reference)` computed just above,
        // which is why this branch and the `kind: 'job'` entry point can share
        // ONE implementation instead of two that drift.
        const jobResult = await this.resolveJob(tenantId, reference);
        switch (jobResult.kind) {
          case 'resolved':
            return this.resolveAppointmentByJob(tenantId, reference, jobResult.candidate.id);
          case 'ambiguous':
            // The NAME matches several jobs. Returning `jobResult` as-is
            // would hand back candidates of kind 'job' for an APPOINTMENT
            // reference: the operator taps one, `resolveProposalEntity`
            // injects it as `jobId`, and reassign/cancel/reschedule still
            // have no `appointmentId` — the proposal stays blocked with no
            // appointment picker ever shown. So fan the matched jobs out to
            // their upcoming appointments and answer in the kind the caller
            // actually needs.
            return this.resolveAppointmentsForJobs(
              tenantId,
              reference,
              jobResult.candidates.map((c) => c.id),
            );
          case 'not_found':
          case 'low_confidence':
          case 'skipped':
            // The name was searched and matched nothing confidently. This
            // is the AC-3 defect's exact case: never fall through to the
            // nameless tenant-wide fallback here — that would silently
            // answer about a different customer's appointment. Fold
            // low_confidence into not_found too: a single below-τ_ent job
            // match is not confident enough to silently drive an
            // appointment guess, and the caller (resolveVoiceEntityReferences)
            // has no case for `low_confidence` on this seam today, so
            // returning it here would be silently swallowed rather than
            // surfaced for review — not_found at least lands as a
            // pendingReference the operator can see.
            return { kind: 'not_found', reference };
        }
      }

      // SCH-03 — no date phrase, no job anchor, and no name-like token at
      // all ("cancel the upcoming appointment"). Before this fallback the
      // resolver gave up here, which made every FIRST-TURN "cancel the
      // upcoming appointment" escalate to on-call (inapp-adapter.ts's
      // requiresExistingEntity guard) even for a tenant with exactly one
      // upcoming appointment and nothing to be ambiguous about. Unchanged
      // by the AC-3 fix above — a genuinely nameless reference still
      // reaches here, exactly as SCH-03 requires.
      return this.resolveUpcomingAppointment(tenantId, reference);
    }

    // Schema column is `scheduled_start`; appointments have no title — label is
    // the start time, hint is the status. Canceled appointments are excluded
    // (they are not reschedule targets).
    const rows = await withTenantConnection(this.pool, tenantId, (client) =>
      client
        .query<{
          id: string;
          scheduled_start: string;
          status: string | null;
        }>(
          `SELECT id, scheduled_start, status
             FROM appointments
            WHERE tenant_id = $1
              AND scheduled_start >= $2
              AND scheduled_start < $3
              AND status <> 'canceled'
            ORDER BY scheduled_start ASC
            LIMIT 5`,
          [tenantId, parsed.start.toISOString(), parsed.end.toISOString()],
        )
        .then((r) => r.rows),
    );

    if (rows.length === 0) {
      return { kind: 'not_found', reference };
    }

    const candidates: EntityCandidate[] = rows.map((row) => ({
      id: row.id,
      kind: 'appointment' as EntityKind,
      label: new Date(row.scheduled_start).toISOString(),
      hint: row.status ?? undefined,
      score: 1.0,
    }));

    if (candidates.length === 1) {
      return { kind: 'resolved', candidate: candidates[0] };
    }
    return { kind: 'ambiguous', candidates };
  }

  /**
   * The tenant's IANA zone from `tenant_settings`, or undefined when the
   * tenant has not got one — no settings row, a NULL zone, or a string
   * `isRuntimeTimezone` doesn't recognize.
   *
   * `undefined` here means "UNKNOWN", not "use the default". It used to mean
   * the latter: the comment this replaces argued that handing `undefined` to
   * `resolveDateTime` was harmless because its default equals the column
   * default, so an unwritten settings row and a defaulted one resolve alike.
   * That reasoning is exactly the Phoenix mis-booking, and migration 263
   * (db/schema.ts) overturned its premise — it dropped `timezone TEXT NOT NULL
   * DEFAULT 'America/New_York'` precisely so an unset zone reads back NULL and
   * is DISTINGUISHABLE from a real Eastern tenant's choice. `resolveDateTime`
   * still substitutes `DEFAULT_TENANT_TIMEZONE` for an absent zone
   * (resolve-datetime.ts:161, `DEFAULT_TENANT_TIMEZONE = 'America/New_York'`
   * at :32), so the caller — not this method — must refuse to resolve. See
   * `resolveAppointmentByClockTime`.
   *
   * Read inside `withTenantConnection` like every other query here, so RLS
   * scopes it.
   */
  private async resolveTenantTimezone(tenantId: string): Promise<string | undefined> {
    const rows = await withTenantConnection(this.pool, tenantId, (client) =>
      client
        .query<{ timezone: string | null }>(
          `SELECT timezone FROM tenant_settings WHERE tenant_id = $1 LIMIT 1`,
          [tenantId],
        )
        .then((r) => r.rows),
    );
    const tz = rows[0]?.timezone ?? undefined;
    return tz && isRuntimeTimezone(tz) ? tz : undefined;
  }

  /**
   * Review finding B — resolve a TIME-OF-DAY appointment reference ("the 2pm",
   * "tomorrow at 2", "tomorrow's 10am") against `scheduled_start`.
   *
   * Tenant-zone correctness is delegated wholesale to `resolveDateTime`
   * (ai/scheduling/resolve-datetime.ts) rather than reinvented: it anchors
   * chrono to the tenant's wall clock, converts through luxon so DST is right,
   * and hands back a UTC instant. There is no server-local arithmetic in here —
   * the only Date math is the ± tolerance around that returned UTC instant, and
   * the comparison happens in Postgres against a `timestamptz`.
   *
   * Returns null (not `not_found`) in the two cases where the caller must keep
   * going: the reference states no clock time at all, or `resolveDateTime`
   * cannot make a concrete instant of it (a bare "tomorrow" is
   * `ambiguous_no_time`, a bare daypart is not an exact time, a past instant is
   * `in_past`). That keeps this branch strictly additive — every reference that
   * resolved before still reaches the branch that resolved it.
   *
   * AN UNSET TENANT ZONE IS THE ONE TERMINAL CASE. If the tenant has no
   * timezone, a stated clock time cannot be converted to an instant at all,
   * and this branch must not answer. It must also not return null: falling
   * through would hand "cancel the 2pm" to the name branch and then to
   * SCH-03's nameless tenant-wide fallback, which answers with the soonest
   * upcoming appointment — the same confidently-wrong id by a longer route.
   * So it returns `not_found`, which is terminal here (`resolveAppointment`
   * returns any non-null result) and is this seam's "I cannot answer that":
   * `requiresExistingEntity` is true for APPOINTMENT_REF_INTENTS, so a
   * not_found escalates / lands as a pendingReference instead of executing.
   *
   * WHY THIS IS NOT AN EDGE CASE. Every other failure on this branch degrades
   * to `not_found` or `ambiguous` — both safe. Defaulting the zone degrades to
   * SELECTING A DIFFERENT APPOINTMENT: with `undefined`, resolveDateTime
   * silently substitutes Eastern (resolve-datetime.ts:161), so for a Phoenix
   * tenant "the 2pm" targets the 2pm-Eastern instant, and the ±15-minute
   * window can match a real appointment that is not the one the operator
   * meant. That id then drives cancel / reschedule / reassign. The repo
   * already refuses to guess a zone everywhere else this matters —
   * create-appointment-task.ts raises a clarification, routes/onboarding.ts
   * never defaults one, and migration 263 exists so an unset zone is
   * representable as NULL rather than an indistinguishable 'America/New_York'.
   * This branch was the remaining place that guessed.
   */
  private async resolveAppointmentByClockTime(
    tenantId: string,
    reference: string,
    jobId?: string,
  ): Promise<EntityResolverResult | null> {
    if (!hasClockTime(reference)) return null;

    const timezone = await this.resolveTenantTimezone(tenantId);
    // Unknown zone → refuse, never default. See the block comment above.
    if (!timezone) return { kind: 'not_found', reference };

    const resolved = resolveDateTime(reference, { timezone });
    // `precision: 'daypart'` is a WINDOW ("tomorrow morning"), not a stated
    // time — treating it as one would silently pick whichever appointment sat
    // nearest an invented 8am. Only an exact clock time answers here.
    if (!resolved.ok || resolved.precision !== 'exact') return null;

    const target = new Date(resolved.startUtc).getTime();
    const windowStart = new Date(target - CLOCK_TIME_TOLERANCE_MS);
    const windowEnd = new Date(target + CLOCK_TIME_TOLERANCE_MS);

    const MAX_DISAMBIGUATION_CANDIDATES = 5;
    const rows = await withTenantConnection(this.pool, tenantId, (client) =>
      client
        .query<{
          id: string;
          scheduled_start: string;
          job_summary: string | null;
          tech_name: string | null;
        }>(
          // Same joins as `resolveAppointmentByJob` so an ambiguous result
          // carries WHEN + WHAT + WHO. For a TIME reference the differentiator
          // is not the clock (every candidate is within a quarter hour of the
          // same instant) but the work and the tech, so both are in the hint.
          `SELECT a.id, a.scheduled_start, j.summary AS job_summary,
                  NULLIF(TRIM(COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')), '') AS tech_name
             FROM appointments a
             LEFT JOIN jobs j ON j.id = a.job_id AND j.tenant_id = a.tenant_id
             LEFT JOIN appointment_assignments aa
               ON aa.appointment_id = a.id AND aa.tenant_id = a.tenant_id AND aa.is_primary = true
             LEFT JOIN users u ON u.id = aa.technician_id
            WHERE a.tenant_id = $1
              AND a.status <> 'canceled'
              AND a.scheduled_start >= $2
              AND a.scheduled_start < $3
              AND ($4::uuid IS NULL OR a.job_id = $4::uuid)
            ORDER BY a.scheduled_start ASC
            LIMIT ${MAX_DISAMBIGUATION_CANDIDATES + 1}`,
          [tenantId, windowStart.toISOString(), windowEnd.toISOString(), jobId ?? null],
        )
        .then((r) => r.rows),
    );

    // Nothing at the stated time. This is NOT a fall-through: the speaker gave
    // an explicit constraint, and the branches below would answer with a
    // DIFFERENT appointment — "cancel the 2pm" against a job whose only
    // upcoming visit is 4pm would silently target the 4pm. Same shape as the
    // unknown-zone refusal above: once an explicit time fails to match, every
    // remaining route reaches a wrong answer by a longer path.
    if (rows.length === 0) return { kind: 'not_found', reference };
    // More candidates than a picker can honestly show — same rule as the
    // sibling fallbacks: escalating beats reading back an arbitrary five.
    if (rows.length > MAX_DISAMBIGUATION_CANDIDATES) return { kind: 'not_found', reference };

    const candidates: EntityCandidate[] = rows.map((row) => ({
      id: row.id,
      kind: 'appointment' as EntityKind,
      label: new Date(row.scheduled_start).toISOString(),
      hint:
        [row.job_summary ?? undefined, row.tech_name ? `assigned to ${row.tech_name}` : undefined]
          .filter(Boolean)
          .join(' · ') || 'unassigned',
      score: 1.0,
    }));

    if (candidates.length === 1) {
      return { kind: 'resolved', candidate: candidates[0] };
    }
    return { kind: 'ambiguous', candidates };
  }

  /**
   * SCH-03 — job-scoped fallback for appointment references that aren't date
   * phrases ("that job", "the appointment for that job"). `appointments.job_id`
   * is a real, indexed FK (idx_appointments_job), so this is an index-supported
   * lookup rather than a fuzzy guess. Scoped to upcoming, non-canceled
   * appointments — the same "not a reschedule/cancel target" exclusion the
   * date-based branch above applies to canceled rows.
   */
  private async resolveAppointmentByJob(
    tenantId: string,
    reference: string,
    jobId: string,
  ): Promise<EntityResolverResult> {
    // B5.3 (AC-3) — LEFT JOIN the primary assignment + technician name so an
    // ambiguous result's candidates carry DATE (label, already ISO) + the
    // ASSIGNED TECH (hint), not just status: "the Johnson job" resolving to
    // two appointments is only answerable as a one-tap picker if each option
    // says WHEN and WHO, not just a status string.
    const rows = await withTenantConnection(this.pool, tenantId, (client) =>
      client
        .query<{
          id: string;
          job_id: string;
          scheduled_start: string;
          status: string | null;
          tech_name: string | null;
        }>(
          `SELECT a.id, a.job_id, a.scheduled_start, a.status,
                  NULLIF(TRIM(COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')), '') AS tech_name
             FROM appointments a
             LEFT JOIN appointment_assignments aa
               ON aa.appointment_id = a.id AND aa.tenant_id = a.tenant_id AND aa.is_primary = true
             LEFT JOIN users u ON u.id = aa.technician_id
            WHERE a.tenant_id = $1
              AND a.job_id = $2
              AND a.status <> 'canceled'
              AND a.scheduled_start >= now()
            ORDER BY a.scheduled_start ASC
            LIMIT 5`,
          [tenantId, jobId],
        )
        .then((r) => r.rows),
    );

    if (rows.length === 0) {
      return { kind: 'not_found', reference };
    }

    const candidates: EntityCandidate[] = rows.map((row) => ({
      id: row.id,
      kind: 'appointment' as EntityKind,
      label: new Date(row.scheduled_start).toISOString(),
      hint: row.tech_name ? `assigned to ${row.tech_name}` : 'unassigned',
      score: 1.0,
    }));

    if (candidates.length === 1) {
      return { kind: 'resolved', candidate: candidates[0] };
    }
    return { kind: 'ambiguous', candidates };
  }

  /**
   * B5.3 follow-up — fan several name-matched jobs out to their upcoming
   * appointments, so an ambiguous NAME is still answered in the kind the
   * caller asked for.
   *
   * Without this, "the Johnson job" matching two jobs returned job-kind
   * candidates for an appointment reference: picking one injected a `jobId`,
   * and the scheduling handlers (reassign / cancel / reschedule) still had no
   * `appointmentId`, so the proposal stayed gated and the operator never got
   * an appointment picker at all.
   *
   * Same shape and honesty rules as the single-job path above: exactly one
   * upcoming appointment across all matched jobs resolves; two to five become
   * a one-tap picker carrying date + assigned tech; zero or more than five
   * are `not_found`, because reading back an arbitrary five of forty would be
   * a guess wearing a disambiguation costume.
   */
  private async resolveAppointmentsForJobs(
    tenantId: string,
    reference: string,
    jobIds: string[],
  ): Promise<EntityResolverResult> {
    if (jobIds.length === 0) return { kind: 'not_found', reference };
    const MAX_DISAMBIGUATION_CANDIDATES = 5;

    const rows = await withTenantConnection(this.pool, tenantId, (client) =>
      client
        .query<{
          id: string;
          scheduled_start: string;
          status: string | null;
          tech_name: string | null;
        }>(
          `SELECT a.id, a.scheduled_start, a.status,
                  NULLIF(TRIM(COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')), '') AS tech_name
             FROM appointments a
             LEFT JOIN appointment_assignments aa
               ON aa.appointment_id = a.id AND aa.tenant_id = a.tenant_id AND aa.is_primary = true
             LEFT JOIN users u ON u.id = aa.technician_id
            WHERE a.tenant_id = $1
              AND a.job_id = ANY($2::uuid[])
              AND a.status <> 'canceled'
              AND a.scheduled_start >= now()
            ORDER BY a.scheduled_start ASC
            LIMIT ${MAX_DISAMBIGUATION_CANDIDATES + 1}`,
          [tenantId, jobIds],
        )
        .then((r) => r.rows),
    );

    if (rows.length === 0 || rows.length > MAX_DISAMBIGUATION_CANDIDATES) {
      return { kind: 'not_found', reference };
    }

    const candidates: EntityCandidate[] = rows.map((row) => ({
      id: row.id,
      kind: 'appointment' as EntityKind,
      label: new Date(row.scheduled_start).toISOString(),
      hint: row.tech_name ? `assigned to ${row.tech_name}` : 'unassigned',
      score: 1.0,
    }));

    if (candidates.length === 1) {
      return { kind: 'resolved', candidate: candidates[0] };
    }
    return { kind: 'ambiguous', candidates };
  }

  /**
   * SCH-03 — tenant-scoped upcoming-appointment fallback. Reached only when
   * the reference is neither a date phrase NOR anchored to a job, i.e. the
   * caller said something like "cancel the upcoming appointment for that job"
   * on turn one of a fresh session, where `context.jobId` cannot exist yet
   * (it is only written by a PRIOR turn that resolved a job —
   * transitions.ts). Structurally, `cancel_appointment` is in neither
   * JOB_REF_INTENTS nor SCHEDULING_CREATE_INTENTS, so the cancel turn itself
   * never plans a job lookup and the sticky-jobId path is unreachable for a
   * single-turn cancel — this is the only branch that can answer it.
   *
   * Deliberately the SAME query shape as `resolveAppointmentByJob` above,
   * minus the `job_id` predicate: upcoming, non-canceled, earliest first. It
   * is index-supported the same way — migration 051's
   * `idx_appointments_scheduled_for ON appointments (tenant_id,
   * scheduled_start)` (db/schema.ts) covers this predicate AND its ordering
   * exactly, so this is a range scan, not a fuzzy guess.
   *
   * The "never a silent guess" invariant is preserved end to end:
   *   - exactly one row  → `resolved` (and the FSM still reads the intent
   *     back in `intent_confirm` before drafting, and the proposal still
   *     needs an operator screen-tap — two human gates downstream);
   *   - two to five rows → `ambiguous`, which `toResolutionEvent`
   *     (inapp-adapter.ts) turns into the FSM's existing `entity_ambiguous`
   *     one-tap disambiguation — no new path invented;
   *   - zero rows        → `not_found`, so the escalation guard added in
   *     46a954e1 still fires for a record-operating intent with genuinely
   *     nothing to resolve;
   *   - more than five   → also `not_found`. A busy tenant's true candidate
   *     set is unbounded, and reading back an arbitrary five of forty would
   *     be a guess wearing a disambiguation costume. Escalating is the
   *     honest answer. (LIMIT 6 exists only to detect this.)
   */
  private async resolveUpcomingAppointment(
    tenantId: string,
    reference: string,
  ): Promise<EntityResolverResult> {
    const MAX_DISAMBIGUATION_CANDIDATES = 5;
    const rows = await withTenantConnection(this.pool, tenantId, (client) =>
      client
        .query<{
          id: string;
          scheduled_start: string;
          status: string | null;
        }>(
          `SELECT id, scheduled_start, status
             FROM appointments
            WHERE tenant_id = $1
              AND status <> 'canceled'
              AND scheduled_start >= now()
            ORDER BY scheduled_start ASC
            LIMIT ${MAX_DISAMBIGUATION_CANDIDATES + 1}`,
          [tenantId],
        )
        .then((r) => r.rows),
    );

    if (rows.length === 0 || rows.length > MAX_DISAMBIGUATION_CANDIDATES) {
      return { kind: 'not_found', reference };
    }

    const candidates: EntityCandidate[] = rows.map((row) => ({
      id: row.id,
      kind: 'appointment' as EntityKind,
      label: new Date(row.scheduled_start).toISOString(),
      hint: row.status ?? undefined,
      score: 1.0,
    }));

    if (candidates.length === 1) {
      return { kind: 'resolved', candidate: candidates[0] };
    }
    return { kind: 'ambiguous', candidates };
  }

  private async resolveTechnician(
    tenantId: string,
    reference: string,
  ): Promise<EntityResolverResult> {
    // U1 — spoken team-member names ("Carlos", "Mike R") resolve against the
    // users full-name expression. The expression must stay byte-identical to
    // migration 230's GIN trigram index expression so Postgres can serve it
    // from the index. Role filter: anyone assignable to an appointment
    // (technician/dispatcher/owner — the full users role CHECK today, kept
    // explicit so a future non-field role never becomes a reassign target).
    // Soft-deleted users (migration 093) are excluded — they must not become
    // assignment targets. Label = full name, hint = role.
    const rows = await withTenantConnection(this.pool, tenantId, (client) =>
      client
        .query<{
          id: string;
          full_name: string;
          role: string | null;
          score: number;
        }>(
          `SELECT id,
                  ${TECH_NAME_EXPR} AS full_name,
                  role,
                  ${TECH_SCORE_EXPR} AS score
             FROM users
            WHERE tenant_id = $1
              AND role IN ('technician','dispatcher','owner')
              AND deleted_at IS NULL
              AND ${TECH_SCORE_EXPR} > $3
            ORDER BY score DESC
            LIMIT ${MAX_TECHNICIAN_CANDIDATES + 1}`,
          [tenantId, reference, SIMILARITY_PREFILTER],
        )
        .then((r) => r.rows),
    );

    const candidates: EntityCandidate[] = rows.map((row) => ({
      id: row.id,
      kind: 'technician' as EntityKind,
      label: row.full_name,
      hint: row.role ?? undefined,
      score: Number(row.score),
    }));

    // THE OVERFLOW TRAP, same one `resolveJob`/`resolveEstimate` guard: since
    // 7fbff6e, a shared first name (or surname) scores 1.000 against every
    // matching technician, so a shop with six Carloses — or six Smiths — is
    // ordinary, not exotic, and `LIMIT 5` would hand back an arbitrary five as
    // a one-tap picker that need not even contain the right person.
    // Escalating to not_found is the honest answer. Counted on the CONFIDENT
    // band only, so six rows of which one is above τ_ent and five are weak
    // trigram noise still resolve that one.
    const confident = candidates.filter((c) => c.score >= TAU_ENT);
    if (confident.length > MAX_TECHNICIAN_CANDIDATES) return { kind: 'not_found', reference };

    return this.toResult(candidates.slice(0, MAX_TECHNICIAN_CANDIDATES), reference);
  }

  // ---------------------------------------------------------------------------
  // Shared classification logic
  // ---------------------------------------------------------------------------

  /**
   * Convert a scored candidate list into a resolution result using τ_ent
   * and, for the band just below it, τ_ent_confirm_low.
   *
   *   - 1 candidate  >= τ_ent              → resolved
   *   - 2+ candidates >= τ_ent             → ambiguous
   *   - 1 candidate in [τ_ent_confirm_low, τ_ent) → low_confidence
   *   - 2+ candidates in [τ_ent_confirm_low, τ_ent) → ambiguous
   *   - otherwise                          → not_found
   */
  private toResult(
    candidates: EntityCandidate[],
    reference: string,
  ): EntityResolverResult {
    const above = candidates.filter((c) => c.score >= TAU_ENT);
    if (above.length === 1) return { kind: 'resolved', candidate: above[0] };
    if (above.length >= 2) return { kind: 'ambiguous', candidates: above };

    const midBand = candidates.filter(
      (c) => c.score >= TAU_ENT_CONFIRM_LOW && c.score < TAU_ENT,
    );
    if (midBand.length === 1) return { kind: 'low_confidence', candidate: midBand[0] };
    if (midBand.length >= 2) return { kind: 'ambiguous', candidates: midBand };

    return { kind: 'not_found', reference };
  }
}

// ---------------------------------------------------------------------------
// Relative date parsing helpers
// ---------------------------------------------------------------------------

interface DateRange {
  start: Date;
  end: Date;
}

/**
 * Parse a natural-language date reference into a UTC date range covering
 * the full calendar day. Handles "today", "tomorrow", "yesterday", and
 * weekday names ("next Tuesday", "Tuesday").
 *
 * Returns null when the reference cannot be parsed.
 */
function parseDateReference(reference: string): DateRange | null {
  const ref = reference.toLowerCase().trim();
  const now = new Date();

  const startOfDay = (d: Date): Date => {
    const s = new Date(d);
    s.setUTCHours(0, 0, 0, 0);
    return s;
  };

  const endOfDay = (d: Date): Date => {
    const s = new Date(d);
    s.setUTCHours(23, 59, 59, 999);
    return s;
  };

  const rangeFor = (d: Date): DateRange => ({
    start: startOfDay(d),
    end: endOfDay(d),
  });

  if (ref === 'today') {
    return rangeFor(now);
  }

  if (ref === 'tomorrow') {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() + 1);
    return rangeFor(d);
  }

  if (ref === 'yesterday') {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - 1);
    return rangeFor(d);
  }

  // Weekday name, optionally prefixed with "next "
  const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const nextMatch = ref.match(/^(?:next\s+)?(\w+)$/);
  if (nextMatch) {
    const dayName = nextMatch[1];
    const targetDay = WEEKDAYS.indexOf(dayName);
    if (targetDay !== -1) {
      const isNext = ref.startsWith('next ');
      const d = new Date(now);
      const currentDay = d.getUTCDay();
      let diff = targetDay - currentDay;
      if (diff <= 0 || isNext) {
        diff += 7;
      }
      d.setUTCDate(d.getUTCDate() + diff);
      return rangeFor(d);
    }
  }

  // ISO date string "YYYY-MM-DD"
  const isoMatch = ref.match(/^(\d{4}-\d{2}-\d{2})$/);
  if (isoMatch) {
    const d = new Date(isoMatch[1] + 'T00:00:00.000Z');
    if (!isNaN(d.getTime())) {
      return rangeFor(d);
    }
  }

  return null;
}

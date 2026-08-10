/**
 * `lookup_materials` voice skill (Task 9, 2026-08-07 tradesperson plan) —
 * owner/technician asks to hear the pending shopping list ("what parts do
 * I need?", "read me the shopping list", "what materials are open on the
 * Patel job?").
 *
 * Tenant-scoped, read-only. Reads Task 8's `material_items` substrate
 * (src/materials/material-item.ts) via `MaterialItemRepository.listPending`
 * and summarizes the MOST URGENT (F2, 2026-08-10 — Task 8's contract is
 * soonest-`needed_by` first, undated last; it was oldest-created-first
 * through quality-review M4) up to `MAX_ITEMS_SPOKEN` (5) items by
 * description + quantity, plus vendor/needed-by when the caller stated
 * them. Optionally scoped to one job when the caller's spoken jobReference
 * resolved to a verified `jobId` (JOB_REF_INTENTS membership — see
 * entity-resolution.ts); an unresolved spoken job reference is refused by
 * the CALLER (`workers/voice-lookup-answer.ts`'s `lookup_materials` case),
 * never silently widened to the whole tenant list here.
 *
 * No permission gate: unlike `lookup_leads`/`lookup_catalog`, there is
 * deliberately NO entry for this intent in `LOOKUP_REQUIRED_PERMISSION`
 * (workers/voice-lookup-answer.ts) — any authenticated operator, technician
 * included, may hear the shopping list.
 *
 * ── Bounded fetch, not "load everything and slice" (quality-review I4) ────
 *
 * `listPending` is called with `limit: MAX_ITEMS_SPOKEN + 1` — ONE extra
 * row beyond what's ever spoken, fetched purely to detect "more exist"
 * without a second COUNT query. This is a DELIBERATE divergence from
 * `lookup_catalog`, whose skill returns the tenant's WHOLE catalog and lets
 * the WORKER slice it (comment: "programmatic consumers need every item,
 * not the TTS-capped names") — there is no non-TTS consumer of the pending
 * shopping list today, and NOTHING PRUNES this list (`markPurchased` has no
 * production caller; see its doc comment in materials/material-item.ts), so
 * an unbounded `SELECT *` here would load every pending row for the tenant
 * just to speak 5 of them, and that only gets monotonically worse over a
 * tenant's lifetime. If a future consumer needs more
 * than `MAX_ITEMS_SPOKEN` items (the review card can render up to
 * `MAX_VOICE_ANSWER_ROWS`, 24), raise `FETCH_LIMIT` deliberately rather
 * than reverting to an unbounded fetch.
 *
 * The bounded fetch means this skill genuinely CANNOT report an exact
 * total once more than `MAX_ITEMS_SPOKEN` (5) pending items match — the
 * fetch stops at 6, so 6 rows means "at least 6" and nothing more precise.
 * `data.count` is `null` in that case (never a false-precise guess), and
 * the summary says "more than 5 items" rather than inventing a total. A caller that
 * needs an exact total past that boundary needs a separate COUNT query —
 * deliberately NOT added here (that's a distinct, larger change than this
 * task's scope).
 *
 * ── "for tomorrow" IS a filter now (2026-08-09 follow-up) — and neededBy is
 * STILL surfaced per-item (spec-review MAJOR B) ──
 *
 * `MaterialItemListOptions.neededByBefore` (Task 8's substrate, extended)
 * lets this skill actually narrow the query to "what's needed by <date>",
 * closing a real gap the interim per-item-surfacing mitigation left open:
 * the fetch is bounded (`FETCH_LIMIT`, below) and, at the time, ordered
 * oldest-created first BY DEFAULT, so a tenant with more pending items than
 * the fetch cap could have a genuinely time-sensitive item never spoken at
 * all — it only "self-corrected" once the item aged into the oldest-N
 * window. A real date filter, applied at the repo/SQL boundary, fixes that
 * for the caller who NAMES a day; F2 (below) fixes it for the caller who
 * does not.
 *
 * `dateTimeDescription` (the caller's raw spoken day phrase — "tomorrow",
 * "by Friday") is resolved to a calendar day via `resolveSpokenDay`
 * (ai/scheduling/resolve-datetime.ts) — the SAME lookup-side day resolver
 * `lookup_crew_schedule` uses, reused rather than re-implemented (see that
 * module's doc comment for why a LOOKUP needs a different contract than
 * the booking resolver `resolveDateTime`, which refuses a bare day).
 *
 * RESOLVER CONTRACT (review follow-up J4, 2026-08-09) — `resolveSpokenDay`
 * answers "WHICH ONE CALENDAR DAY did they mean?", NOT "where does this
 * deadline range end?". Those coincide for the phrasings the classifier
 * advertises for this intent (a bare weekday, "tomorrow", "by <weekday>")
 * and DIVERGE for range phrases. Measured, reference Thu 2026-06-11
 * America/New_York: "end of the week" -> 06-18 (a deadline reading wants
 * 06-14), "by the end of the month" -> 07-11 (wants 06-30), "last Friday"
 * -> 06-12 (chrono's `forwardDate: true` flips a backward phrase forward).
 * A real deadline-aware resolver is a separate, deliberate feature and was
 * NOT smuggled in here. Two mitigations stand in for it: the classifier
 * prompt advertises only the phrasings that resolve correctly, and the
 * resolved day is ALWAYS spoken back ("needed by June 12"), so a caller who
 * said something outside that set hears the mismatch instead of silently
 * getting the wrong window.
 *
 * ── The date scope is a bracketed DAY, plus a counted backlog (K3) ────────
 *
 * The resolved day becomes a [start, start + 24h) window — `neededByFrom`
 * and `neededByBefore` together — NOT an open-ended `needed_by < boundary`.
 * The open-ended version shipped and was wrong: date-scoped results order
 * `needed_by ASC` under a 6-row fetch and a 5-item spoken cap, so the
 * OLDEST OVERDUE rows sorted first and consumed the entire cap. A tenant
 * with 8 items months overdue plus 2 due tomorrow, asked "what do I need
 * for tomorrow?", heard five March items and "and more beyond that" — and
 * neither item due tomorrow. That is the exact silent-omission class this
 * whole date path exists to fix, pointed the other way.
 *
 * `needed_by DESC` was REJECTED as the fix: it answers the question asked
 * but buries genuinely urgent overdue work, trading one silent omission for
 * another. The contract both halves must satisfy is "the caller MUST hear
 * the items due on the day they asked about, AND must not be left unaware
 * that earlier/overdue items exist." So: one bracketed query answers the
 * question, and a second bounded probe (`neededByBefore: dayStart`,
 * `MAX_SOONER_COUNTED + 1` rows) COUNTS the backlog into one closing
 * sentence — "There are 8 items needed sooner, the earliest on March 1."
 * Counted, never spoken item-by-item: the spoken answer stays scoped to the
 * question, and the caller has an obvious follow-up to ask.
 *
 * UNLIKE `lookup_crew_schedule`, an absent or UNPARSEABLE phrase applies NO
 * filter at all — it does NOT fall back to "today". Crew-schedule always
 * has something to report (today's schedule is a valid answer either way,
 * and it says so explicitly); silently narrowing an unparseable materials
 * ask to "today" would instead HIDE real, later-dated pending items behind
 * a guessed filter the caller never asked for — a worse outcome than just
 * answering the plain unfiltered list honestly. But an unparseable phrase
 * is DISCLOSED (J3): "I couldn't tell which day X meant, so here's the full
 * list." Absent and unparseable used to collapse into one `null` and
 * produce byte-identical summaries, so a caller who said "asap" had no sign
 * their scope had been dropped.
 *
 * `neededBy` is STILL surfaced per-item in the spoken summary regardless of
 * whether a date filter was applied (spec-review MAJOR B) — an unfiltered
 * answer still benefits from the per-item date this fix doesn't replace.
 *
 * ── The UN-SCOPED ask is ordered by urgency too (F2, 2026-08-10) ──────────
 *
 * K3 (above) fixed "what do I need for TOMORROW?". The bare "what do I
 * need?" kept the original defect, and it is the more common ask: the repo's
 * DEFAULT ordering was `created_at ASC`, so under `FETCH_LIMIT` 6 /
 * `MAX_ITEMS_SPOKEN` 5 the five oldest-CREATED rows consumed the entire
 * spoken answer and an item due tomorrow was never mentioned. Because
 * nothing prunes this list (`markPurchased` has no production caller), that
 * was not a transient omission the way an aging window is — the SAME five
 * stale rows owned the answer indefinitely.
 *
 * `listPending` now uses ONE ordering for every call — `needed_by ASC NULLS
 * LAST, created_at ASC` (+ `id ASC` in Pg) — so this skill no longer has a
 * "default" ordering distinct from its date-scoped one. Undated items sort
 * LAST, not first: no `needed_by` means no deadline, not infinite urgency.
 *
 * WHAT F2 DID NOT CLOSE, AND WHAT A1 (2026-08-10) DOES ABOUT IT. F2's own
 * first draft claimed the un-scoped ask now hides nothing, because the query
 * is lower-unbounded and so every omitted row has a LATER deadline than
 * everything spoken. That last clause is true and the conclusion drawn from
 * it was not. Measured counterexample: 8 abandoned March rows (dated, never
 * purchased) plus 2 items due tomorrow, asked "what do I need?" — the five
 * spoken rows are all March and NEITHER item due tomorrow is mentioned. That
 * is the same silent omission K3 fixed for the date-scoped ask, and F2 only
 * moved the crowding-out from stale-CREATED rows to stale-DATED ones. It is
 * closed only for a tenant whose stale rows are UNDATED, because those sort
 * last and cannot consume the cap.
 *
 * It cannot be closed by ordering — the omitted rows really are the less
 * urgent ones, and demoting an overdue row to speak an upcoming one just
 * trades the omission back (the `needed_by DESC` argument above, again). So
 * A1 makes the DISCLOSURE carry it: the tail names the deadline of the FIRST
 * OMITTED row ("and more beyond that, the next needed by March 6"). A bare
 * "and more beyond that" is equally true of one extra undated row and of a
 * hundred-item overdue backlog, which is exactly why it was not enough.
 *
 * STILL NO SECOND DISCLOSURE QUERY HERE, unlike K3's "needed sooner" probe.
 * K3 needed one because a BRACKETED day window hides rows that are MORE
 * urgent than the ones spoken, and nothing already fetched could reveal
 * them. Here the disclosure is free: `FETCH_LIMIT` is `MAX_ITEMS_SPOKEN + 1`,
 * so the first omitted row is already in hand (that extra row is the whole
 * point of I4's bounded fetch). A probe would double the cost of the most
 * common ask to say something the fetched row already says.
 *
 * The residual is a PRODUCT hole, not a query-shape one: nothing prunes this
 * list (see `markPurchased`'s note below), so an abandoned backlog grows
 * without bound and no amount of summary wording makes a 100-item overdue
 * list speakable in five clauses.
 *
 * ── TTS-safe formatting (quality-review I2) ────────────────────────────────
 *
 * Per `spoken-format.ts`'s formatting contract: no symbols that read wrong
 * on TTS. The original `${quantity}× ${description}` shape used U+00D7
 * MULTIPLICATION SIGN, which Amazon Polly reads as "times" in a numeric
 * context ("3× 3 boxes" → "three times three boxes," i.e. nine) and Google
 * Cloud TTS typically drops entirely ("three three boxes"). Every quantity
 * is now spoken as the word "quantity" instead.
 *
 * F3 (2026-08-10) applied the SAME test to the rest of this file's spoken
 * text and found one more of that class: the capped count read "5+ items",
 * and "+" has a lexical reading exactly like "×" does — Polly voices it
 * ("five plus items"), Google drops it and leaves "five items", which is
 * indistinguishable from an exact five and defeats the whole point of the
 * capped fetch. It now reads "more than 5 items".
 *
 * THE TEST THAT MATTERS IS "does the engine try to SAY it", not "is it a
 * symbol". `—` and `…` in the strings below are deliberately left: both
 * engines treat them as prosody (a pause), neither verbalises them, and the
 * em-dash is a house idiom across ~15 spoken lines in this skill family
 * (lookup-availability.ts's caller-facing "I have 1 PM or 3 PM on Tuesday —
 * which works?" among them). Changing them here alone would buy nothing
 * audible and cost the family its one consistent voice; if that idiom is
 * ever retired it should be retired everywhere, behind a shared guard.
 */
import type { MaterialItem, MaterialItemRepository } from '../../materials/material-item';
import type { LookupEventService } from '../../lookup-events/lookup-event-service';
import { DEFAULT_TENANT_TIMEZONE, resolveSpokenDay } from '../scheduling/resolve-datetime';
import { plural } from './spoken-format';

export interface LookupMaterialsInput {
  tenantId: string;
  sessionId?: string;
  /** Verified jobId, when a job was named and resolved (JOB_REF_INTENTS). */
  jobId?: string;
  /**
   * Follow-up (2026-08-09) — raw spoken day phrase ("tomorrow", "by
   * Friday"), when the caller scoped the ask to a date. Resolved
   * internally via `resolveSpokenDay` — see the module doc comment for the
   * full "unparseable means no filter, never a today-guess" rationale.
   */
  dateTimeDescription?: string;
  /** Tenant IANA timezone, used to resolve `dateTimeDescription`. Defaults to DEFAULT_TENANT_TIMEZONE (resolve-datetime.ts) when omitted. */
  timezone?: string;
  /** Reference instant for resolving a relative day phrase. Defaults to now. */
  now?: Date;
}

export interface LookupMaterialsDeps {
  materialItemRepo: MaterialItemRepository;
  lookupEvents?: LookupEventService;
}

export interface LookupMaterialsItem {
  description: string;
  quantity: number;
  vendor?: string;
  /** TTS-safe "MMMM d" label for the item's `neededBy`, when it has one (see `formatNeededByLabel`). */
  neededByLabel?: string;
}

export type LookupMaterialsResult =
  | {
      status: 'found';
      summary: string;
      data: {
        /**
         * Exact count OF THE SCOPE THAT WAS ASKED ABOUT, or `null` once
         * more than `MAX_ITEMS_SPOKEN` (5) rows match it — this skill's
         * bounded fetch (I4) stops at `MAX_ITEMS_SPOKEN + 1`, so a 6-row
         * result means "6 or more" and the true total is genuinely unknown
         * past that point. Never a false-precise guess; see module doc
         * comment.
         *
         * "The scope that was asked about" is load-bearing and NOT the
         * tenant's pending total: it is narrowed by `jobId` and, for a
         * date-scoped ask, by the resolved DAY window (K3) — so a tenant
         * with ten pending items can legitimately get `count: 2` for "what
         * do I need for tomorrow?". Items due EARLIER than that window are
         * not in this number; they are disclosed in the summary's closing
         * "needed sooner" sentence instead.
         */
        count: number | null;
        /**
         * The (at most `MAX_ITEMS_SPOKEN`) MOST URGENT pending items
         * actually spoken/rendered (quality-review M2/M4; F2 changed this
         * from "oldest") — named `spokenItems`, not `items`, so a caller can
         * never mistake this for the full pending set.
         *
         * What the cap omits is later-dated (then undated), which is NOT the
         * same as harmless: a tenant with a dated overdue backlog can have
         * all five slots eaten by months-old rows while an item due tomorrow
         * goes unspoken. The summary's tail names the first omitted row's
         * deadline for exactly that reason (A1) — see module doc comment.
         */
        spokenItems: LookupMaterialsItem[];
      };
    }
  | { status: 'none'; summary: string; data: { count: 0; spokenItems: [] } }
  | { status: 'error'; summary: string; data: { error: string } };

const MAX_ITEMS_SPOKEN = 5;
// One extra row beyond what's ever spoken, fetched solely to detect "more
// exist" without a second COUNT query — and, since A1, to name the first
// OMITTED row's deadline in the tail. See module doc comment (I4, A1).
const FETCH_LIMIT = MAX_ITEMS_SPOKEN + 1;
/**
 * Bounded probe for the "needed sooner" disclosure (K3). Same honesty rule
 * as `count`/`FETCH_LIMIT`: fetch one row PAST the number we're willing to
 * state so the summary can say "more than 20" rather than guess a total.
 * Larger than `FETCH_LIMIT` because this bucket is only ever COUNTED, never
 * spoken item-by-item, so the rows are cheap.
 */
const MAX_SOONER_COUNTED = 20;
/** Spoken-summary description cap — mirrors the row-builder's own label cap (`text()`, voice-lookup-answer.ts). */
const MAX_DESCRIPTION_CHARS = 80;

/**
 * Truncate a free-text description before it joins the spoken summary
 * sentence. Five ~1000-char descriptions concatenated would blow well past
 * `buildAnswer`'s 2000-char hard slice (voice-lookup-answer.ts), silently
 * truncating the sentence MID-WORD and dropping the "and more" tail
 * exactly when the list is longest (quality-review M1).
 */
function truncateForSpeech(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * "MMMM d" label for a bare calendar date, anchored to UTC — NEVER
 * tz-shifted. `neededBy` is persisted as a bare YYYY-MM-DD date at midnight
 * UTC (`add-material-handler.ts`), so rendering it in a tenant timezone west
 * of UTC could roll it back a calendar day; the UTC anchoring mirrors
 * `create-service-agreement-task.ts`'s `formatStartsOnLabel` for that reason.
 * Unlike that helper (a review-card label, not spoken aloud), this label IS
 * spoken by TTS, so it deliberately uses `month: 'long'` rather than
 * `'short'` — this is the first `month: 'short'`-style date in any spoken
 * summary across the skill family, and a full month name removes any risk
 * of an engine mis-reading an abbreviation (e.g. "Aug") at zero cost.
 *
 * The YEAR is appended only when it differs from the tenant's current year
 * (review follow-up N7). `resolveSpokenDay` runs chrono with
 * `forwardDate: true`, so a phrase spoken in December resolves INTO NEXT
 * YEAR — and a bare "January 5" gave the caller no way to hear that. Adding
 * the year unconditionally would instead put a redundant "2026" on every
 * ordinary same-year date, which is noise on TTS.
 */
function formatNeededByLabel(d: Date, currentYear: number): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    month: 'long',
    day: 'numeric',
    ...(d.getUTCFullYear() !== currentYear ? { year: 'numeric' as const } : {}),
  }).format(d);
}

/**
 * The calendar year it currently is FOR THE TENANT — the baseline
 * `formatNeededByLabel` compares against. Tenant-local, not UTC: on
 * December 31st a west-coast tenant is still in the old year for several
 * hours after UTC has rolled over, and labelling their dates off UTC's year
 * would add a spurious "2027" to everything.
 */
function tenantCurrentYear(now: Date, timezone: string | undefined): number {
  const tz = timezone ?? DEFAULT_TENANT_TIMEZONE;
  try {
    return Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric' }).format(now));
  } catch {
    // An invalid IANA zone throws from Intl; resolveSpokenDay falls back to
    // DEFAULT_TENANT_TIMEZONE for the same input, so mirror that here.
    return Number(
      new Intl.DateTimeFormat('en-US', { timeZone: DEFAULT_TENANT_TIMEZONE, year: 'numeric' }).format(now),
    );
  }
}

/** One spoken clause per item — TTS-safe (I2), truncated (M1), needed-by surfaced when present (MAJOR B). */
function describeItem(m: LookupMaterialsItem): string {
  const parts = [`${truncateForSpeech(m.description, MAX_DESCRIPTION_CHARS)}, quantity ${m.quantity}`];
  if (m.vendor) parts.push(`from ${m.vendor}`);
  if (m.neededByLabel) parts.push(`needed by ${m.neededByLabel}`);
  return parts.join(', ');
}

type NeededByScope =
  /** No date phrase was spoken at all — answer the plain pending list. */
  | { kind: 'none' }
  /**
   * A phrase WAS spoken but `resolveSpokenDay` could not turn it into a
   * calendar day ("asap", "soon", "before the Patel job"). Still no filter
   * — but the summary must SAY so (J3); see `lookupMaterials` below.
   */
  | { kind: 'unresolved'; phrase: string }
  | {
      kind: 'day';
      /** `MaterialItemListOptions.neededByFrom` — inclusive start of the resolved day. */
      from: Date;
      /** `MaterialItemListOptions.neededByBefore` — exclusive end of the resolved day. */
      before: Date;
      /** TTS-safe "MMMM d" label for the resolved day, for the summary header. */
      label: string;
    };

/**
 * Resolve `dateTimeDescription` to the resolved day's [from, before) window.
 *
 * Three outcomes, deliberately distinguished (review follow-up J3): absent,
 * present-but-unresolvable, and resolved. The first two both apply NO filter
 * — this skill never falls back to "today" the way
 * `lookup-crew-schedule.ts`'s day resolution does (see the module doc
 * comment) — but they are DIFFERENT FACTS, and collapsing them into one
 * `null` is what let "what do I need asap?" produce a summary byte-identical
 * to an unscoped ask.
 */
function resolveNeededByScope(
  desc: string | undefined,
  now: Date,
  timezone: string | undefined,
  currentYear: number,
): NeededByScope {
  const phrase = desc?.trim();
  if (!phrase) return { kind: 'none' };
  const dayKey = resolveSpokenDay(phrase, { timezone, now });
  if (!dayKey) return { kind: 'unresolved', phrase };
  // `needed_by` is a bare calendar date stored at UTC midnight
  // (add-material-handler.ts) — treat the resolved day the SAME way,
  // never re-projecting it through a timezone a second time (mirrors
  // lookup-crew-schedule.ts's dayLabelForDateKey doc comment: that's
  // exactly how a midnight-UTC date rolls back a day in a western tenant
  // zone). The window is [start of the resolved day, start of the day
  // AFTER it) so "needed by <day>" covers everything due ON that day —
  // and, per K3, NOTHING due before it: the pre-window backlog is counted
  // separately rather than allowed to crowd the answer out.
  const dayStartUtc = new Date(`${dayKey}T00:00:00.000Z`);
  const before = new Date(dayStartUtc.getTime() + 24 * 60 * 60 * 1000);
  return { kind: 'day', from: dayStartUtc, before, label: formatNeededByLabel(dayStartUtc, currentYear) };
}

/**
 * "There are 8 items needed sooner, the earliest on March 1." — the K3
 * disclosure that keeps a boundary-day answer from hiding an overdue
 * backlog. `null` when the pre-window bucket is empty.
 *
 * The count is honest about its own bound the same way `data.count` is: the
 * probe fetches `MAX_SOONER_COUNTED + 1` rows, so a saturated bucket says
 * "more than 20 items" rather than inventing a total. This spelled-out shape
 * was chosen here to avoid the "5+" shape the count phrase above used — a
 * TTS nit (an engine may read the "+" as "plus" or drop it) that was
 * pre-existing and left alone at the time. F3 fixed it there too, so both
 * ceiling-honest counts in this file now read the same way.
 */
function soonerSentence(sooner: MaterialItem[], currentYear: number): string | null {
  if (sooner.length === 0) return null;
  const capped = sooner.length > MAX_SOONER_COUNTED;
  const n = capped ? MAX_SOONER_COUNTED : sooner.length;
  const count = capped ? `more than ${MAX_SOONER_COUNTED}` : String(n);
  // The probe is ordered soonest-`needed_by`-first, so row 0 is the oldest
  // outstanding deadline — the single most useful fact about the backlog.
  const earliest = formatNeededByLabel(sooner[0].neededBy!, currentYear);
  const verb = !capped && n === 1 ? 'is' : 'are';
  return `There ${verb} ${count} ${plural(n, 'item')} needed sooner, the earliest on ${earliest}.`;
}

export async function lookupMaterials(
  input: LookupMaterialsInput,
  deps: LookupMaterialsDeps,
): Promise<LookupMaterialsResult> {
  const start = Date.now();
  const record = async (
    resultStatus: 'found' | 'none' | 'error',
    resultCount: number,
    summary: string,
  ): Promise<void> => {
    if (!deps.lookupEvents) return;
    try {
      await deps.lookupEvents.record({
        tenantId: input.tenantId,
        sessionId: input.sessionId,
        intent: 'lookup_materials',
        resultStatus,
        resultCount,
        summary,
        latencyMs: Date.now() - start,
      });
    } catch {
      /* swallow — an audit-write failure never breaks the spoken turn */
    }
  };

  try {
    const now = input.now ?? new Date();
    const currentYear = tenantCurrentYear(now, input.timezone);
    const scope = resolveNeededByScope(input.dateTimeDescription, now, input.timezone, currentYear);
    const jobScope = input.jobId ? { jobId: input.jobId } : {};

    // K3 — a date-scoped ask is TWO queries, not one open-ended
    // `needed_by < boundary`:
    //   1. the ANSWER: items due ON the resolved day (bracketed window), so
    //      the caller who asked "what do I need for tomorrow?" always hears
    //      tomorrow's items rather than five months-old ones that sorted
    //      ahead of them under the spoken cap;
    //   2. a bounded PROBE of everything due before that day, counted (never
    //      spoken item-by-item) so the same caller is never left unaware the
    //      backlog exists.
    // See the module doc comment for why `needed_by DESC` was rejected: it
    // answers the question asked but buries genuinely urgent overdue work,
    // trading one silent omission for another.
    const items: MaterialItem[] = await deps.materialItemRepo.listPending(input.tenantId, {
      ...jobScope,
      ...(scope.kind === 'day' ? { neededByFrom: scope.from, neededByBefore: scope.before } : {}),
      limit: FETCH_LIMIT,
    });
    const sooner: MaterialItem[] =
      scope.kind === 'day'
        ? await deps.materialItemRepo.listPending(input.tenantId, {
            ...jobScope,
            neededByBefore: scope.from,
            limit: MAX_SOONER_COUNTED + 1,
          })
        : [];
    const soonerPhrase = soonerSentence(sooner, currentYear);

    // J3 — an UNRESOLVED phrase applies no filter (the no-today-guess
    // decision stands), but the caller must hear that their scope was
    // dropped. Silence here made "what do I need asap?" indistinguishable
    // from an unscoped ask, contradicting the sibling contract this design
    // cites as its foil (lookup_crew_schedule "always names the day actually
    // being reported" — docs/reference/voice-action-catalog.md).
    const unresolvedPrefix =
      scope.kind === 'unresolved'
        ? `I couldn't tell which day "${scope.phrase}" meant, so here's ` +
          `${input.jobId ? "this job's full list" : 'the full list'}. `
        : '';

    if (items.length === 0) {
      // Date-scoped emptiness is a DIFFERENT fact than "nothing pending at
      // all" — there could be plenty pending outside this window, so the
      // summary must not claim the whole list is clear (see module doc
      // comment / spec-review MAJOR B precedent for "never silently widen
      // OR narrow a claim past what was actually asked"). N3: the same rule
      // one axis over — a JOB-scoped query may not assert a fact about the
      // tenant's whole list either.
      const emptyBody =
        scope.kind === 'day'
          ? `Nothing on ${input.jobId ? "this job's" : 'the'} materials list is needed by ${scope.label}.`
          : input.jobId
            ? "This job's materials list is clear — nothing pending."
            : 'Your materials list is clear — nothing pending.';
      const summary = unresolvedPrefix + emptyBody + (soonerPhrase ? ` ${soonerPhrase}` : '');
      await record('none', 0, summary);
      return { status: 'none', summary, data: { count: 0, spokenItems: [] } };
    }

    const hasMore = items.length > MAX_ITEMS_SPOKEN;
    const spokenItems: LookupMaterialsItem[] = items.slice(0, MAX_ITEMS_SPOKEN).map((m) => ({
      description: m.description,
      quantity: m.quantity,
      ...(m.vendor ? { vendor: m.vendor } : {}),
      ...(m.neededBy ? { neededByLabel: formatNeededByLabel(m.neededBy, currentYear) } : {}),
    }));

    // F3 — this used to say "5+ items". "+" is a symbol with a LEXICAL
    // reading, which is the class of TTS defect the I2 fix to `×` above was
    // about: Amazon Polly voices it ("five plus items") and Google Cloud TTS
    // drops it entirely, leaving "five items" — indistinguishable from an
    // exact count of five, which destroys the very distinction the capped
    // fetch and `count: null` exist to preserve. Spelled the way
    // `soonerSentence` already spells its own ceiling, so the two
    // ceiling-honest counts in this file now read the same way. Accurate as
    // well as safe: `hasMore` means `items.length > MAX_ITEMS_SPOKEN`, so
    // there really are MORE THAN five, not five-or-more.
    const countPhrase = hasMore
      ? `more than ${MAX_ITEMS_SPOKEN} ${plural(MAX_ITEMS_SPOKEN, 'item')}`
      : `${items.length} ${plural(items.length, 'item')}`;
    const scopePhrase = scope.kind === 'day' ? ` needed by ${scope.label}` : '';
    // A1 (2026-08-10) — the tail names the HORIZON it is hiding. `hasMore`
    // means `FETCH_LIMIT` rows came back, so `items[MAX_ITEMS_SPOKEN]` — the
    // first row the cap omits — is already in hand: no second query, no
    // COUNT, just the one extra row I4 already fetches to detect "more
    // exist". Naming its deadline is what makes the tail informative rather
    // than merely true; see the module doc comment for why a bare "and more
    // beyond that" is not enough on a tenant with a dated backlog.
    //
    // Suppressed on a date-scoped ask: every row there is inside the same
    // resolved DAY window, so the label would just repeat `scope.label`.
    // Suppressed when the first omitted row is UNDATED: everything past it
    // is undated too (undated sorts last), and there is no deadline to name.
    const firstOmitted = hasMore ? items[MAX_ITEMS_SPOKEN] : undefined;
    const omittedHorizon =
      scope.kind !== 'day' && firstOmitted?.neededBy
        ? `, the next needed by ${formatNeededByLabel(firstOmitted.neededBy, currentYear)}`
        : '';
    const summary =
      unresolvedPrefix +
      `${countPhrase} on the materials list${scopePhrase}: ` +
      spokenItems.map(describeItem).join('; ') +
      (hasMore ? `; and more beyond that${omittedHorizon}` : '') +
      (soonerPhrase ? `. ${soonerPhrase}` : '');

    // resultCount is the number of rows actually FETCHED (up to
    // FETCH_LIMIT) — a true, if capped, measurement; never the guessed
    // total `data.count` deliberately withholds once `hasMore` is true.
    await record('found', items.length, summary);
    return {
      status: 'found',
      summary,
      data: {
        count: hasMore ? null : items.length,
        spokenItems,
      },
    };
  } catch (err) {
    const summary = "I'm having trouble pulling up the materials list right now.";
    await record('error', 0, summary);
    return {
      status: 'error',
      summary,
      data: { error: err instanceof Error ? err.message : String(err) },
    };
  }
}

/**
 * U1 — the ONE production implementation of the customer disambiguation hint
 * `"phone · street1, city"`, applied as an `EntityResolver` decorator.
 *
 * ## Why this exists
 *
 * `PgEntityResolver.resolveCustomer` puts the customer's `primary_phone` on
 * `EntityCandidate.hint` and nothing else. That is all the operator sees when
 * two customers share a surname — "I found 2 customers matching Smith … 1.
 * Smith (+14805550104) 2. Smith (+14805550105)" — and it is all the follow-up
 * matcher (`matchDisambiguationFollowUp`, ai/agents/customer-calling/
 * entity-resolution.ts) has to match an answer against. A service business
 * tells two Smiths apart BY ADDRESS: the operator answers "104 Cedar", and
 * without the address in the hint that answer can only be matched by a phone
 * digit coincidence, which is not resolution.
 *
 * The in-app voice adapter used to fix this for ITS surface alone with a
 * private pool-backed query (`enrichCandidatesForDisambiguation`), so the
 * chat surface asked an address-free question and could not match an address
 * answer. Two implementations of one string shape would drift, so there is
 * now exactly one — here — and both in-app surfaces get it by wrapping the
 * resolver they already hold at composition time.
 *
 * ## The `' · '` separator is load-bearing
 *
 * `hintAddressPortion` (the matcher's own parser) splits the hint on `·` and
 * uses only the segments AFTER the first — i.e. it assumes segment 0 is the
 * phone and everything after it is the address. `mergeHint` is the sole
 * producer of that shape, so the producer and the parser agree by
 * construction rather than by comment.
 *
 * ## What it never does
 *
 * - It never changes WHICH ids are offered: `resolved`, `not_found`,
 *   `skipped` and every non-customer kind pass through byte-identical, and an
 *   enriched result carries exactly the same candidate ids, labels and scores.
 *   The enrichment is display/matching TEXT only — the write boundary stays
 *   `applyGatedReferences`'s "known gated field AND currently gated" guard.
 * - It never mutates the underlying resolver's objects (new candidate objects,
 *   new result object).
 * - It never throws or blocks: a location lookup that fails, returns nothing,
 *   or returns only archived rows leaves the original hint exactly as it was.
 *   A degraded hint is the status quo; a failed resolution would be worse.
 *
 * Tenant isolation is re-asserted per candidate: `findByCustomer(tenantId, id)`
 * is tenant-scoped (RLS on `service_locations`), so a candidate id from one
 * tenant can never pick up another tenant's address.
 */
import type { LocationRepository, ServiceLocation } from '../../locations/location';
import type {
  EntityCandidate,
  EntityResolver,
  EntityResolverResult,
} from './entity-resolver';

/** The separator `hintAddressPortion` splits on. Do not change one without the other. */
export const HINT_SEPARATOR = ' · ';

/**
 * How many candidates get a location lookup on one resolve call.
 *
 * `PgEntityResolver.resolveCustomer` already caps its candidate list at 5
 * (`LIMIT 5`), and the question itself lists at most `MAX_LISTED_CANDIDATES`
 * (3). This bound exists so a future resolver with a looser cap cannot turn
 * one ambiguous name into an unbounded fan-out of repo reads. Candidates past
 * the bound keep their original hint — the honest degradation.
 */
export const MAX_HINT_LOOKUPS = 5;

/**
 * Join an existing hint and a service address into the shape the follow-up
 * matcher parses.
 *
 * Pure. Empty parts are dropped, and an address already present in the hint is
 * never appended twice (so re-decorating an already-enriched result — a
 * doubly-wrapped resolver, a retry pass — is idempotent rather than producing
 * `"phone · addr · addr"`, which would make `hintAddressPortion` return the
 * address twice over).
 */
export function mergeHint(existing: string | undefined, address: string | undefined): string | undefined {
  const base = typeof existing === 'string' ? existing.trim() : '';
  const extra = typeof address === 'string' ? address.trim() : '';
  if (!extra) return base.length > 0 ? base : undefined;
  if (!base) return extra;
  if (base.toLowerCase().includes(extra.toLowerCase())) return base;
  return `${base}${HINT_SEPARATOR}${extra}`;
}

/**
 * The address a candidate is best told apart by: the primary active service
 * location, else any active one.
 *
 * Archived rows are excluded outright — an address the tenant retired is not
 * how anyone identifies the customer today, and offering it would invite an
 * answer that matches a record the operator no longer recognizes. Mirrors
 * `listByCustomer`'s active-only filter and the executor's own bookability
 * predicate (`detectServiceLocationGap`: "any non-archived row").
 */
export function pickHintLocation(locations: readonly ServiceLocation[]): ServiceLocation | undefined {
  const active = locations.filter((l) => !l.isArchived);
  if (active.length === 0) return undefined;
  return active.find((l) => l.isPrimary) ?? active[0];
}

/** `"104 QA Cedar Avenue, Phoenix"` — the exact shape the removed adapter query produced. */
export function formatHintAddress(location: ServiceLocation): string | undefined {
  const street1 = typeof location.street1 === 'string' ? location.street1.trim() : '';
  const city = typeof location.city === 'string' ? location.city.trim() : '';
  const parts = [street1, city].filter((p) => p.length > 0);
  return parts.length > 0 ? parts.join(', ') : undefined;
}

/**
 * Decorate `resolver` so AMBIGUOUS / LOW-CONFIDENCE customer results carry the
 * candidate's service address on the hint.
 *
 * Only those two kinds: a `resolved` result is already the answer (no question
 * is asked, so there is nothing to distinguish), and `not_found` / `skipped`
 * have no candidate at all. Non-customer kinds pass straight through — a job,
 * invoice or technician has no service address, and their hints already carry
 * the thing that tells them apart (status, price, role).
 */
export function withCustomerAddressHints(
  resolver: EntityResolver,
  locationRepo: Pick<LocationRepository, 'findByCustomer'>,
): EntityResolver {
  return {
    async resolve(input) {
      const result = await resolver.resolve(input);
      if (input.kind !== 'customer') return result;
      if (result.kind === 'ambiguous') {
        return {
          kind: 'ambiguous',
          candidates: await enrichCandidates(locationRepo, input.tenantId, result.candidates),
        };
      }
      if (result.kind === 'low_confidence') {
        const [enriched] = await enrichCandidates(locationRepo, input.tenantId, [result.candidate]);
        return { kind: 'low_confidence', candidate: enriched ?? result.candidate };
      }
      return result;
    },
  };
}

async function enrichCandidates(
  locationRepo: Pick<LocationRepository, 'findByCustomer'>,
  tenantId: string,
  candidates: readonly EntityCandidate[],
): Promise<EntityCandidate[]> {
  return Promise.all(
    candidates.map(async (candidate, index) => {
      if (index >= MAX_HINT_LOOKUPS) return { ...candidate };
      const address = await addressForCustomer(locationRepo, tenantId, candidate.id);
      const hint = mergeHint(candidate.hint, address);
      // Rebuild rather than spread-and-overwrite so a candidate that had no
      // hint and gained none does not sprout an `undefined` key.
      const { hint: _drop, ...rest } = candidate;
      return hint ? { ...rest, hint } : { ...rest };
    }),
  );
}

async function addressForCustomer(
  locationRepo: Pick<LocationRepository, 'findByCustomer'>,
  tenantId: string,
  customerId: string,
): Promise<string | undefined> {
  try {
    const locations = await locationRepo.findByCustomer(tenantId, customerId);
    if (!Array.isArray(locations) || locations.length === 0) return undefined;
    const location = pickHintLocation(locations);
    return location ? formatHintAddress(location) : undefined;
  } catch {
    // Failure-soft by the resolver's own convention: the question is still
    // asked, just with the hint the underlying resolver produced.
    return undefined;
  }
}

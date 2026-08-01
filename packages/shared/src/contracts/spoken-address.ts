/**
 * Spoken-address parsing + completeness resolution — ONE implementation,
 * shared by the API and the web review card.
 *
 * WHY THIS LIVES IN `shared` AND NOT NEXT TO ITS FIRST CALLER
 * ----------------------------------------------------------
 * A spoken street address was destroyed four separate times on its way from
 * a technician's microphone to `service_locations` — each time by a different
 * intermediate layer that rebuilt an object from an allowlist and silently
 * dropped the key it didn't name (the classifier prompt, `ExtractedEntities`,
 * the intent-classifier sanitizer, and `entitiesForProposal`). Every one of
 * those layers had passing unit tests, because each test hand-fed the layer
 * under test.
 *
 * The address rules now have exactly one home. The execution handler (does a
 * `service_location` get written?), the assistant route (which inputs does the
 * card need?) and the review card (which inputs does it render, prefilled with
 * what?) all call `resolveSpokenAddress` — so "complete" can never mean one
 * thing on the server and another in the UI, and adding a field here surfaces
 * everywhere at once.
 *
 * THE SHAPE IS `service_locations`, NOT AN INVENTION
 * -------------------------------------------------
 * `service_locations` (db/schema.ts migration 015, + 188 for `address_type`)
 * declares `street1`, `city`, `state`, `postal_code` NOT NULL and `country`
 * NOT NULL DEFAULT 'US'; `street2`, `label`, `latitude`, `longitude`,
 * `access_notes` are nullable. `STRUCTURED_ADDRESS_KEYS` below is exactly the
 * free-text address column set; geo/label/access columns are deliberately out
 * of scope (nothing in a spoken utterance or a review card supplies them).
 */

/** The four `service_locations` columns that are NOT NULL and have no default. */
export const REQUIRED_LOCATION_FIELDS = ['street1', 'city', 'state', 'postalCode'] as const;

export type RequiredLocationField = (typeof REQUIRED_LOCATION_FIELDS)[number];

/**
 * Every structured address key a `create_customer` payload may carry, in the
 * order a human reads an address. `country` has a NOT NULL DEFAULT 'US' in the
 * table, so it is optional everywhere here.
 */
export const STRUCTURED_ADDRESS_KEYS = [
  'street1',
  'street2',
  'city',
  'state',
  'postalCode',
  'country',
] as const;

export type StructuredAddressKey = (typeof STRUCTURED_ADDRESS_KEYS)[number];

export type StructuredAddress = Partial<Record<StructuredAddressKey, string>>;

/** A complete address — every NOT NULL `service_locations` column satisfied. */
export interface CompleteAddress {
  street1: string;
  street2?: string;
  city: string;
  state: string;
  postalCode: string;
  country?: string;
}

/** Human labels for the review card's inputs. */
export const ADDRESS_FIELD_LABELS: Record<StructuredAddressKey, string> = {
  street1: 'Street',
  street2: 'Unit / apt',
  city: 'City',
  state: 'State',
  postalCode: 'ZIP',
  country: 'Country',
};

const US_STATE_ABBREVIATIONS = new Set([
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA', 'HI', 'ID', 'IL',
  'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT',
  'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI',
  'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY', 'DC', 'PR',
]);

/**
 * Speech-to-text spells states out ("Arizona"), so a spoken address whose
 * state is a full name must still prefill the card's State input. Normalized
 * to the postal abbreviation, which is what every other write path in the app
 * stores.
 */
const US_STATE_NAMES: Record<string, string> = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA',
  colorado: 'CO', connecticut: 'CT', delaware: 'DE', florida: 'FL', georgia: 'GA',
  hawaii: 'HI', idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA',
  kansas: 'KS', kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD',
  massachusetts: 'MA', michigan: 'MI', minnesota: 'MN', mississippi: 'MS',
  missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV',
  'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY',
  'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK',
  oregon: 'OR', pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC',
  'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT',
  virginia: 'VA', washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI',
  wyoming: 'WY', 'district of columbia': 'DC', 'puerto rico': 'PR',
};

const POSTAL_CODE_RE = /(\d{5}(?:-\d{4})?)\s*$/;

function clean(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim().replace(/[\s,]+$/, '').trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Best-effort PARTIAL parse of a spoken address.
 *
 * Deliberately partial: `1207 Riverbell Drive` yields `{ street1 }` and
 * nothing else, because that is genuinely all the technician said. Returning
 * a partial result is the whole point — the review card prefills what was
 * heard and asks a human for the rest, instead of the caller having to choose
 * between inventing a city and throwing the address away.
 *
 * Reads from the END, which is where the machine-recognisable tokens are:
 *   1. a trailing ZIP (`85254` / `85254-1234`) → `postalCode`
 *   2. then a trailing state (2-letter postal code, or a spelled-out state
 *      name, normalized to the abbreviation) → `state`
 *   3. whatever remains after the first comma → `city`
 *   4. everything before the first comma → `street1`
 *
 * Shapes speech-to-text actually produces, all handled:
 *   "412 Oak Street, Scottsdale, AZ 85254"
 *   "412 Oak Street, Scottsdale, AZ, 85254"
 *   "412 Oak Street, Scottsdale, Arizona 85254"
 *   "412 Oak Street, Scottsdale, 85254"      (no state)
 *   "1207 Riverbell Drive"                   (street only)
 */
export function parseSpokenAddressParts(text: string | undefined): StructuredAddress {
  const source = clean(text);
  if (!source) return {};

  const parts = source
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (parts.length === 0) return {};

  const street1 = parts[0];
  if (parts.length === 1) return { street1 };

  // Everything after the street, comma boundaries flattened — city/state/zip
  // arrive both as "Scottsdale, AZ 85254" and "Scottsdale, AZ, 85254", and the
  // trailing-token scan below reads them identically.
  let rest = parts.slice(1).join(' ').replace(/\s+/g, ' ').trim();

  let postalCode: string | undefined;
  const zipMatch = POSTAL_CODE_RE.exec(rest);
  if (zipMatch) {
    postalCode = zipMatch[1];
    rest = rest.slice(0, zipMatch.index).trim();
  }

  let state: string | undefined;
  const abbrMatch = /(?:^|\s)([A-Za-z]{2})\s*$/.exec(rest);
  if (abbrMatch && US_STATE_ABBREVIATIONS.has(abbrMatch[1].toUpperCase())) {
    state = abbrMatch[1].toUpperCase();
    rest = rest.slice(0, abbrMatch.index).trim();
  } else {
    // Spelled-out state name, longest match first so "West Virginia" wins
    // over "Virginia" and "New York" over a city called "York".
    const lower = rest.toLowerCase();
    const named = Object.keys(US_STATE_NAMES)
      .filter((name) => lower === name || lower.endsWith(` ${name}`))
      .sort((a, b) => b.length - a.length)[0];
    if (named) {
      state = US_STATE_NAMES[named];
      rest = rest.slice(0, rest.length - named.length).trim();
    }
  }

  const city = clean(rest);

  return {
    street1,
    ...(city ? { city } : {}),
    ...(state ? { state } : {}),
    ...(postalCode ? { postalCode } : {}),
  };
}

/**
 * Strict parse: returns a value ONLY when every NOT NULL `service_locations`
 * column is recoverable from the free text. Used by the execution handler to
 * decide whether a spoken address alone can become a location row.
 *
 * We deliberately do NOT fabricate placeholders for missing parts the way the
 * web new-customer form does (`city: 'Unknown', state: 'NA', postalCode:
 * '00000'` in CustomersPage.tsx). Writing invented values into the CRM is
 * worse than surfacing the gap to a human.
 */
export function parseCompleteSpokenAddress(
  text: string | undefined,
): { street1: string; city: string; state: string; postalCode: string } | undefined {
  const parts = parseSpokenAddressParts(text);
  if (!parts.street1 || !parts.city || !parts.state || !parts.postalCode) return undefined;
  return {
    street1: parts.street1,
    city: parts.city,
    state: parts.state,
    postalCode: parts.postalCode,
  };
}

/** Pull the structured address keys off an arbitrary proposal payload. */
export function readStructuredAddress(
  payload: Record<string, unknown> | undefined | null,
): StructuredAddress {
  const out: StructuredAddress = {};
  if (!payload || typeof payload !== 'object') return out;
  for (const key of STRUCTURED_ADDRESS_KEYS) {
    const value = clean(payload[key] as string | undefined);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/**
 * What should happen to the address on a `create_customer` payload.
 *
 *   'none'     — nothing was spoken and nothing was typed. No-op.
 *   'location' — every NOT NULL column is satisfied → write a
 *                `service_locations` row and link it as primary.
 *   'note'     — an address exists but is incomplete. It must be preserved
 *                verbatim on the customer record (see the handler) instead of
 *                being discarded, and `missing` names what a human still owes.
 *
 * Precedence: the approver's structured fields WIN over anything parsed out of
 * the free text — they are the human correction. Parsed values only fill gaps
 * the approver left, so an approver who typed a city the parser disagrees with
 * is never overruled by a regex.
 */
export interface SpokenAddressResolution {
  kind: 'none' | 'location' | 'note';
  /** The technician's verbatim words, preserved exactly as spoken. */
  verbatim?: string;
  /** Present iff `kind === 'location'`. */
  location?: CompleteAddress;
  /** Best-effort values for every field, for prefilling the review card. */
  prefill: StructuredAddress;
  /** Required fields still empty after structured + parsed values are merged. */
  missing: RequiredLocationField[];
}

export function resolveSpokenAddress(
  payload: Record<string, unknown> | undefined | null,
): SpokenAddressResolution {
  const structured = readStructuredAddress(payload);
  const verbatimRaw = payload && typeof payload === 'object' ? payload['address'] : undefined;
  const verbatim = clean(typeof verbatimRaw === 'string' ? verbatimRaw : undefined);
  const parsed = parseSpokenAddressParts(verbatim);

  // Approver-supplied values first; parsed free text only fills the gaps.
  const merged: StructuredAddress = {
    ...parsed,
    ...structured,
  };

  const missing = REQUIRED_LOCATION_FIELDS.filter((field) => !merged[field]);

  if (!verbatim && Object.keys(structured).length === 0) {
    return { kind: 'none', prefill: merged, missing };
  }

  if (missing.length === 0) {
    return {
      kind: 'location',
      ...(verbatim ? { verbatim } : {}),
      location: {
        street1: merged.street1!,
        city: merged.city!,
        state: merged.state!,
        postalCode: merged.postalCode!,
        ...(merged.street2 ? { street2: merged.street2 } : {}),
        ...(merged.country ? { country: merged.country } : {}),
      },
      prefill: merged,
      missing: [],
    };
  }

  return {
    kind: 'note',
    // Nothing was spoken but the approver typed a partial address: the partial
    // structured input IS the address to preserve, so render it back as text.
    verbatim: verbatim ?? formatStructuredAddress(merged),
    prefill: merged,
    missing,
  };
}

/** Render whatever structured pieces exist as one human-readable line. */
export function formatStructuredAddress(parts: StructuredAddress): string {
  const street = [parts.street1, parts.street2].filter(Boolean).join(' ');
  const region = [parts.state, parts.postalCode].filter(Boolean).join(' ');
  return [street, parts.city, region, parts.country]
    .map((segment) => (segment ?? '').trim())
    .filter((segment) => segment.length > 0)
    .join(', ');
}

/**
 * Service-address completion — the review-card control that turns a spoken
 * street address into something `service_locations` can actually hold.
 *
 * THE INCIDENT
 * A technician said "she's over at 1207 Riverbell Drive". The classifier heard
 * it, the router forwarded it, the approval card showed it, the approver
 * approved — and the address was discarded. `service_locations` requires
 * street1/city/state/postal_code NOT NULL, a job-site utterance carries only
 * the street, and the executor (correctly) refused to invent the rest.
 *
 * THE DECISION
 * The approver, already looking at the card, is the one person who knows the
 * city and the ZIP. So we ask them here. We do NOT infer the city from the
 * tenant's service area (silently wrong for an out-of-area job) and we do NOT
 * ask the technician back by voice (friction on the most common action,
 * mid-job).
 *
 * AND IT IS NEVER A BLOCKER
 * The approver may legitimately not know the ZIP. Completing the fields is the
 * obvious path and the consequence of not doing so is stated in plain words,
 * but Approve stays live either way — a dead Approve button on a job site is
 * worse than an incomplete record. The API's fallback (a pinned customer note
 * carrying the verbatim words) is what makes that safe.
 *
 * Lives in `shared/` because both proposal-review surfaces need it — the
 * assistant's AIProposalCard and the inbox, which render proposals with two
 * entirely separate components.
 */
import { MapPin } from 'lucide-react';
import {
  ADDRESS_FIELD_LABELS,
  REQUIRED_LOCATION_FIELDS,
  resolveSpokenAddress,
  type RequiredLocationField,
} from '@ai-service-os/shared';

/**
 * The address slice of a `create_customer` payload. Keys are spelled exactly
 * as `createCustomerPayloadSchema` spells them — a rename here is how this
 * field was lost four times on the way in.
 */
// A `type` alias rather than an `interface` on purpose: TypeScript infers an
// implicit index signature for object type ALIASES but not for interfaces, and
// `resolveSpokenAddress` reads an arbitrary payload record. Declaring this as
// an interface makes every call site need a cast.
export type AddressCapture = {
  address?: string;
  street1?: string;
  street2?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string;
};

export type AddressValues = Record<RequiredLocationField, string>;

/**
 * Should the inputs render at all?
 *
 * `resolveSpokenAddress` is the SAME function the execution handler calls, so
 * "the card thinks something is missing" and "the writer can't create a
 * location" are one computation, not two that must be kept in step.
 */
export function needsAddressCompletion(capture: AddressCapture | undefined): boolean {
  if (!capture) return false;
  return resolveSpokenAddress(capture).kind === 'note';
}

/** The verbatim words to echo back, so the approver can check what was heard. */
export function capturedAddressText(capture: AddressCapture | undefined): string | undefined {
  if (!capture) return undefined;
  return resolveSpokenAddress(capture).verbatim;
}

/** Starting input values: everything the parser could recover from the free text. */
export function initialAddressValues(capture: AddressCapture | undefined): AddressValues {
  const prefill = capture ? resolveSpokenAddress(capture).prefill : {};
  return {
    street1: prefill.street1 ?? '',
    city: prefill.city ?? '',
    state: prefill.state ?? '',
    postalCode: prefill.postalCode ?? '',
  };
}

/** Required fields still empty — drives the live consequence line. */
export function stillMissing(values: AddressValues): RequiredLocationField[] {
  return REQUIRED_LOCATION_FIELDS.filter((key) => values[key].trim().length === 0);
}

/**
 * The approver's values, as proposal-payload edits for
 * `PUT /api/proposals/:id { edits }`.
 *
 * Blank boxes are OMITTED rather than sent as `''`: the payload schema
 * requires `.min(1)` on each field, so an empty string would fail validation
 * and turn "I don't know the ZIP" into a failed approval.
 */
export function addressEditsFrom(
  capture: AddressCapture | undefined,
  values: AddressValues,
): Record<string, string> | undefined {
  if (!needsAddressCompletion(capture)) return undefined;
  const out: Record<string, string> = {};
  for (const key of REQUIRED_LOCATION_FIELDS) {
    const value = values[key].trim();
    if (value.length > 0 && value !== (capture?.[key] ?? '')) out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** The consequence sentence, recomputed on every keystroke. */
export function consequenceCopy(values: AddressValues): string {
  const missing = stillMissing(values);
  if (missing.length === 0) return 'Saved as a service location on approval.';
  const list = missing.map((f) => ADDRESS_FIELD_LABELS[f].toLowerCase()).join(' and ');
  return `Without a ${list} this address is saved as a note, not a service location.`;
}

interface Props {
  capture: AddressCapture;
  values: AddressValues;
  onChange: (next: AddressValues) => void;
  /** Disambiguates input ids when several cards render at once. */
  idPrefix: string;
}

export function ServiceAddressCompletion({ capture, values, onChange, idPrefix }: Props) {
  const verbatim = capturedAddressText(capture);
  return (
    <div
      className="mt-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2"
      data-testid="address-completion"
    >
      <p className="flex items-center gap-1.5 text-xs font-medium text-warning">
        <MapPin size={11} /> Complete the service address
      </p>
      {verbatim && (
        <p className="mt-1 text-xs text-muted-foreground" data-testid="address-verbatim">
          Heard: “{verbatim}”
        </p>
      )}
      <div className="mt-2 grid grid-cols-2 gap-2">
        {REQUIRED_LOCATION_FIELDS.map((key) => (
          <div key={key} className={key === 'street1' ? 'col-span-2' : undefined}>
            <label
              htmlFor={`${idPrefix}-address-${key}`}
              className="block text-xs text-muted-foreground mb-1"
            >
              {ADDRESS_FIELD_LABELS[key]}
            </label>
            <input
              id={`${idPrefix}-address-${key}`}
              data-testid={`address-input-${key}`}
              value={values[key]}
              onChange={(e) => onChange({ ...values, [key]: e.target.value })}
              className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground outline-none focus:border-primary transition-colors"
            />
          </div>
        ))}
      </div>
      <p className="mt-2 text-xs text-warning" data-testid="address-consequence">
        {consequenceCopy(values)}
      </p>
    </div>
  );
}

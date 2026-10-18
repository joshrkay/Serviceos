/**
 * The owner's cell on the onboarding draft: the single home for how it is
 * normalised and validated, so the route, the repository and the
 * onboarding_tenant_settings proposal contract cannot drift apart.
 *
 * Normalisation is `normalizeMobileE164`, the same function the identity step
 * (PUT /api/onboarding/identity) funnels `ownerPhone` through; "canonical"
 * means exactly what that function returns.
 */
import { z } from 'zod';
import { ValidationError } from '../../shared/errors';
import { normalizeMobileE164 } from '../../shared/phone/normalize';

/** Owner-facing. Never echoes the input and carries no library wording. */
export const OWNER_PHONE_INVALID_MESSAGE =
  'That does not look like a US cell number. Include the 10-digit area code, for example (216) 555-0100.';

/** True only for a value that is already in the canonical `+1XXXXXXXXXX` form. */
export function isCanonicalOwnerPhone(value: string): boolean {
  try {
    return normalizeMobileE164(value) === value;
  } catch {
    return false;
  }
}

/**
 * Trim and normalise a typed cell to E.164. Throws the same 400 shape
 * `validate()` produces (`details.issues[{ path, message }]`) naming `field`,
 * so the web can show the message against the right input.
 */
export function parseOwnerPhone(raw: string, field: 'phone' | 'ownerPhone'): string {
  try {
    return normalizeMobileE164(raw.trim());
  } catch {
    throw new ValidationError('Validation failed', { issues: [{ path: field, message: OWNER_PHONE_INVALID_MESSAGE }] });
  }
}

/** Repository and proposal-contract guard: only the canonical form is stored. */
export const OwnerPhoneE164Schema = z.string().refine(isCanonicalOwnerPhone, { message: 'must be a US phone number in E.164 form (e.g. "+15551234567")' });

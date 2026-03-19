/**
 * Converts a date-like input into a Date object anchored to its UTC instant.
 *
 * JavaScript Date always represents an absolute instant; this helper ensures
 * we always persist normalized Date instances (never raw strings / local forms).
 */
export function toUtcDate(input: Date | string): Date {
  const parsed = input instanceof Date ? new Date(input.getTime()) : new Date(input);

  if (Number.isNaN(parsed.getTime())) {
    throw new Error('Invalid date value');
  }

  return new Date(parsed.toISOString());
}


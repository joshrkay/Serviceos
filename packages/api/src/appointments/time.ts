/**
 * Normalize a date-like input into a UTC instant represented by a new Date object.
 *
 * JavaScript Date already stores an absolute UTC timestamp under the hood; this helper
 * ensures we always persist cloned Date instances and avoid leaking caller-owned mutable
 * references into persistence layers.
 */
export function toUtcDate(value: Date): Date {
  return new Date(value.getTime());
}

/**
 * Tenant-timezone-aware date formatting.
 *
 * CLAUDE.md core pattern: "All times: stored UTC, rendered in tenant
 * timezone". The browser default — `new Date(iso).toLocaleString()` —
 * renders in the VIEWER's browser-local timezone, which is wrong for a
 * dispatcher in NYC looking at an appointment scheduled for a customer
 * in PST: the dispatcher sees 4 PM when the appointment is at 1 PM
 * tenant-local. This module routes every date display through the
 * tenant's IANA timezone (sourced from `/api/me` and surfaced via
 * `useTenantTimezone`).
 *
 * All formatters use `Intl.DateTimeFormat` with an explicit `timeZone`
 * option, so the same instant renders the same way for every viewer of
 * the same tenant regardless of their browser locale.
 */

export interface FormatInTenantTzOptions extends Intl.DateTimeFormatOptions {
  /** Defaults to `en-US`; mirrors the existing call sites' locale choice. */
  locale?: string;
}

function toDate(value: Date | string | number): Date {
  return value instanceof Date ? value : new Date(value);
}

/**
 * Format an instant in the tenant's local time. The `options` shape is
 * the same as `Intl.DateTimeFormat`; `timeZone` is overridden with the
 * tenant's value (callers should not pass it themselves).
 */
export function formatInTenantTz(
  value: Date | string | number,
  timezone: string,
  options: FormatInTenantTzOptions = {},
): string {
  const { locale = 'en-US', ...intlOptions } = options;
  const d = toDate(value);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat(locale, { ...intlOptions, timeZone: timezone }).format(d);
}

/** Convenience: "Apr 28" / "Apr 28, 2026". */
export function formatDateInTenantTz(
  value: Date | string | number,
  timezone: string,
  options: { withYear?: boolean; locale?: string } = {},
): string {
  return formatInTenantTz(value, timezone, {
    locale: options.locale,
    month: 'short',
    day: 'numeric',
    year: options.withYear ? 'numeric' : undefined,
  });
}

/** Convenience: "1:30 PM". */
export function formatTimeInTenantTz(
  value: Date | string | number,
  timezone: string,
  options: { locale?: string } = {},
): string {
  return formatInTenantTz(value, timezone, {
    locale: options.locale,
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** Convenience: "Apr 28, 2026, 1:30 PM". */
export function formatDateTimeInTenantTz(
  value: Date | string | number,
  timezone: string,
  options: { locale?: string } = {},
): string {
  return formatInTenantTz(value, timezone, {
    locale: options.locale,
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

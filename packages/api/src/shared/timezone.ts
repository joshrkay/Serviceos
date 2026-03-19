export const VALID_TIMEZONES = [
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Phoenix',
  'America/Anchorage',
  'Pacific/Honolulu',
  'America/Detroit',
  'America/Indiana/Indianapolis',
  'America/Boise',
  'UTC',
] as const;

export type SupportedTimezone = (typeof VALID_TIMEZONES)[number];

export function isValidTimezone(timezone: string): timezone is SupportedTimezone {
  return VALID_TIMEZONES.includes(timezone as SupportedTimezone);
}

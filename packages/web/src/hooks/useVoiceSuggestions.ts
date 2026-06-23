/**
 * Per-route "you can say…" example utterances for the voice bar.
 *
 * The voice-first promise only lands if the owner knows what they can say. This
 * surfaces 2–3 real, route-relevant utterances next to the idle mic. Every
 * suggestion is something the stack actually handles — either a nav command
 * (see useVoiceCommands.ts) or a free-text assistant request (the same
 * vocabulary as AssistantPage's SUGGESTIONS) — so tapping one and sending it
 * always does something real, never a dead end.
 *
 * Pure `suggestionsForPath` (no hook/router) so it is trivially unit-testable;
 * `useVoiceSuggestions` wraps it with the current route.
 */
import { useLocation } from 'react-router';

interface RouteSuggestions {
  /** Matches the current pathname; first match wins, so list specific first. */
  match: (pathname: string) => boolean;
  suggestions: readonly string[];
}

const startsWith = (...prefixes: string[]) => (pathname: string) =>
  prefixes.some((p) => pathname === p || pathname.startsWith(`${p}/`));

/**
 * Route → suggestions. Ordered most-specific-first; the generic home set is the
 * fallback for `/` and any route without its own entry. Kept to 2–3 each so the
 * strip never dominates the bar.
 */
const ROUTE_SUGGESTIONS: readonly RouteSuggestions[] = [
  {
    match: startsWith('/schedule', '/dispatch'),
    suggestions: [
      "What's on tomorrow's schedule?",
      "Who's free Thursday morning?",
      'Schedule Thompson exterior paint',
    ],
  },
  {
    match: startsWith('/jobs'),
    suggestions: ["Show today's jobs", 'Create a new job', 'Invoice the Rodriguez job'],
  },
  {
    match: startsWith('/customers', '/leads'),
    suggestions: ['Add a new customer', 'Send follow-up to Davis', 'Show customers'],
  },
  {
    match: startsWith('/estimates'),
    suggestions: ['Create a new estimate', 'Schedule Thompson exterior paint', 'Show estimates'],
  },
  {
    match: startsWith('/invoices'),
    suggestions: ['Invoice the Rodriguez job', 'Any overdue invoices?', 'Send follow-up to Davis'],
  },
  {
    match: startsWith('/inbox', '/comms-inbox'),
    suggestions: ['Any overdue invoices?', "What's on today's schedule?", 'Send follow-up to Davis'],
  },
];

/** Generic fallback (home + any unlisted route). */
export const DEFAULT_VOICE_SUGGESTIONS: readonly string[] = [
  "What's on today's schedule?",
  'Any overdue invoices?',
  'Invoice the Rodriguez job',
];

/** Pure: the 2–3 suggestions for a pathname. Always returns a non-empty list. */
export function suggestionsForPath(pathname: string): string[] {
  const entry = ROUTE_SUGGESTIONS.find((r) => r.match(pathname));
  return [...(entry?.suggestions ?? DEFAULT_VOICE_SUGGESTIONS)];
}

/** Route-aware suggestions for the current location. */
export function useVoiceSuggestions(): string[] {
  const { pathname } = useLocation();
  return suggestionsForPath(pathname);
}

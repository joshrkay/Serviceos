/**
 * Per-route "you can say…" suggestions for the VoiceBar idle state.
 */

export interface VoiceSuggestion {
  text: string;
}

const DEFAULT_SUGGESTIONS: VoiceSuggestion[] = [
  { text: "What's on today's schedule?" },
  { text: 'Show me overdue invoices' },
  { text: 'Invoice the Rodriguez job' },
];

const ROUTE_SUGGESTIONS: Array<{ test: (path: string) => boolean; items: VoiceSuggestion[] }> = [
  {
    test: (p) => p.startsWith('/schedule'),
    items: [
      { text: "Who's free Thursday morning?" },
      { text: 'Reschedule the Thompson appointment' },
      { text: "What's on tomorrow's schedule?" },
    ],
  },
  {
    test: (p) => p.startsWith('/jobs'),
    items: [
      { text: "Show today's jobs" },
      { text: 'Create a job for Acme Plumbing' },
      { text: 'Mark the Johnson job complete' },
    ],
  },
  {
    test: (p) => p.startsWith('/customers'),
    items: [
      { text: 'Add a new customer' },
      { text: 'Look up the Davis account' },
      { text: 'Send follow-up to Davis' },
    ],
  },
  {
    test: (p) => p.startsWith('/estimates'),
    items: [
      { text: 'Draft an estimate for the water heater' },
      { text: 'Send estimate nudge to Johnson' },
      { text: 'Show recent estimates' },
    ],
  },
  {
    test: (p) => p.startsWith('/invoices'),
    items: [
      { text: 'Invoice the Rodriguez job' },
      { text: 'Any overdue invoices?' },
      { text: 'Record a payment for Acme' },
    ],
  },
  {
    test: (p) => p.startsWith('/onboarding'),
    items: [
      { text: 'My business is Acme HVAC' },
      { text: 'We do residential installs' },
      { text: 'Add a standard service call' },
    ],
  },
];

export function useVoiceSuggestions(pathname: string): VoiceSuggestion[] {
  const match = ROUTE_SUGGESTIONS.find((r) => r.test(pathname));
  return match?.items ?? DEFAULT_SUGGESTIONS;
}

// Pure (RN-free) mapping from a notification's `data` payload to an in-app
// route. The server sets `data = { proposalId, kind, screen }` (see
// proposal-push-notifier). Both kinds (needs_approval, executed) open the
// proposal review screen. Kept pure so it unit-tests without expo-notifications.

export interface NotificationData {
  proposalId?: unknown;
  kind?: unknown;
  screen?: unknown;
}

/**
 * The screen path a tapped notification should open, or null when there's
 * nothing actionable. Prefers an explicit `screen` path; otherwise derives the
 * proposal review route from `proposalId`.
 */
export function routeForNotification(data: NotificationData | null | undefined): string | null {
  if (!data) return null;
  if (typeof data.screen === 'string' && data.screen.startsWith('/')) return data.screen;
  if (typeof data.proposalId === 'string' && data.proposalId.length > 0) {
    return `/proposals/${data.proposalId}`;
  }
  return null;
}

// Pure (RN-free) mapping from a notification's `data` payload to an in-app
// route. The server sets `data = { type, screen, entityId?, proposalId?, kind? }`
// (see the shared notification contract). Kept pure so it unit-tests without
// expo-notifications.
import type { NotificationData } from '@ai-service-os/shared';

// The notification `data` can be any wire-shape (the producer is trusted but
// versions skew, and cold-start payloads come back loosely typed from the OS).
// Route off a structurally-loose view rather than the strict Zod type so an
// older/extra-field payload still routes instead of throwing.
type RawNotificationData = Partial<NotificationData> & Record<string, unknown>;

// Home — the safe fallback when a payload carries no actionable, allowlisted
// destination. We always land somewhere rather than returning null/throwing.
const HOME_ROUTE = '/';

// Screens a notification is allowed to deep-link to. Detail routes take a
// single id segment (`/customers/<id>`); list routes match exactly. Any path
// outside this set falls back to Home — the client never trusts an arbitrary
// server-supplied path.
const DETAIL_ROUTE_PREFIXES = ['/customers/', '/messages/', '/proposals/', '/jobs/'] as const;
const EXACT_ROUTES = new Set(['/schedule', '/today', '/invoices', '/approvals']);

/**
 * True when `screen` is an absolute path the app is permitted to navigate to:
 * an exact list route, or a detail route with a single non-empty id segment
 * (no nested paths, which would escape the known screens).
 */
function isAllowedScreen(screen: string): boolean {
  if (EXACT_ROUTES.has(screen)) return true;
  for (const prefix of DETAIL_ROUTE_PREFIXES) {
    if (!screen.startsWith(prefix)) continue;
    const id = screen.slice(prefix.length);
    // Exactly one segment: a non-empty id with no further '/'.
    return id.length > 0 && !id.includes('/');
  }
  return false;
}

/**
 * The screen path a tapped notification should open. Prefers an explicit
 * `screen` when it passes the allowlist; otherwise derives the proposal review
 * route from the legacy `proposalId` field. Falls back to Home for an
 * unknown/disallowed/empty/malformed payload — it never returns null or throws,
 * so a tap always lands the owner somewhere.
 */
export function routeForNotification(data: RawNotificationData | null | undefined): string {
  if (!data) return HOME_ROUTE;
  if (typeof data.screen === 'string' && isAllowedScreen(data.screen)) return data.screen;
  if (typeof data.proposalId === 'string' && data.proposalId.length > 0) {
    return `/proposals/${data.proposalId}`;
  }
  return HOME_ROUTE;
}

// U4 (B7) — the types that raise the Home emergency banner. Deliberately
// narrower than HIGH_PRIORITY_NOTIFICATION_TYPES: incoming_call is
// high-priority for sound/alert purposes but has its own surface (Calls) and
// would make the banner noisy.
const EMERGENCY_BANNER_TYPES = new Set(['escalation', 'emergency']);

/** True when a foreground-arrived notification should raise the Home
 *  emergency banner (B7 — emergency dispatch / on-call escalation). */
export function isEmergencyNotification(
  data: RawNotificationData | null | undefined,
): boolean {
  return Boolean(data && typeof data.type === 'string' && EMERGENCY_BANNER_TYPES.has(data.type));
}

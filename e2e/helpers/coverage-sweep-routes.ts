/**
 * Coverage-sweep route list — single source of truth for the routes the
 * `coverage-sweep.spec.ts` Playwright spec visits.
 *
 * Why this lives in its own file:
 *   1. It's imported by the spec, which means `npx playwright test --list`
 *      can enumerate one sub-test per route at collection time.
 *   2. New routes are added in ONE place — the array below — without
 *      touching the spec logic.
 *
 * The list is derived BY HAND from `packages/web/src/routes.ts` to keep
 * Playwright's collection deterministic (parsing `createBrowserRouter` at
 * runtime requires a Vite build of the React bundle, which we don't want).
 *
 * The accompanying test in `routes.test.ts` and the router file itself are
 * the contract — if you add a route there, add it here too. The runbook
 * documents the workflow.
 *
 * Categories:
 *   - "app"    → routes inside the ProtectedRoute / Shell. Need auth.
 *                Coverage sweep asserts these load cleanly.
 *   - "public" → fullscreen routes that may be public (login/signup) or
 *                token-gated (pay/:id, e/:id). The sweep visits the public
 *                ones only; token-gated routes are skipped because there is
 *                no deterministic fixture token.
 */

export type SweepRouteCategory = 'app' | 'public';

export interface SweepRoute {
  /** Path to navigate to. Absolute (starts with `/`). */
  path: string;
  /** Short human label used in the test title. */
  label: string;
  category: SweepRouteCategory;
  /**
   * When set, the sweep tolerates this HTTP status from data fetches on
   * this route. Useful for dynamic-id pages that hit fixture IDs which may
   * legitimately 404 in a fresh DB — the PAGE itself should still render.
   * Default: 2xx only.
   */
  allowApiStatuses?: number[];
  /**
   * Skip click-handler enforcement on this route. Some routes intentionally
   * render visual-only buttons (e.g. landing CTAs that link to Clerk-hosted
   * pages). Default: false (enforce).
   */
  skipButtonAudit?: boolean;
}

/**
 * Stable fixture ID used for dynamic-segment routes. Any UUID-shaped string
 * works — the routes should render an "not found" empty state rather than
 * crashing. The sweep tolerates 404 from the data fetch for these routes
 * (see `allowApiStatuses`) but still enforces (a) page loads, (b) no
 * console errors, (c) buttons are wired.
 *
 * BUG-4 (button with no onClick) was discovered on a real customer detail
 * page — using a fixture ID here means we'd have caught it.
 */
export const FIXTURE_ID = '00000000-0000-0000-0000-000000000001';

export const SWEEP_ROUTES: SweepRoute[] = [
  // ── App shell routes (auth-gated) ─────────────────────────────────────
  { path: '/', label: 'home', category: 'app' },
  { path: '/assistant', label: 'assistant', category: 'app' },
  { path: '/jobs', label: 'jobs-list', category: 'app' },
  { path: '/jobs/new', label: 'jobs-new', category: 'app' },
  {
    path: `/jobs/${FIXTURE_ID}`,
    label: 'jobs-detail',
    category: 'app',
    allowApiStatuses: [404],
  },
  { path: '/schedule', label: 'schedule', category: 'app' },
  { path: '/customers', label: 'customers-list', category: 'app' },
  {
    path: `/customers/${FIXTURE_ID}`,
    label: 'customers-detail',
    category: 'app',
    allowApiStatuses: [404],
  },
  {
    path: `/customers/${FIXTURE_ID}/edit`,
    label: 'customers-edit',
    category: 'app',
    allowApiStatuses: [404],
  },
  {
    path: `/appointments/${FIXTURE_ID}/edit`,
    label: 'appointments-edit',
    category: 'app',
    allowApiStatuses: [404],
  },
  { path: '/leads', label: 'leads-list', category: 'app' },
  { path: '/leads/new', label: 'leads-new', category: 'app' },
  {
    path: `/leads/${FIXTURE_ID}`,
    label: 'leads-detail',
    category: 'app',
    allowApiStatuses: [404],
  },
  { path: '/estimates', label: 'estimates-list', category: 'app' },
  { path: '/estimates/new', label: 'estimates-new', category: 'app' },
  { path: '/invoices', label: 'invoices-list', category: 'app' },
  { path: '/invoices/new', label: 'invoices-new', category: 'app' },
  { path: '/contracts', label: 'contracts-list', category: 'app' },
  {
    path: `/contracts/${FIXTURE_ID}`,
    label: 'contracts-detail',
    category: 'app',
    allowApiStatuses: [404],
  },
  { path: '/interactions', label: 'interactions', category: 'app' },
  { path: '/settings', label: 'settings', category: 'app' },
  { path: '/settings/templates', label: 'settings-templates', category: 'app' },
  { path: '/settings/price-book', label: 'settings-price-book', category: 'app' },
  { path: '/settings/feedback', label: 'settings-feedback', category: 'app' },
  { path: '/settings/language', label: 'settings-language', category: 'app' },
  { path: '/reports/revenue-by-source', label: 'reports-revenue', category: 'app' },
  { path: '/technician/day', label: 'technician-day', category: 'app' },

  // ── Fullscreen flows that don't require Shell ─────────────────────────
  // `/onboarding` is auth-gated even though it has no Shell. Visit only when
  // we have a real session.
  { path: '/onboarding', label: 'onboarding', category: 'app' },
];

/**
 * Public, unauthenticated routes the sweep also visits (no session required).
 * These must render cleanly for anonymous visitors — they are the BUG-8 class
 * of "no route registered → 404 from the SPA shell".
 */
export const PUBLIC_SWEEP_ROUTES: SweepRoute[] = [
  { path: '/login', label: 'login', category: 'public', skipButtonAudit: true },
  { path: '/signup', label: 'signup', category: 'public', skipButtonAudit: true },
];

/**
 * Console-error allowlist. Be tight — every entry here is a potential mask
 * over a real bug. Document WHY each pattern is here. Patterns are matched
 * as substrings of the full console message (including any args).
 */
export const CONSOLE_ERROR_ALLOWLIST: readonly string[] = [
  // Vite injects a "Failed to load resource" warning when a non-existent
  // font / asset is hot-loaded in dev. Production builds don't emit this.
  // Filter only "Failed to load resource" coming from .woff/.woff2/.ttf.
  'Failed to load resource: the server responded with a status of 404 (Not Found)\n  /fonts/',
  // React's intentional dev-only StrictMode double-invoke warnings.
  // Form: "Warning: ...". They are noise, never blockers.
  'Warning: ReactDOM.render is no longer supported',
  // Clerk emits a dev-mode banner about test keys — informational.
  'Clerk has been loaded with development keys',
];

/**
 * Fetch-status allowlist. Routes can opt-in to extra statuses via the
 * `allowApiStatuses` field on each `SweepRoute`. Independent of that, any
 * status in this global list is tolerated everywhere (e.g. 401 on a
 * protected API call when running unauthenticated, which is correct).
 */
export const GLOBAL_FETCH_ALLOWLIST: readonly number[] = [];

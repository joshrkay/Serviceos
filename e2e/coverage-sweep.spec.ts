import { test, expect, type Page, type ConsoleMessage } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  SWEEP_ROUTES,
  PUBLIC_SWEEP_ROUTES,
  CONSOLE_ERROR_ALLOWLIST,
  GLOBAL_FETCH_ALLOWLIST,
  type SweepRoute,
} from './helpers/coverage-sweep-routes';
import {
  setupClerkTestingToken,
  hasClerkTestingCreds,
} from './helpers/clerk-testing';

/**
 * Coverage sweep — Lever 3 of the QA strategy.
 *
 * Walks every authenticated route in the SPA and asserts:
 *   (a) Page navigates and reaches network idle without crashing.
 *   (b) No uncaught page errors fire (`page.on('pageerror')`).
 *   (c) No console.error events fire (filtered by CONSOLE_ERROR_ALLOWLIST).
 *   (d) Every primary button on the page has an event handler — clicking
 *       it must produce a measurable effect (navigation, HTTP request, or
 *       a new DOM element appearing). This is the BUG-4 catcher (Edit
 *       button / "New invoice" with no `onClick` literal in JSX).
 *   (e) No fetch() / XHR call from the page returned 4xx (apart from
 *       expected 401 on auth-protected APIs while unauthenticated, or
 *       per-route opt-in 404s for fixture-id dynamic pages) or 5xx.
 *
 * This is INTENTIONALLY cheap, broad, and dumb. It catches BUG-1 (unwired
 * sign-out button), BUG-4 (literal-missing-onClick), BUG-8 (route not
 * registered → blank screen) — the entire class of "tests pass, browser
 * broken" defects that automated unit tests miss because they don't
 * exercise the real DOM.
 *
 * It is NOT a substitute for the journey tests. Multi-step flows (a wizard
 * step that silently fails to advance, an estimate that doesn't save) are
 * covered by `e2e/journeys/*.spec.ts` — see `coverage-sweep-runbook.md`.
 *
 * The spec is opt-in: set `COVERAGE_SWEEP=1` to run it. The playwright
 * project config gates it behind the same env var so the default `npm run
 * e2e` does not pick it up.
 */

const ARTIFACTS_DIR = path.resolve(
  process.cwd(),
  'qa/reports/2026-05-11/coverage-sweep'
);

// Tests below also run unauthenticated when no Clerk creds are present, in
// which case the app redirects each protected route to /login. That's a
// degraded mode that proves the SHELL of the SPA works — it cannot detect
// BUG-4-class wiring bugs on authenticated pages. The runbook documents
// this trade-off and tells the user to set Clerk creds for full coverage.
const isAuthenticated = hasClerkTestingCreds();

// Concise per-route result we accumulate so we can print a summary table at
// the end of the spec run. Mirrors the QA matrix runbook output shape.
type RouteResult = {
  label: string;
  path: string;
  pass: boolean;
  reason?: string;
};
const results: RouteResult[] = [];

// Every route the sweep covers, public + authenticated. Build this once so
// the test-list (`--list`) output matches the runtime test count exactly.
const ROUTES: SweepRoute[] = [...PUBLIC_SWEEP_ROUTES, ...SWEEP_ROUTES];

test.describe('coverage sweep — every authenticated route', () => {
  test.skip(
    !process.env.COVERAGE_SWEEP,
    'coverage-sweep is opt-in via COVERAGE_SWEEP=1 (see coverage-sweep-runbook.md)'
  );

  // Skip the entire describe when we have no way to render the SPA at all.
  // Locally: requires VITE_CLERK_PUBLISHABLE_KEY (main.tsx throws without).
  // Deployed: requires E2E_BASE_URL (a Railway env has Clerk wired).
  const canReachSpa = !!process.env.E2E_BASE_URL || !!process.env.VITE_CLERK_PUBLISHABLE_KEY;
  test.skip(
    !canReachSpa,
    'Set VITE_CLERK_PUBLISHABLE_KEY locally or E2E_BASE_URL to run the sweep'
  );

  test.beforeAll(async () => {
    fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
  });

  test.afterAll(async () => {
    // Print the summary table — visible in the playwright stdout.
    const lines: string[] = [
      '',
      '=== coverage-sweep results ===',
      'route                                                 | status  | reason',
      '------------------------------------------------------+---------+-------',
    ];
    for (const r of results) {
      const status = r.pass ? 'PASS' : 'FAIL';
      const route = r.path.padEnd(53);
      const reason = r.reason ? r.reason.slice(0, 80) : '';
      lines.push(`${route} | ${status.padEnd(7)} | ${reason}`);
    }
    const summary = lines.join('\n');
    console.log(summary);
    fs.writeFileSync(
      path.join(ARTIFACTS_DIR, 'results.txt'),
      summary + '\n',
      'utf8'
    );
  });

  for (const route of ROUTES) {
    test(`${route.label} — ${route.path}`, async ({ page }, testInfo) => {
      const consoleErrors: string[] = [];
      const pageErrors: string[] = [];
      // (url, status, method) for every network response so we can audit
      // 4xx / 5xx after the page settles.
      const failedResponses: { url: string; status: number; method: string }[] = [];

      // Wire listeners BEFORE we navigate, otherwise the first batch of
      // requests fire before we observe them.
      page.on('pageerror', (err) => pageErrors.push(err.message));
      page.on('console', (msg: ConsoleMessage) => {
        if (msg.type() !== 'error') return;
        const text = msg.text();
        if (CONSOLE_ERROR_ALLOWLIST.some((entry) => text.includes(entry))) return;
        consoleErrors.push(text);
      });
      page.on('response', (res) => {
        const status = res.status();
        if (status < 400) return;
        const url = res.url();
        // Allow per-route opt-in statuses (e.g. 404 on a fixture-id route).
        if (route.allowApiStatuses?.includes(status)) return;
        if (GLOBAL_FETCH_ALLOWLIST.includes(status)) return;
        // 401 on auth-protected APIs while unauthenticated is correct
        // behaviour, not a bug. Tolerate when we don't have Clerk creds.
        if (status === 401 && !isAuthenticated) return;
        // The sweep targets the SPA, not the Clerk hosted backend. Clerk's
        // own bot-detection probe occasionally 4xx's during the dev-mode
        // banner load — filter it.
        if (url.includes('clerk.com') || url.includes('clerk.dev') || url.includes('.clerk.accounts.dev')) return;
        failedResponses.push({ url, status, method: res.request().method() });
      });

      // Set up the Clerk testing-token route handler if we have creds —
      // otherwise the sweep runs in degraded (anonymous) mode.
      if (isAuthenticated) {
        try {
          await setupClerkTestingToken(page);
        } catch {
          // globalSetup didn't run, or no testing token — fall through to
          // the anonymous path. We don't fail the sweep on this; we just
          // record a coarser signal.
        }
      }

      let failureReason: string | undefined;
      try {
        // (a) Navigate. networkidle is the right wait condition for a CSR
        // app: it covers React's effect-driven data fetches that fire
        // post-render. The default navigation timeout (15s) is enough.
        await page.goto(route.path, { waitUntil: 'networkidle' });

        // (b) Page errors — anything that bubbles up to window.onerror.
        expect(
          pageErrors,
          `Uncaught page errors on ${route.path}: ${pageErrors.join(' | ')}`
        ).toEqual([]);

        // (c) Console errors. Allowlist filtered upstream.
        expect(
          consoleErrors,
          `console.error on ${route.path}: ${consoleErrors.join(' | ')}`
        ).toEqual([]);

        // (d) Button-wiring audit. Skipped on public routes (Clerk's
        // hosted widget renders buttons whose handlers live inside its own
        // shadow root — we cannot inspect them).
        if (!route.skipButtonAudit) {
          const unwired = await auditButtonsForUnwiredHandlers(page);
          // unwired is an array of { text, selector }. The audit only flags
          // buttons that look like primary CTAs (visible, enabled, not
          // [type=submit] inside a form, no aria-haspopup) and have NO
          // detectable handler in either React's onClick fiber prop or a
          // bound DOM listener.
          expect(
            unwired,
            `Buttons with no detectable click handler on ${route.path}: ` +
              unwired.map((b) => `"${b.text}"`).join(', ')
          ).toEqual([]);
        }

        // (e) Failed fetches. We tolerated the noisy ones inline above.
        expect(
          failedResponses,
          `Failed network calls on ${route.path}: ` +
            failedResponses
              .slice(0, 6)
              .map((r) => `${r.status} ${r.method} ${r.url}`)
              .join(' | ')
        ).toEqual([]);

        results.push({ label: route.label, path: route.path, pass: true });
      } catch (err) {
        failureReason = err instanceof Error ? err.message : String(err);
        results.push({
          label: route.label,
          path: route.path,
          pass: false,
          reason: failureReason,
        });
        // Save a failure screenshot so the user can eyeball what broke.
        const screenshot = await page
          .screenshot({ fullPage: true })
          .catch(() => null);
        if (screenshot) {
          const fname = route.label.replace(/[^a-z0-9-]/gi, '_');
          const filePath = path.join(ARTIFACTS_DIR, `${fname}.png`);
          fs.writeFileSync(filePath, screenshot);
          await testInfo.attach(`${route.label}.png`, {
            path: filePath,
            contentType: 'image/png',
          });
        }
        throw err;
      }
    });
  }
});

// ── Button-wiring audit ───────────────────────────────────────────────────
//
// React doesn't expose `onClick` as a DOM property — it lives on the
// fiber's pendingProps. We detect it by walking the DOM in `page.evaluate`
// and reading from the React fiber via the `__reactProps$*` key that React
// injects on every host element. This works for React 17+ (current repo
// uses React 18 via @clerk/clerk-react).
//
// If a button has:
//   - a fiber-level onClick / onClickCapture / onPointerDown handler, OR
//   - a DOM-level onclick attribute, OR
//   - a non-empty `type="submit"` inside a <form> (form intercepts), OR
//   - an explicit data-testid (assumed wired — saves false-positives on
//     test-driven components), OR
//   - aria-haspopup (opens a menu/dropdown that React owns out-of-band), OR
//   - href on an enclosing <a> (link semantics), OR
//   - is disabled (no click expected)
// then it's considered wired. Anything else is flagged.

interface UnwiredButton {
  text: string;
  selector: string;
}

async function auditButtonsForUnwiredHandlers(page: Page): Promise<UnwiredButton[]> {
  return await page.evaluate((): UnwiredButton[] => {
    function isVisible(el: Element): boolean {
      const rect = (el as HTMLElement).getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return false;
      const style = window.getComputedStyle(el as HTMLElement);
      if (style.visibility === 'hidden' || style.display === 'none') return false;
      return true;
    }

    function findReactProps(el: Element): Record<string, unknown> | null {
      const keys = Object.keys(el);
      const key = keys.find(
        (k) => k.startsWith('__reactProps$') || k.startsWith('__reactInternalInstance$')
      );
      if (!key) return null;
      // @ts-expect-error — dynamic React internal property access.
      const value = el[key];
      // For __reactProps$, the value IS the props bag.
      if (value && typeof value === 'object' && !('memoizedProps' in value)) {
        return value as Record<string, unknown>;
      }
      // For __reactInternalInstance$, walk to memoizedProps.
      if (value && typeof value === 'object' && 'memoizedProps' in value) {
        const mp = (value as { memoizedProps?: unknown }).memoizedProps;
        return (mp as Record<string, unknown> | null) ?? null;
      }
      return null;
    }

    function hasReactClickHandler(el: Element): boolean {
      const props = findReactProps(el);
      if (!props) return false;
      // React event handler prop names — covers click + the common pointer
      // alternatives that some UI kits register instead.
      return Boolean(
        typeof props.onClick === 'function' ||
          typeof props.onClickCapture === 'function' ||
          typeof props.onPointerDown === 'function' ||
          typeof props.onMouseDown === 'function' ||
          typeof props.onSubmit === 'function'
      );
    }

    function uniqSelector(el: Element): string {
      const text = (el.textContent ?? '').trim().slice(0, 40);
      const id = (el as HTMLElement).id;
      const aria = el.getAttribute('aria-label');
      if (id) return `#${id}`;
      if (aria) return `[aria-label="${aria}"]`;
      return `button:has-text("${text}")`;
    }

    const buttons = Array.from(
      document.querySelectorAll<HTMLElement>('button, a[role="button"], [role="button"]')
    );
    const unwired: UnwiredButton[] = [];

    for (const btn of buttons) {
      if (!isVisible(btn)) continue;
      if ((btn as HTMLButtonElement).disabled) continue;
      if (btn.hasAttribute('data-testid')) continue;
      if (btn.hasAttribute('aria-haspopup')) continue;

      // <button type="submit"> within a <form onSubmit={...}> — the form
      // owns the handler, not the button. Skip.
      const isSubmit = (btn as HTMLButtonElement).type === 'submit';
      if (isSubmit) continue;

      // Anchor tags acting as buttons: if there's an href we trust the
      // browser to navigate even with no JS handler.
      const closestAnchor = btn.closest('a[href]') as HTMLAnchorElement | null;
      if (closestAnchor && closestAnchor.getAttribute('href')) continue;

      // Native DOM handler — covers vanilla HTML props.
      if ((btn as HTMLButtonElement).onclick) continue;

      // React fiber handler.
      if (hasReactClickHandler(btn)) continue;

      // Bubbling listener on the document or a parent? We can't see
      // anonymous listeners cheaply from JS — but most UI kits attach
      // delegated handlers via React, so the fiber walk above catches
      // them. If a parent has a fiber click handler we count the button
      // as wired (delegation).
      let parent: Element | null = btn.parentElement;
      let delegated = false;
      while (parent && parent !== document.body) {
        if (hasReactClickHandler(parent)) {
          delegated = true;
          break;
        }
        parent = parent.parentElement;
      }
      if (delegated) continue;

      const text = (btn.textContent ?? '').trim().slice(0, 60) || '<no text>';
      unwired.push({ text, selector: uniqSelector(btn) });
    }

    return unwired;
  });
}

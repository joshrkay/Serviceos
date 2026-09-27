import { test, expect, skipUnlessAuthedStack, dismissWhatsNewModal } from './helpers/dev-auth';
import type { APIRequestContext, Page } from '@playwright/test';

/**
 * #1398 — the mobile bar (CLAUDE.md) for PAGE-level controls: on every main
 * route, every visible button / link / form control / switch / radio /
 * checkbox is at least 44×44, and nothing overflows horizontally at 320px.
 * Shell chrome is covered separately by e2e/shell-mobile.spec.ts; this spec
 * sweeps the same routes the 2026-09-26 QA sweep (#1307 §14) measured.
 *
 * jsdom can't measure layout, so the per-component class contracts live next
 * to each component (`*.tap-targets.test.tsx`); this spec measures the real
 * boxes in Chromium.
 *
 * Runs under the chromium-devauth project (seeded InMemory owner tenant).
 */

const DEV_TOKEN =
  'eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJzdWIiOiJkZXZfb3duZXIiLCJzaWQiOiJkZXYtc2Vzc2lvbiIsInJvbGUiOiJvd25lciJ9.x';

const MIN = 44;

const STATIC_ROUTES = [
  '/',
  '/assistant',
  '/jobs',
  '/schedule',
  '/customers',
  '/comms-inbox',
  '/leads',
  '/estimates',
  '/invoices',
  '/interactions',
  '/digest',
  '/settings',
  '/inbox',
  '/customers/new',
];

/**
 * Deliberately tiny. Each entry is a control that is NOT a standalone tap
 * target, matched on `${tag} "${accessible name}"`.
 */
const ALLOWLIST: RegExp[] = [
  // /settings — inline-text links inside a sentence of the intake / booking
  // link cards ("…appear in your Lead Pipeline automatically", "…an approval
  // in your approval queue…"). Each sits next to its card's full-size actions.
  /^button "Lead Pipeline" /,
  /^button "approval queue" /,
];

const INTERACTIVE =
  'button, a[href], input:not([type="hidden"]), select, textarea, [role="switch"], [role="radio"], [role="checkbox"]';

async function firstId(request: APIRequestContext, path: string): Promise<string | null> {
  const apiURL = process.env.E2E_DEVAUTH_API_URL ?? 'http://127.0.0.1:3001';
  const res = await request.get(`${apiURL}${path}`, {
    headers: { Authorization: `Bearer ${DEV_TOKEN}` },
  });
  if (!res.ok()) return null;
  const body = (await res.json()) as unknown;
  const list = Array.isArray(body)
    ? body
    : ((body as { data?: unknown[]; items?: unknown[] }).data ??
      (body as { items?: unknown[] }).items ??
      []);
  const first = list[0] as { id?: string } | undefined;
  return first?.id ?? null;
}

async function smallTargets(page: Page): Promise<string[]> {
  return page.evaluate(
    ({ selector, min }) => {
      const out: string[] = [];
      for (const el of Array.from(document.querySelectorAll<HTMLElement>(selector))) {
        const r = el.getBoundingClientRect();
        // Visually-hidden (sr-only) controls and collapsed/closed content
        // aren't tap targets — their visible label/wrapper is.
        if (r.width <= 1 || r.height <= 1) continue;
        const cs = getComputedStyle(el);
        if (cs.visibility === 'hidden' || cs.display === 'none') continue;
        if (el.closest('[aria-hidden="true"], [inert]')) continue;
        if (Math.round(r.height) >= min && Math.round(r.width) >= min) continue;
        const tag = el.tagName.toLowerCase();
        const type = el.getAttribute('type');
        const name =
          el.getAttribute('aria-label') ??
          el.getAttribute('placeholder') ??
          el.getAttribute('name') ??
          (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 40);
        out.push(
          `${tag}${type && tag === 'input' ? `[${type}]` : ''} "${name}" ${Math.round(r.width)}x${Math.round(r.height)}`,
        );
      }
      return out;
    },
    { selector: INTERACTIVE, min: MIN },
  );
}

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

test.describe('page-level tap targets — mobile bar (#1398)', () => {
  test.beforeEach(async ({ devAuthActive }) => {
    skipUnlessAuthedStack(devAuthActive, false, 'Needs the chromium-devauth project (seeded owner tenant)');
  });

  for (const width of [320, 375]) {
    test.describe(`${width}px`, () => {
      test.use({ viewport: { width, height: 800 } });

      for (const route of [...STATIC_ROUTES, 'customer-detail', 'job-detail']) {
        test(`${route} — every visible control is ≥44×44, no horizontal overflow`, async ({
          page,
          request,
        }) => {
          let path = route;
          if (route === 'customer-detail') {
            const id = await firstId(request, '/api/customers');
            expect(id, 'seeded customer').not.toBeNull();
            path = `/customers/${id}`;
          } else if (route === 'job-detail') {
            const id = await firstId(request, '/api/jobs');
            expect(id, 'seeded job').not.toBeNull();
            path = `/jobs/${id}`;
          }

          await page.goto(path);
          if (/\/login/.test(page.url())) test.skip(true, 'Not authenticated in this run');
          await dismissWhatsNewModal(page);
          // Let data-driven sections load and settle before measuring (the
          // app polls, so there is no network-idle moment to wait for).
          await page.waitForTimeout(2_000);
          // The What's-new modal can open late on a cold load; it is not part
          // of the page under test.
          await dismissWhatsNewModal(page);

          const small = (await smallTargets(page)).filter((s) => !ALLOWLIST.some((re) => re.test(s)));
          expect(small, `${path} at ${width}px:\n${small.join('\n')}`).toEqual([]);
          expect(await horizontalOverflow(page), `${path} horizontal overflow`).toBeLessThanOrEqual(0);
        });
      }

      // #1412 — controls the route sweep above cannot see at rest: the
      // assistant's scroll-to-latest button only appears once the thread is
      // scrolled up, and the add-customer sheet's SMS-consent row (its native
      // checkbox is visually hidden, so the ROW is the tap target) sits on the
      // sheet's second step. (The reply reaction/copy actions are always
      // rendered now, so the /assistant sweep measures them on the welcome
      // reply.)
      test('/assistant — scroll-to-latest is ≥44×44', async ({ page }) => {
        await page.goto('/assistant');
        if (/\/login/.test(page.url())) test.skip(true, 'Not authenticated in this run');
        await dismissWhatsNewModal(page);
        // The thread is the scroll container around the welcome reply.
        await page.getByText(/I'm your AI assistant/).first().waitFor();
        await page.evaluate(() => {
          const welcome = Array.from(document.querySelectorAll<HTMLElement>('p, div, span')).find((el) =>
            /I'm your AI assistant/.test(el.textContent ?? '') && el.children.length === 0,
          );
          let thread = welcome?.parentElement ?? null;
          while (thread && getComputedStyle(thread).overflowY !== 'auto') thread = thread.parentElement;
          if (!thread) return;
          const spacer = document.createElement('div');
          spacer.style.height = '3000px';
          thread.prepend(spacer);
          thread.scrollTop = 0;
          thread.dispatchEvent(new Event('scroll'));
        });
        const button = page.getByRole('button', { name: 'Scroll to latest' });
        await expect(button).toBeVisible();
        const box = await button.boundingBox();
        expect(Math.round(box!.width)).toBeGreaterThanOrEqual(MIN);
        expect(Math.round(box!.height)).toBeGreaterThanOrEqual(MIN);
      });

      test('/customers add-customer sheet — the SMS-consent row is ≥44 tall and full width', async ({ page }) => {
        await page.goto('/customers');
        if (/\/login/.test(page.url())) test.skip(true, 'Not authenticated in this run');
        await dismissWhatsNewModal(page);
        await page.getByRole('button', { name: 'Add customer' }).first().click();
        await page.getByPlaceholder('Full name *').fill('Tap Target');
        await page.getByText('Next: Add location →').click();
        const row = page.locator('label[for="smsConsentCreate"]');
        await expect(row).toBeVisible();
        const box = await row.boundingBox();
        expect(Math.round(box!.height)).toBeGreaterThanOrEqual(MIN);
        expect(Math.round(box!.width)).toBeGreaterThanOrEqual(MIN);
        await row.click();
        await expect(page.getByRole('checkbox', { name: /SMS consent/i })).toBeChecked();
      });
    });
  }
});

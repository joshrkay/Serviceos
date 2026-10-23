import type { Page, Route } from '@playwright/test';
import { test, expect, skipUnlessAuthedStack } from './helpers/dev-auth';
import { hasRealClerkPublishableKey } from './helpers/clerk-key';

/**
 * B1 follow-up (B-R5) — the Settings "Supervisor backup" section on a phone.
 *
 * The section now keeps the backup on file as the selected option even when
 * it is no longer someone who can approve (a technician named before B1, a
 * deactivated member), and says so in a note under the select. jsdom pins
 * the class contract (SupervisorBackupSection.test.tsx: break-words on the
 * note, min-h on the select); this measures what jsdom can't, at the
 * smallest supported phone:
 *   - no horizontal overflow at 320px, with a backup name and emails that do
 *     not break on their own;
 *   - the backup select, every routing row and Save clear 44px;
 *   - the stale-backup note wraps inside the section instead of running off.
 *
 * Pattern: e2e/estimate-approval-mobile.spec.ts. The roster and the backup on
 * file are stubbed (page.route) so the stale case exists whatever the stack
 * seeded; /api/me is the real response with only the backup id swapped in.
 * Runs under the chromium-devauth project (signed in as the owner, who is
 * the only role the section mounts for); skips on a bare runner otherwise.
 */

const LEGACY_TECH_ID = 'u-legacy-tech-b1';
// One unbroken word: without break-words the note would run past 320px.
const LONG_FIRST_NAME = 'Maximilianbartholomewfeatherstonehaughworthington';

const roster = [
  {
    id: LEGACY_TECH_ID,
    email: 'maximilian.featherstonehaugh-worthington.technician@example-plumbing-and-heating.com',
    role: 'technician',
    firstName: LONG_FIRST_NAME,
    lastName: 'Tech',
    status: 'active',
  },
  {
    id: 'u-dispatcher-b1',
    email: 'dispatch.office.manager.with.a.long.address@example-plumbing-and-heating.com',
    role: 'dispatcher',
    firstName: 'Dana',
    lastName: 'Dispatch',
    status: 'active',
  },
];

async function stubBackupOnFile(page: Page): Promise<void> {
  // The real /api/me, with the legacy technician as the backup on file.
  await page.route('**/api/me', async (route: Route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const response = await route.fetch();
    const body = (await response.json()) as Record<string, unknown>;
    await route.fulfill({ response, json: { ...body, backup_supervisor_user_id: LEGACY_TECH_ID } });
  });
  await page.route('**/api/users', (route: Route) =>
    route.request().method() === 'GET'
      ? route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: roster }) })
      : route.fallback(),
  );
}

async function openSection(page: Page) {
  await stubBackupOnFile(page);
  await page.goto('/settings');
  if (/\/login/.test(page.url())) test.skip(true, 'Not authenticated in this run');
  await expect(page.getByText('Service area', { exact: true }).first()).toBeVisible();
  // The "what's new" modal can mount late and swallow the next interaction.
  await page
    .getByRole('button', { name: 'Got it', exact: true })
    .click({ timeout: 5_000 })
    .catch(() => undefined);
  const section = page.getByTestId('supervisor-backup-section');
  if (!(await section.count())) test.skip(true, 'Signed-in dev user is not an owner in this run');
  await section.scrollIntoViewIfNeeded();
  await expect(page.getByTestId('backup-supervisor-ineligible-note')).toBeVisible();
  return section;
}

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

test.describe('settings — supervisor backup section on a phone', () => {
  test.beforeEach(async ({ devAuthActive }) => {
    skipUnlessAuthedStack(
      devAuthActive,
      hasRealClerkPublishableKey(),
      'Set E2E_BASE_URL or a real Clerk pk to run authenticated UI tests (or run under the chromium-devauth project)',
    );
  });

  test.describe('320px (smallest supported phone)', () => {
    test.use({ viewport: { width: 320, height: 720 } });

    test('no horizontal overflow with a stale backup and long names on file', async ({ page }) => {
      const section = await openSection(page);

      // The legacy backup is the selected option, not a silent "None".
      await expect(page.getByTestId('backup-supervisor-select')).toHaveValue(LEGACY_TECH_ID);
      // 1px slack for sub-pixel layout.
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);
      const own = await section.evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth }));
      expect(own.sw).toBeLessThanOrEqual(own.cw + 1);
    });

    test('glove targets: the backup select, every routing row and Save are at least 44px', async ({ page }) => {
      await openSection(page);

      const targets = [
        page.getByTestId('backup-supervisor-select'),
        page.getByTestId('routing-option-queue_and_sms'),
        page.getByTestId('routing-option-queue_only'),
        page.getByTestId('routing-option-escalate_to_oncall'),
        page.getByTestId('supervisor-backup-save'),
      ];
      for (const target of targets) {
        await expect(target).toBeVisible();
        const box = await target.boundingBox();
        expect(box).not.toBeNull();
        expect(box!.height).toBeGreaterThanOrEqual(44);
        expect(box!.x + box!.width).toBeLessThanOrEqual(320 + 1);
      }
    });

    test('the stale-backup note wraps inside the section', async ({ page }) => {
      const section = await openSection(page);
      const note = page.getByTestId('backup-supervisor-ineligible-note');

      await expect(note).toContainText(LONG_FIRST_NAME);
      await expect(note).toContainText("can't approve work, so they can't be your backup.");
      const sectionBox = (await section.boundingBox())!;
      const noteBox = (await note.boundingBox())!;
      // Inside the section and the viewport…
      expect(noteBox.x).toBeGreaterThanOrEqual(sectionBox.x);
      expect(noteBox.x + noteBox.width).toBeLessThanOrEqual(sectionBox.x + sectionBox.width + 1);
      expect(noteBox.x + noteBox.width).toBeLessThanOrEqual(320 + 1);
      // …because it breaks onto more lines, not because it is clipped.
      const lines = await note.evaluate((el) => {
        const lineHeight = parseFloat(getComputedStyle(el).lineHeight);
        return { height: el.getBoundingClientRect().height, lineHeight, sw: el.scrollWidth, cw: el.clientWidth };
      });
      expect(lines.sw).toBeLessThanOrEqual(lines.cw + 1);
      expect(lines.height).toBeGreaterThanOrEqual(lines.lineHeight * 2);
    });
  });
});

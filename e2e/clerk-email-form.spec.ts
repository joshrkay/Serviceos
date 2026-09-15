import { test, expect } from '@playwright/test';
import { submitClerkEmailForm } from './helpers/clerk-email-form';

test('email signup submits its form when Continue with Google appears first', async ({ page }) => {
  await page.setContent(`<button onclick="document.querySelector('output').textContent='oauth'">Continue with Google</button>
    <button onclick="document.querySelector('output').textContent='email'">Continue</button><output></output>`);
  await submitClerkEmailForm(page);
  await expect(page.locator('output')).toHaveText('email');
});

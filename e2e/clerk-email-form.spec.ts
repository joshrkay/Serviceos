import { test, expect } from '@playwright/test';
import { submitClerkEmailForm, enterClerkTestCode } from './helpers/clerk-email-form';

test('email signup submits its form when Continue with Google appears first', async ({ page }) => {
  await page.setContent(`<button onclick="document.querySelector('output').textContent='oauth'">Continue with Google</button>
    <button onclick="document.querySelector('output').textContent='email'">Continue</button><output></output>`);
  await submitClerkEmailForm(page);
  await expect(page.locator('output')).toHaveText('email');
});

test('verification code advances through Clerk segmented inputs', async ({ page }) => {
  await page.setContent(Array.from({ length: 6 }, (_, i) =>
    `<input aria-label="Enter verification code. Digit ${i + 1}" maxlength="1" oninput="this.nextElementSibling?.focus()">`
  ).join(''));
  await enterClerkTestCode(page);
  await expect.poll(() => page.locator('input').evaluateAll(inputs => inputs.map(input => input.value).join(''))).toBe('424242');
});

test('verification code also supports Clerk single input', async ({ page }) => {
  await page.setContent('<input aria-label="Enter verification code">');
  await enterClerkTestCode(page);
  await expect(page.getByRole('textbox')).toHaveValue('424242');
});

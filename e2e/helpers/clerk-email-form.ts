import type { Page } from '@playwright/test';
/** Submit the email/password form, never an OAuth "Continue with …" button. */
export async function submitClerkEmailForm(page: Page): Promise<void> {
  await page.getByRole('button', { name: /^(continue|verify|sign up|create account)$/i }).click();
}

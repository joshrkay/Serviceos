import type { Page } from '@playwright/test';
/** Submit the email/password form, never an OAuth "Continue with …" button. */
export async function submitClerkEmailForm(page: Page): Promise<void> {
  await page.getByRole('button', { name: /^(continue|verify|sign up|create account)$/i }).click();
}

/** Clerk auto-submits OTPs; its original control advances between six inputs. */
export async function enterClerkTestCode(page: Page): Promise<void> {
  const firstDigit = page.getByRole('textbox', { name: 'Enter verification code. Digit 1', exact: true });
  if (await firstDigit.isVisible()) {
    await firstDigit.click();
    await page.keyboard.type('424242', { delay: 100 });
  } else {
    await page.getByRole('textbox', { name: /code|verification/i }).first().fill('424242');
  }
}

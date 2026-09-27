/**
 * #1401 (QA §1) — at 375px the Clerk sign-in widget's inputs and buttons
 * rendered 30px tall (evidence 1293/20-mobile-375-login-tap-targets.json),
 * under the 44px touch-target floor. The devauth stack swaps <SignIn> for a
 * shim, so the real widget cannot be measured in Playwright here; instead we
 * assert the `appearance` LoginPage hands Clerk sizes every interactive
 * element Clerk renders on the sign-in card to >= 44px. Clerk merges style
 * objects into its own CSS-in-JS rules (a bare utility class can lose on
 * specificity), so the floor is expressed as a `minHeight` style.
 */
import React from 'react';
import { render } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { MemoryRouter } from 'react-router';

const signInProps: Array<Record<string, unknown>> = [];
vi.mock('@clerk/clerk-react', () => ({
  useAuth: () => ({ isLoaded: true, isSignedIn: false }),
  SignIn: (props: Record<string, unknown>) => {
    signInProps.push(props);
    return null;
  },
}));

import { LoginPage } from './LoginPage';

describe('LoginPage — Clerk widget touch targets (#1401)', () => {
  it('sizes the sign-in inputs and buttons to at least 44px via appearance', () => {
    render(
      <MemoryRouter>
        <LoginPage />
      </MemoryRouter>,
    );
    const appearance = signInProps.at(-1)?.appearance as {
      elements: Record<string, { minHeight?: string; minWidth?: string } | string>;
    };
    const px = (key: string, prop: 'minHeight' | 'minWidth'): number => {
      const el = appearance.elements[key];
      const v = typeof el === 'object' ? el[prop] : undefined;
      return v ? parseFloat(v) : 0;
    };
    // The elements measured at 30px / 24px in the QA sweep: the social
    // button, identifier + password inputs, the show-password toggle and the
    // primary Continue button.
    for (const key of [
      'socialButtonsBlockButton',
      'formFieldInput',
      'formFieldInputShowPasswordButton',
      'formButtonPrimary',
    ]) {
      expect(px(key, 'minHeight'), key).toBeGreaterThanOrEqual(44);
    }
    // The show-password toggle is an icon button: it needs 44px of width too.
    expect(px('formFieldInputShowPasswordButton', 'minWidth')).toBeGreaterThanOrEqual(44);
  });
});

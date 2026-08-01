// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  replace: vi.fn(),
  create: vi.fn(),
  prepareFirstFactor: vi.fn().mockResolvedValue(undefined),
  attemptFirstFactor: vi.fn(),
  prepareSecondFactor: vi.fn().mockResolvedValue(undefined),
  attemptSecondFactor: vi.fn(),
  supportedFirstFactors: [] as Array<{ strategy: string; emailAddressId?: string }>,
  supportedSecondFactors: [] as Array<{ strategy: string; emailAddressId?: string }>,
  setActive: vi.fn().mockResolvedValue(undefined),
  isLoaded: true,
  params: {} as { reason?: string; next?: string },
}));

vi.mock('@clerk/clerk-expo', () => ({
  useSignIn: () => ({
    isLoaded: h.isLoaded,
    signIn: {
      create: h.create,
      prepareFirstFactor: h.prepareFirstFactor,
      attemptFirstFactor: h.attemptFirstFactor,
      prepareSecondFactor: h.prepareSecondFactor,
      attemptSecondFactor: h.attemptSecondFactor,
      get supportedFirstFactors() {
        return h.supportedFirstFactors;
      },
      get supportedSecondFactors() {
        return h.supportedSecondFactors;
      },
    },
    setActive: h.setActive,
  }),
}));
vi.mock('expo-router', () => ({
  useRouter: () => ({ replace: h.replace, push: vi.fn(), back: vi.fn() }),
  useLocalSearchParams: () => h.params,
}));

// eslint-disable-next-line import/first
import SignIn from '../../app/(auth)/sign-in';

beforeEach(() => {
  vi.clearAllMocks();
  h.isLoaded = true;
  h.supportedFirstFactors = [];
  h.supportedSecondFactors = [];
  h.params = {};
});

afterEach(() => cleanup());

describe('Sign-in screen', () => {
  it('email/password inputs and the submit button all meet the >=44px contract', () => {
    const { container } = render(createElement(SignIn));
    const inputs = Array.from(container.querySelectorAll('input'));
    expect(inputs).toHaveLength(2);
    for (const i of inputs) expect(i.className).toMatch(/\bmin-h-11\b/);
    const submit = container.querySelector('button')!;
    expect(submit.className).toMatch(/\bmin-h-11\b/);
  });

  it('completes sign-in and routes home on a complete attempt', async () => {
    h.create.mockResolvedValue({ status: 'complete', createdSessionId: 'sess_1' });
    const { container, getByPlaceholderText } = render(createElement(SignIn));
    fireEvent.change(getByPlaceholderText('Email'), { target: { value: ' owner@shop.com ' } });
    fireEvent.change(getByPlaceholderText('Password'), { target: { value: 'pw' } });
    fireEvent.click(container.querySelector('button')!);

    await waitFor(() => expect(h.setActive).toHaveBeenCalledWith({ session: 'sess_1' }));
    expect(h.create).toHaveBeenCalledWith({ identifier: 'owner@shop.com', password: 'pw' });
    expect(h.replace).toHaveBeenCalledWith('/');
  });

  it('completes sign-in via email_code when Clerk requires a first factor', async () => {
    h.create.mockResolvedValue({ status: 'needs_first_factor' });
    h.supportedFirstFactors = [{ strategy: 'email_code', emailAddressId: 'idn_test' }];
    h.attemptFirstFactor.mockResolvedValue({ status: 'complete', createdSessionId: 'sess_2' });
    const { container, getByPlaceholderText } = render(createElement(SignIn));
    fireEvent.change(getByPlaceholderText('Email'), { target: { value: 'qa+clerk_test@x.com' } });
    fireEvent.change(getByPlaceholderText('Password'), { target: { value: 'pw' } });
    fireEvent.click(container.querySelector('button')!);

    await waitFor(() => expect(h.prepareFirstFactor).toHaveBeenCalled());
    expect(h.attemptFirstFactor).toHaveBeenCalledWith({
      strategy: 'email_code',
      code: '424242',
    });
    await waitFor(() => expect(h.setActive).toHaveBeenCalledWith({ session: 'sess_2' }));
  });

  it('completes sign-in via email_code when Client Trust requires verification', async () => {
    h.create.mockResolvedValue({ status: 'needs_client_trust' });
    h.supportedSecondFactors = [{ strategy: 'email_code', emailAddressId: 'idn_test' }];
    h.attemptSecondFactor.mockResolvedValue({ status: 'complete', createdSessionId: 'sess_3' });
    const { container, getByPlaceholderText } = render(createElement(SignIn));
    fireEvent.change(getByPlaceholderText('Email'), { target: { value: 'qa+clerk_test@x.com' } });
    fireEvent.change(getByPlaceholderText('Password'), { target: { value: 'pw' } });
    fireEvent.click(container.querySelector('button')!);

    await waitFor(() => expect(h.prepareSecondFactor).toHaveBeenCalled());
    expect(h.attemptSecondFactor).toHaveBeenCalledWith({
      strategy: 'email_code',
      code: '424242',
    });
    await waitFor(() => expect(h.setActive).toHaveBeenCalledWith({ session: 'sess_3' }));
  });

  it('shows the code-entry step for a REAL account needing a first factor (never auto-sends 424242)', async () => {
    h.create.mockResolvedValue({ status: 'needs_first_factor' });
    h.supportedFirstFactors = [{ strategy: 'email_code', emailAddressId: 'idn_real' }];
    const { container, getByPlaceholderText, findByText } = render(createElement(SignIn));
    fireEvent.change(getByPlaceholderText('Email'), { target: { value: 'owner@shop.com' } });
    fireEvent.change(getByPlaceholderText('Password'), { target: { value: 'pw' } });
    fireEvent.click(container.querySelector('button')!);

    await waitFor(() => expect(h.prepareFirstFactor).toHaveBeenCalled());
    // The real emailed code must be typed by the user — no automatic attempt.
    expect(h.attemptFirstFactor).not.toHaveBeenCalled();
    expect(await findByText('Check your email')).toBeTruthy();
    expect(getByPlaceholderText('One-time code')).toBeTruthy();
  });

  it('verifies the typed code and completes sign-in for a real account', async () => {
    h.create.mockResolvedValue({ status: 'needs_first_factor' });
    h.supportedFirstFactors = [{ strategy: 'email_code', emailAddressId: 'idn_real' }];
    h.attemptFirstFactor.mockResolvedValue({ status: 'complete', createdSessionId: 'sess_9' });
    const { container, getByPlaceholderText, findByText, getByText } = render(
      createElement(SignIn),
    );
    fireEvent.change(getByPlaceholderText('Email'), { target: { value: 'owner@shop.com' } });
    fireEvent.change(getByPlaceholderText('Password'), { target: { value: 'pw' } });
    fireEvent.click(container.querySelector('button')!);
    await findByText('Check your email');

    fireEvent.change(getByPlaceholderText('One-time code'), { target: { value: ' 123456 ' } });
    fireEvent.click(getByText('Verify code'));

    await waitFor(() =>
      expect(h.attemptFirstFactor).toHaveBeenCalledWith({
        strategy: 'email_code',
        code: '123456',
      }),
    );
    await waitFor(() => expect(h.setActive).toHaveBeenCalledWith({ session: 'sess_9' }));
    expect(h.replace).toHaveBeenCalledWith('/');
  });

  it('shows the code-entry step for a real account on Client Trust and verifies via second factor', async () => {
    h.create.mockResolvedValue({ status: 'needs_client_trust' });
    h.supportedSecondFactors = [{ strategy: 'email_code', emailAddressId: 'idn_real' }];
    h.attemptSecondFactor.mockResolvedValue({ status: 'complete', createdSessionId: 'sess_10' });
    const { container, getByPlaceholderText, findByText, getByText } = render(
      createElement(SignIn),
    );
    fireEvent.change(getByPlaceholderText('Email'), { target: { value: 'owner@shop.com' } });
    fireEvent.change(getByPlaceholderText('Password'), { target: { value: 'pw' } });
    fireEvent.click(container.querySelector('button')!);

    await waitFor(() => expect(h.prepareSecondFactor).toHaveBeenCalled());
    expect(await findByText('Check your email')).toBeTruthy();

    fireEvent.change(getByPlaceholderText('One-time code'), { target: { value: '654321' } });
    fireEvent.click(getByText('Verify code'));

    await waitFor(() =>
      expect(h.attemptSecondFactor).toHaveBeenCalledWith({
        strategy: 'email_code',
        code: '654321',
      }),
    );
    await waitFor(() => expect(h.setActive).toHaveBeenCalledWith({ session: 'sess_10' }));
  });

  it('surfaces a friendly error on a wrong code and stays on the code step', async () => {
    h.create.mockResolvedValue({ status: 'needs_first_factor' });
    h.supportedFirstFactors = [{ strategy: 'email_code', emailAddressId: 'idn_real' }];
    h.attemptFirstFactor.mockRejectedValue({ errors: [{ message: 'Incorrect code.' }] });
    const { container, getByPlaceholderText, findByText, getByText } = render(
      createElement(SignIn),
    );
    fireEvent.change(getByPlaceholderText('Email'), { target: { value: 'owner@shop.com' } });
    fireEvent.change(getByPlaceholderText('Password'), { target: { value: 'pw' } });
    fireEvent.click(container.querySelector('button')!);
    await findByText('Check your email');

    fireEvent.change(getByPlaceholderText('One-time code'), { target: { value: '000000' } });
    fireEvent.click(getByText('Verify code'));

    expect(await findByText('Incorrect code.')).toBeTruthy();
    expect(h.setActive).not.toHaveBeenCalled();
    // Still on the code step — the input survives the failed attempt.
    expect(getByPlaceholderText('One-time code')).toBeTruthy();
  });

  it('returns to the password step via Back to sign in', async () => {
    h.create.mockResolvedValue({ status: 'needs_first_factor' });
    h.supportedFirstFactors = [{ strategy: 'email_code', emailAddressId: 'idn_real' }];
    const { container, getByPlaceholderText, findByText, getByText, queryByPlaceholderText } =
      render(createElement(SignIn));
    fireEvent.change(getByPlaceholderText('Email'), { target: { value: 'owner@shop.com' } });
    fireEvent.change(getByPlaceholderText('Password'), { target: { value: 'pw' } });
    fireEvent.click(container.querySelector('button')!);
    await findByText('Check your email');

    fireEvent.click(getByText('Back to sign in'));
    expect(queryByPlaceholderText('One-time code')).toBeNull();
    expect(getByPlaceholderText('Email')).toBeTruthy();
  });

  it('code-entry input and buttons meet the >=44px contract', async () => {
    h.create.mockResolvedValue({ status: 'needs_first_factor' });
    h.supportedFirstFactors = [{ strategy: 'email_code', emailAddressId: 'idn_real' }];
    const { container, getByPlaceholderText, findByText } = render(createElement(SignIn));
    fireEvent.change(getByPlaceholderText('Email'), { target: { value: 'owner@shop.com' } });
    fireEvent.change(getByPlaceholderText('Password'), { target: { value: 'pw' } });
    fireEvent.click(container.querySelector('button')!);
    await findByText('Check your email');

    const codeInput = getByPlaceholderText('One-time code');
    expect((codeInput as HTMLElement).className).toMatch(/\bmin-h-11\b/);
    for (const b of Array.from(container.querySelectorAll('button'))) {
      expect(b.className).toMatch(/\bmin-h-11\b/);
    }
  });

  it('surfaces the Clerk error message on a failed attempt', async () => {
    h.create.mockRejectedValue({ errors: [{ message: 'Invalid password.' }] });
    const { container, findByText } = render(createElement(SignIn));
    fireEvent.click(container.querySelector('button')!);
    expect(await findByText('Invalid password.')).toBeTruthy();
    expect(h.replace).not.toHaveBeenCalled();
  });

  it('explains why a session-expired redirect landed here', () => {
    h.params = { reason: 'session-expired', next: '/customers/c1' };
    const { getByText } = render(createElement(SignIn));
    expect(getByText('Your session expired')).toBeTruthy();
  });

  it('resumes to the preserved next route after re-auth instead of Home', async () => {
    h.params = { reason: 'session-expired', next: '/customers/c1' };
    h.create.mockResolvedValue({ status: 'complete', createdSessionId: 'sess_x' });
    const { container, getByPlaceholderText } = render(createElement(SignIn));
    fireEvent.change(getByPlaceholderText('Email'), { target: { value: 'owner@shop.com' } });
    fireEvent.change(getByPlaceholderText('Password'), { target: { value: 'pw' } });
    fireEvent.click(container.querySelector('button')!);
    await waitFor(() => expect(h.replace).toHaveBeenCalledWith('/customers/c1'));
  });

  it('shows no session-expired banner on a cold sign-in', () => {
    const { queryByText } = render(createElement(SignIn));
    expect(queryByText('Your session expired')).toBeNull();
  });
});

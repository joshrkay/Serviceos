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
}));

// eslint-disable-next-line import/first
import SignIn from '../../app/(auth)/sign-in';

beforeEach(() => {
  vi.clearAllMocks();
  h.isLoaded = true;
  h.supportedFirstFactors = [];
  h.supportedSecondFactors = [];
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

  it('surfaces the Clerk error message on a failed attempt', async () => {
    h.create.mockRejectedValue({ errors: [{ message: 'Invalid password.' }] });
    const { container, findByText } = render(createElement(SignIn));
    fireEvent.click(container.querySelector('button')!);
    expect(await findByText('Invalid password.')).toBeTruthy();
    expect(h.replace).not.toHaveBeenCalled();
  });
});

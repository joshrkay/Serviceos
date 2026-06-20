// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  replace: vi.fn(),
  create: vi.fn(),
  setActive: vi.fn().mockResolvedValue(undefined),
  isLoaded: true,
}));

vi.mock('@clerk/clerk-expo', () => ({
  useSignIn: () => ({
    isLoaded: h.isLoaded,
    signIn: { create: h.create },
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

  it('surfaces the Clerk error message on a failed attempt', async () => {
    h.create.mockRejectedValue({ errors: [{ message: 'Invalid password.' }] });
    const { container, findByText } = render(createElement(SignIn));
    fireEvent.click(container.querySelector('button')!);
    expect(await findByText('Invalid password.')).toBeTruthy();
    expect(h.replace).not.toHaveBeenCalled();
  });
});

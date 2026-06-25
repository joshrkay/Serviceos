// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  replace: vi.fn(),
  api: vi.fn(),
  createCustomer: vi.fn(),
  run: vi.fn(),
  phase: 'idle' as 'idle' | 'saving' | 'saved' | 'error',
  error: null as string | null,
}));

vi.mock('expo-router', () => ({
  useRouter: () => ({ replace: h.replace, push: vi.fn(), back: vi.fn() }),
}));
vi.mock('../lib/useApiClient', () => ({ useApiClient: () => h.api }));
vi.mock('../api/customers', () => ({
  createCustomer: (...args: unknown[]) => h.createCustomer(...args),
}));
vi.mock('../hooks/useSavePhase', () => ({
  useSavePhase: () => ({
    phase: h.phase,
    error: h.error,
    run: h.run,
    reset: vi.fn(),
  }),
}));

// eslint-disable-next-line import/first
import NewCustomer from '../../app/customers/new';

beforeEach(() => {
  vi.clearAllMocks();
  h.phase = 'idle';
  h.error = null;
  h.run.mockImplementation(async (fn: () => Promise<void>) => {
    await fn();
  });
  h.createCustomer.mockResolvedValue({ id: 'c-new' });
});

afterEach(() => cleanup());

describe('New customer screen', () => {
  it('renders the form fields and a disabled save button until names are filled', () => {
    const { getByText, getByPlaceholderText } = render(createElement(NewCustomer));
    expect(getByText('First name')).toBeTruthy();
    expect(getByText('Last name')).toBeTruthy();
    expect(getByPlaceholderText('+1 555 123 4567')).toBeTruthy();
    expect(getByText('Create customer').closest('button')!.disabled).toBe(true);
  });

  it('creates a customer and navigates to the detail screen', async () => {
    const { getByText, container } = render(createElement(NewCustomer));
    const inputs = container.querySelectorAll('input');
    fireEvent.change(inputs[0]!, { target: { value: 'Jane' } });
    fireEvent.change(inputs[1]!, { target: { value: 'Doe' } });
    fireEvent.change(inputs[2]!, { target: { value: '555-0100' } });
    fireEvent.change(inputs[3]!, { target: { value: 'jane@example.com' } });

    const save = getByText('Create customer').closest('button')!;
    expect(save.className).toMatch(/\bmin-h-11\b/);
    fireEvent.click(save);

    await waitFor(() =>
      expect(h.createCustomer).toHaveBeenCalledWith(h.api, {
        firstName: 'Jane',
        lastName: 'Doe',
        primaryPhone: '555-0100',
        email: 'jane@example.com',
      }),
    );
    await waitFor(() => expect(h.replace).toHaveBeenCalledWith('/customers/c-new'));
  });
});

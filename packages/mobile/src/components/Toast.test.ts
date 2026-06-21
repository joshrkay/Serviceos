// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { createElement, useEffect } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider, useToast, type ToastOptions } from './Toast';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** A child that raises a toast on mount via the imperative API. */
function Raiser({ options }: { options: ToastOptions }) {
  const { showToast } = useToast();
  useEffect(() => showToast(options), [showToast, options]);
  return null;
}

/** A child that raises an error toast (copyForError path) on mount. */
function ErrorRaiser({ err }: { err: unknown }) {
  const { showErrorToast } = useToast();
  useEffect(() => showErrorToast(err), [showErrorToast, err]);
  return null;
}

function renderWith(child: ReturnType<typeof createElement>) {
  return render(createElement(ToastProvider, null, child));
}

describe('ToastProvider / useToast', () => {
  it('renders nothing until a toast is raised', () => {
    const { container } = render(createElement(ToastProvider, null, createElement('span', null, 'app')));
    expect(container.querySelector('button')).toBeNull();
  });

  it('shows a raised toast with its title and body', () => {
    const { getByText } = renderWith(
      createElement(Raiser, { options: { title: 'Could not send', body: 'Try again.' } }),
    );
    expect(getByText('Could not send')).toBeTruthy();
    expect(getByText('Try again.')).toBeTruthy();
  });

  it('dismiss control is a >=44px tap target and clears the toast', () => {
    const { getByText, container } = renderWith(
      createElement(Raiser, { options: { title: 'Heads up', durationMs: 0 } }),
    );
    const btn = getByText('Heads up').closest('button')!;
    expect(btn.className).toMatch(/\bmin-h-11\b/);
    fireEvent.click(btn);
    expect(container.querySelector('button')).toBeNull();
  });

  it('keeps the toast full-width-inset (no fixed width) so it is safe at 320px', () => {
    const { container } = renderWith(
      createElement(Raiser, { options: { title: 'Hi', durationMs: 0 } }),
    );
    // The positioning wrapper is the outermost div; it must not pin a pixel width.
    const wrapper = container.querySelector('div');
    expect(wrapper).toBeTruthy();
    expect(wrapper!.className).not.toMatch(/w-\[\d+px\]/);
    expect(wrapper!.className).toMatch(/inset-x-0/);
  });

  it('auto-dismisses after the duration elapses', () => {
    vi.useFakeTimers();
    const { queryByText } = renderWith(
      createElement(Raiser, { options: { title: 'Briefly', durationMs: 2000 } }),
    );
    expect(queryByText('Briefly')).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(queryByText('Briefly')).toBeNull();
  });

  it('maps a caught error through copyForError for the error toast', () => {
    const { getByText } = renderWith(
      createElement(ErrorRaiser, { err: { kind: 'offline', message: '' } }),
    );
    // The offline taxonomy title (not a raw error string / code).
    expect(getByText(/offline/i)).toBeTruthy();
  });

  it('useToast throws when used without a provider', () => {
    // Suppress React's error logging for the expected throw.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(createElement(Raiser, { options: { title: 'x' } }))).toThrow(
      /ToastProvider/,
    );
    spy.mockRestore();
  });
});

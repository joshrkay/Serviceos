// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorBoundary } from './ErrorBoundary';

afterEach(() => cleanup());

function Boom(): never {
  throw new Error('render exploded');
}

// A child whose throw is controlled by an external flag, so a test can heal it
// (flip the flag) before clicking the boundary's "Try again".
let shouldThrow = false;
function MaybeThrow() {
  if (shouldThrow) throw new Error('controlled explosion');
  return createElement('span', null, 'recovered');
}

beforeEach(() => {
  shouldThrow = false;
});

describe('ErrorBoundary', () => {
  it('renders children when nothing throws', () => {
    const { getByText } = render(
      createElement(ErrorBoundary, null, createElement('span', null, 'all good')),
    );
    expect(getByText('all good')).toBeTruthy();
  });

  it('renders the friendly fallback when a child throws', () => {
    const onError = vi.fn();
    // Suppress React's expected error logging for the thrown render.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { getByText } = render(
      createElement(ErrorBoundary, { onError, children: createElement(Boom) }),
    );
    expect(getByText('Something went wrong')).toBeTruthy();
    expect(getByText('Try again')).toBeTruthy();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toBeInstanceOf(Error);
    spy.mockRestore();
  });

  it('the Try again control is a >=44px tap target and re-mounts the subtree', () => {
    shouldThrow = true;
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { getByText } = render(
      createElement(ErrorBoundary, null, createElement(MaybeThrow)),
    );
    // Boundary caught the throw and shows the fallback.
    const retry = getByText('Try again').closest('button')!;
    expect(retry.className).toMatch(/\bmin-h-11\b/);
    // Heal the child, then reset via Try again — the subtree renders successfully.
    shouldThrow = false;
    fireEvent.click(retry);
    expect(getByText('recovered')).toBeTruthy();
    spy.mockRestore();
  });
});

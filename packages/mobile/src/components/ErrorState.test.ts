// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ErrorState } from './ErrorState';
import type { AppError } from '../lib/appError';

afterEach(() => cleanup());

describe('ErrorState', () => {
  it('renders a two-line state (title + body) from copyForError', () => {
    const err: AppError = { kind: 'server', message: '' };
    const { getByText } = render(createElement(ErrorState, { error: err }));
    expect(getByText('That one is on us')).toBeTruthy();
    // body present and distinct from the title
    expect(getByText(/on our end/i)).toBeTruthy();
  });

  it('shows a >=44px Retry for a retryable error with onRetry', () => {
    const err: AppError = { kind: 'timeout', message: '' };
    const onRetry = vi.fn();
    const { getByText } = render(createElement(ErrorState, { error: err, onRetry }));
    const btn = getByText('Try again').closest('button')!;
    expect(btn.className).toMatch(/\bmin-h-11\b/);
    fireEvent.click(btn);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('hides Retry for a non-retryable error (e.g. forbidden) even with onRetry', () => {
    const err: AppError = { kind: 'forbidden', message: '' };
    const { queryByText } = render(
      createElement(ErrorState, { error: err, onRetry: vi.fn() }),
    );
    expect(queryByText('Try again')).toBeNull();
  });

  it('hides Retry when showRetry is forced false (lists use pull-to-refresh)', () => {
    const err: AppError = { kind: 'server', message: '' };
    const { queryByText } = render(
      createElement(ErrorState, { error: err, onRetry: vi.fn(), showRetry: false }),
    );
    expect(queryByText('Try again')).toBeNull();
  });

  it('surfaces a raw string error as the body', () => {
    const { getByText } = render(createElement(ErrorState, { error: 'HTTP 500' }));
    expect(getByText('HTTP 500')).toBeTruthy();
  });
});

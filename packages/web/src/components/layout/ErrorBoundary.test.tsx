import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import type { MockInstance } from 'vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ErrorBoundary } from './ErrorBoundary';

/**
 * Component that throws on render — used to drive the boundary's
 * error path. We have to silence the React/console error noise that
 * normally accompanies a thrown render error.
 *
 * Story: P0-032
 */
function Boom({ message = 'kaboom' }: { message?: string }): React.ReactElement {
  throw new Error(message);
}

describe('P0-032 ErrorBoundary', () => {
  let consoleErrorSpy: MockInstance;

  beforeEach(() => {
    // Suppress noisy React 18 error logs during expected failures
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it('renders children when no error is thrown', () => {
    render(
      <ErrorBoundary>
        <p>healthy child</p>
      </ErrorBoundary>
    );
    expect(screen.getByText('healthy child')).toBeInTheDocument();
  });

  it('shows fallback UI when a child throws during render', () => {
    render(
      <ErrorBoundary>
        <Boom message="render exploded" />
      </ErrorBoundary>
    );
    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
    // The error name + message should be surfaced in the fallback
    expect(screen.getByText(/render exploded/i)).toBeInTheDocument();
  });

  it('exposes an accessible role on the fallback', () => {
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>
    );
    // Fallback uses role="alert" so screen readers announce it
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('renders a Reload page button that calls window.location.reload()', () => {
    const originalLocation = window.location;
    const reloadMock = vi.fn();
    // jsdom's location.reload is read-only by default — replace whole object
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...originalLocation, reload: reloadMock },
    });

    try {
      render(
        <ErrorBoundary>
          <Boom />
        </ErrorBoundary>
      );
      const button = screen.getByRole('button', { name: /reload page/i });
      fireEvent.click(button);
      expect(reloadMock).toHaveBeenCalledOnce();
    } finally {
      Object.defineProperty(window, 'location', {
        configurable: true,
        value: originalLocation,
      });
    }
  });

  it('logs caught errors to console.error (does not swallow)', () => {
    render(
      <ErrorBoundary>
        <Boom message="loggable" />
      </ErrorBoundary>
    );
    // We expect at least one call referencing our boundary tag
    const calls = consoleErrorSpy.mock.calls.flat().join(' ');
    expect(calls).toContain('ErrorBoundary');
  });

  it('renders a custom fallback when provided', () => {
    render(
      <ErrorBoundary fallback={<div>custom fallback ui</div>}>
        <Boom />
      </ErrorBoundary>
    );
    expect(screen.getByText('custom fallback ui')).toBeInTheDocument();
    // Default fallback should NOT be present
    expect(screen.queryByText('Something went wrong')).toBeNull();
  });
});

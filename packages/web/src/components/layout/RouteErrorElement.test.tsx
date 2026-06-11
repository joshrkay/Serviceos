/**
 * RouteErrorElement render tests.
 *
 * We mock `useRouteError` directly rather than booting a memory router,
 * because data-router hydration runs asynchronously through internal
 * microtask scheduling and isn't reliable to wait on from a unit test.
 * Mocking the one hook this component reads keeps the test focused on
 * the rendering branches (error shape → user-visible UI).
 *
 * Router integration — that an `errorElement` is actually wired to the
 * routes — is covered separately in `routes.test.ts`.
 */
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const useRouteErrorMock = vi.fn();
const useNavigateMock = vi.fn();

vi.mock('react-router', async () => {
  const actual = await vi.importActual<typeof import('react-router')>('react-router');
  return {
    ...actual,
    useRouteError: () => useRouteErrorMock(),
    useNavigate: () => useNavigateMock,
  };
});

import { RouteErrorElement } from './RouteErrorElement';

function renderElement() {
  return render(
    <MemoryRouter>
      <RouteErrorElement />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  useRouteErrorMock.mockReset();
  useNavigateMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('RouteErrorElement', () => {
  it('shows the generic fallback for an arbitrary thrown Error', () => {
    useRouteErrorMock.mockReturnValue(new Error('boom'));
    renderElement();

    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
    expect(screen.getByText(/encountered an unexpected error/i)).toBeInTheDocument();
    // Detail block shows the error name + message.
    expect(screen.getByText(/boom/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /go back/i })).toBeInTheDocument();
  });

  it('renders the 404 variant for an ErrorResponse(404) from the router', () => {
    // `isRouteErrorResponse` matches react-router's `ErrorResponse` shape
    // — status / statusText / data / internal — not a raw `Response`.
    // The router wraps thrown Responses into this shape before passing
    // them to `useRouteError`, so we synthesize the same shape here.
    useRouteErrorMock.mockReturnValue({
      status: 404,
      statusText: 'Not Found',
      data: 'not here',
      internal: false,
    });
    renderElement();

    expect(screen.getByText('404 Not Found')).toBeInTheDocument();
    expect(
      screen.getByText(/page you're looking for doesn't exist/i),
    ).toBeInTheDocument();
  });

  it('renders the server-error variant for other Response status codes', () => {
    useRouteErrorMock.mockReturnValue({
      status: 500,
      statusText: 'Internal Server Error',
      data: 'boom',
      internal: false,
    });
    renderElement();

    expect(screen.getByText('500 Internal Server Error')).toBeInTheDocument();
    expect(screen.getByText(/server returned an error/i)).toBeInTheDocument();
  });

  it('logs unexpected error shapes to the console and still renders the fallback', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    useRouteErrorMock.mockReturnValue('a plain string thrown');
    renderElement();

    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('uses role="alert" + aria-live="assertive" for screen readers', () => {
    useRouteErrorMock.mockReturnValue(new Error('x'));
    renderElement();
    const alert = screen.getByRole('alert');
    expect(alert).toHaveAttribute('aria-live', 'assertive');
    expect(alert.getAttribute('data-testid')).toBe('route-error-element');
  });

  it('Try again triggers a full page reload', () => {
    const reload = vi.fn();
    const originalLocation = window.location;
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...originalLocation, reload },
    });

    useRouteErrorMock.mockReturnValue(new Error('x'));
    renderElement();
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(reload).toHaveBeenCalledTimes(1);

    Object.defineProperty(window, 'location', {
      configurable: true,
      value: originalLocation,
    });
  });

  it('Go back navigates -1 when history is non-empty', () => {
    useRouteErrorMock.mockReturnValue(new Error('x'));
    // jsdom's history.length defaults to 1 — push something so the
    // navigate(-1) branch is selected.
    window.history.pushState({}, '', '/before');
    renderElement();
    fireEvent.click(screen.getByRole('button', { name: /go back/i }));
    expect(useNavigateMock).toHaveBeenCalledWith(-1);
  });
});

// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ status: null as string | null }));

vi.mock('../push/pushStatusContext', () => ({
  usePushStatus: () => h.status,
}));

// eslint-disable-next-line import/first
import { PushDeniedNotice } from './PushDeniedNotice';

beforeEach(() => {
  h.status = null;
});
afterEach(() => cleanup());

describe('PushDeniedNotice', () => {
  it('renders nothing when push is registered', () => {
    h.status = 'registered';
    const { container } = render(createElement(PushDeniedNotice));
    expect(container.textContent).toBe('');
  });

  it('renders nothing before registration resolves (null)', () => {
    h.status = null;
    const { container } = render(createElement(PushDeniedNotice));
    expect(container.textContent).toBe('');
  });

  it('shows the turn-on-notifications nudge when permission was denied', () => {
    h.status = 'denied';
    const { getByText } = render(createElement(PushDeniedNotice));
    expect(getByText(/Notifications are off/i)).toBeTruthy();
    expect(getByText(/Turn on notifications in Settings/i)).toBeTruthy();
  });
});

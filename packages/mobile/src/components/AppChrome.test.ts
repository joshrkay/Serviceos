// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ pathname: '/' as string }));

vi.mock('expo-router', () => ({
  useRouter: () => ({ navigate: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => h.pathname,
}));
vi.mock('../voice/useVoiceCapture', () => ({
  useVoiceCapture: () => ({
    phase: 'idle',
    transcript: '',
    error: null,
    startRecording: vi.fn(),
    stopAndTranscribe: vi.fn(),
    reset: vi.fn(),
  }),
}));

import { AppChrome, isImmersiveRoute, shouldShowMic } from './AppChrome';

const content = () => createElement('div', null, 'SCREEN');

beforeEach(() => {
  h.pathname = '/';
});
afterEach(cleanup);

describe('route predicates', () => {
  it('treats auth, proposal, and message-thread routes as immersive', () => {
    expect(isImmersiveRoute('/sign-in')).toBe(true);
    expect(isImmersiveRoute('/proposals/abc')).toBe(true);
    expect(isImmersiveRoute('/messages/abc')).toBe(true);
    expect(isImmersiveRoute('/customers')).toBe(false);
    expect(isImmersiveRoute('/')).toBe(false);
  });

  it('hides the mic on immersive routes and on the dedicated voice screen', () => {
    expect(shouldShowMic('/')).toBe(true);
    expect(shouldShowMic('/customers')).toBe(true);
    expect(shouldShowMic('/voice')).toBe(false);
    expect(shouldShowMic('/proposals/abc')).toBe(false);
  });
});

describe('AppChrome', () => {
  it('renders the routed content always', () => {
    h.pathname = '/proposals/abc';
    const { getByText } = render(createElement(AppChrome, { enabled: true, children: content() }));
    expect(getByText('SCREEN')).toBeTruthy();
  });

  it('shows tab bar + mic on a primary screen when signed in', () => {
    h.pathname = '/customers';
    const { getByText } = render(createElement(AppChrome, { enabled: true, children: content() }));
    expect(getByText('Home')).toBeTruthy(); // tab bar
    expect(getByText('Talk')).toBeTruthy(); // mic
  });

  it('shows the tab bar but not the mic on the voice screen', () => {
    h.pathname = '/voice';
    const { getByText, queryByText } = render(
      createElement(AppChrome, { enabled: true, children: content() }),
    );
    expect(getByText('Home')).toBeTruthy();
    expect(queryByText('Talk')).toBeNull();
  });

  it('hides all chrome on immersive routes', () => {
    h.pathname = '/proposals/abc';
    const { queryByText } = render(createElement(AppChrome, { enabled: true, children: content() }));
    expect(queryByText('Home')).toBeNull();
    expect(queryByText('Talk')).toBeNull();
  });

  it('renders no chrome when signed out', () => {
    h.pathname = '/';
    const { getByText, queryByText } = render(
      createElement(AppChrome, { enabled: false, children: content() }),
    );
    expect(getByText('SCREEN')).toBeTruthy();
    expect(queryByText('Home')).toBeNull();
    expect(queryByText('Talk')).toBeNull();
  });
});

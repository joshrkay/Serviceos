// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OfflineBanner } from './OfflineBanner';
import { __emitNetInfoForTests, __resetConnectivityForTests } from '../lib/connectivity';

function setOffline(off: boolean): void {
  act(() => {
    __emitNetInfoForTests(
      off
        ? { isConnected: false, isInternetReachable: false }
        : { isConnected: true, isInternetReachable: true },
    );
  });
}

beforeEach(() => __resetConnectivityForTests());
afterEach(() => {
  cleanup();
  __resetConnectivityForTests();
});

describe('OfflineBanner', () => {
  it('renders nothing while online', () => {
    const { container } = render(createElement(OfflineBanner));
    expect(container.textContent).toBe('');
  });

  it('shows the banner when connectivity drops, hides it on reconnect', () => {
    const { container, queryByText } = render(createElement(OfflineBanner));
    setOffline(true);
    expect(queryByText(/offline/i)).toBeTruthy();
    setOffline(false);
    expect(container.textContent).toBe('');
  });

  it('spans full width (w-full) so it cannot overflow at 320px', () => {
    const { container } = render(createElement(OfflineBanner));
    setOffline(true);
    const banner = container.querySelector('div');
    expect(banner).toBeTruthy();
    // No fixed pixel width; full-width by class — safe at the 320px floor.
    expect(banner!.className).toMatch(/\bw-full\b/);
    expect(banner!.className).not.toMatch(/w-\[\d+px\]/);
  });
});

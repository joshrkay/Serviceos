// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  navigate: vi.fn(),
  pathname: '/' as string,
}));

vi.mock('expo-router', () => ({
  useRouter: () => ({ navigate: h.navigate, push: vi.fn(), replace: vi.fn() }),
  usePathname: () => h.pathname,
}));

import { TabBar, isTabActive } from './TabBar';

const TAB_LABELS = ['Home', 'Assistant', 'Customers', 'Jobs', 'Settings'];

beforeEach(() => {
  h.navigate.mockReset();
  h.pathname = '/';
});
afterEach(cleanup);

describe('isTabActive', () => {
  it('matches Home only on the exact root', () => {
    expect(isTabActive('/', '/')).toBe(true);
    expect(isTabActive('/customers', '/')).toBe(false);
  });

  it('matches a tab on its own route and nested detail routes', () => {
    expect(isTabActive('/customers', '/customers')).toBe(true);
    expect(isTabActive('/customers/abc', '/customers')).toBe(true);
    expect(isTabActive('/jobs', '/customers')).toBe(false);
  });
});

describe('TabBar', () => {
  it('renders all five primary tabs', () => {
    const { getByText } = render(createElement(TabBar));
    for (const label of TAB_LABELS) expect(getByText(label)).toBeTruthy();
  });

  it('every tab meets the >=44px tap target (min-h-11) with no fixed width', () => {
    const { getByText } = render(createElement(TabBar));
    for (const label of TAB_LABELS) {
      const btn = getByText(label).closest('button')!;
      expect(btn.className).toMatch(/\bmin-h-11\b/);
      expect(btn.className).not.toMatch(/w-\[\d+px\]/);
    }
  });

  it('marks the active tab with the primary color and others muted', () => {
    h.pathname = '/customers/abc';
    const { getByText } = render(createElement(TabBar));
    expect(getByText('Customers').className).toMatch(/\btext-primary\b/);
    expect(getByText('Home').className).toMatch(/\btext-mutedForeground\b/);
  });

  it('navigates (not push) to a tab route on press', () => {
    const { getByText } = render(createElement(TabBar));
    fireEvent.click(getByText('Jobs').closest('button')!);
    expect(h.navigate).toHaveBeenCalledWith('/jobs');
  });
});

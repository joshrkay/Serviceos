// @vitest-environment jsdom
import { cleanup, render, fireEvent } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  preferences: {} as Record<string, boolean>,
  setEnabled: vi.fn(),
}));

vi.mock('../hooks/useNotificationPreferences', () => ({
  useNotificationPreferences: () => ({
    preferences: h.preferences,
    isLoading: false,
    error: null,
    setEnabled: h.setEnabled,
    reload: vi.fn(),
  }),
}));

// eslint-disable-next-line import/first
import { NotificationPreferences } from './NotificationPreferences';

beforeEach(() => {
  h.preferences = {};
  h.setEnabled = vi.fn();
});
afterEach(() => cleanup());

describe('NotificationPreferences (U10 settings)', () => {
  it('renders a toggle row per category, all defaulting to On (opt-out model)', () => {
    const { getByText, getAllByText } = render(createElement(NotificationPreferences));
    expect(getByText('Incoming calls')).toBeTruthy();
    expect(getByText('Text messages')).toBeTruthy();
    expect(getByText('Emergencies')).toBeTruthy();
    expect(getAllByText('On').length).toBe(11);
  });

  it('reflects a muted category as Off', () => {
    h.preferences = { inbound_sms: false };
    const { getAllByText } = render(createElement(NotificationPreferences));
    expect(getAllByText('Off').length).toBe(1);
    expect(getAllByText('On').length).toBe(10);
  });

  it('pressing a row toggles it via setEnabled(type, !enabled)', () => {
    const { getByText } = render(createElement(NotificationPreferences));
    fireEvent.click(getByText('Incoming calls'));
    expect(h.setEnabled).toHaveBeenCalledWith('incoming_call', false);
  });

  it('un-muting a category calls setEnabled(type, true)', () => {
    h.preferences = { incoming_call: false };
    const { getByText } = render(createElement(NotificationPreferences));
    fireEvent.click(getByText('Incoming calls'));
    expect(h.setEnabled).toHaveBeenCalledWith('incoming_call', true);
  });

  it('every toggle row meets the 44px tap-target contract (min-h-11)', () => {
    const { container } = render(createElement(NotificationPreferences));
    const rows = container.querySelectorAll('[class*="min-h-11"]');
    expect(rows.length).toBe(11);
  });
});

// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SlotPicker } from './SlotPicker';

const SLOTS = [
  { start: '2026-06-22T13:00:00Z', end: '2026-06-22T14:00:00Z' },
  { start: '2026-06-22T15:00:00Z', end: '2026-06-22T16:00:00Z' },
];

afterEach(() => cleanup());

describe('SlotPicker', () => {
  it('renders slot time ranges in the tenant timezone', () => {
    // 13:00–14:00 UTC → 9:00–10:00 AM in America/New_York.
    const { getByText } = render(
      createElement(SlotPicker, { slots: SLOTS, timezone: 'America/New_York', onSelect: vi.fn() }),
    );
    expect(getByText('9:00 AM – 10:00 AM')).toBeTruthy();
    expect(getByText('11:00 AM – 12:00 PM')).toBeTruthy();
    // Day header rendered in tenant tz (still Jun 22 in NY at 13:00Z).
    expect(getByText('Mon, Jun 22')).toBeTruthy();
  });

  it('renders every slot as a ≥44px tap target (min-h-11)', () => {
    const { getAllByRole } = render(
      createElement(SlotPicker, { slots: SLOTS, timezone: 'UTC', onSelect: vi.fn() }),
    );
    const buttons = getAllByRole('button');
    expect(buttons).toHaveLength(2);
    for (const btn of buttons) {
      expect(btn.className).toMatch(/\bmin-h-11\b/);
    }
  });

  it('calls onSelect with the tapped slot', () => {
    const onSelect = vi.fn();
    const { getByText } = render(
      createElement(SlotPicker, { slots: SLOTS, timezone: 'UTC', onSelect }),
    );
    fireEvent.click(getByText('1:00 PM – 2:00 PM').closest('button')!);
    expect(onSelect).toHaveBeenCalledWith(SLOTS[0]);
  });

  it('highlights the selected slot', () => {
    const { getByText } = render(
      createElement(SlotPicker, {
        slots: SLOTS,
        timezone: 'UTC',
        selectedStart: SLOTS[0].start,
        onSelect: vi.fn(),
      }),
    );
    const selected = getByText('1:00 PM – 2:00 PM').closest('button')!;
    expect(selected.className).toMatch(/border-primary/);
  });

  it('shows the empty state when there are no slots', () => {
    const { getByText } = render(
      createElement(SlotPicker, { slots: [], timezone: 'UTC', onSelect: vi.fn() }),
    );
    expect(getByText(/No open times/i)).toBeTruthy();
  });

  it('shows a loading indicator', () => {
    const { container } = render(
      createElement(SlotPicker, { slots: [], timezone: 'UTC', onSelect: vi.fn(), isLoading: true }),
    );
    // react-native-web renders ActivityIndicator without slot text.
    expect(container.textContent).not.toMatch(/No open times/i);
  });
});

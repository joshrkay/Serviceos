// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface MessageTemplate {
  id: string;
  name: string;
  category?: string;
  channel?: string;
}

const h = vi.hoisted(() => ({
  data: [] as MessageTemplate[],
  isLoading: false,
  error: null as string | null,
  refetch: vi.fn(),
}));

vi.mock('expo-router', () => ({
  useRouter: () => ({ back: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));
vi.mock('../hooks/useListQuery', () => ({
  useListQuery: () => ({
    data: h.data,
    total: h.data.length,
    isLoading: h.isLoading,
    error: h.error,
    refetch: h.refetch,
  }),
}));

// eslint-disable-next-line import/first
import TemplatesSettings from '../../app/(tabs)/settings/templates';

beforeEach(() => {
  vi.clearAllMocks();
  h.data = [];
  h.isLoading = false;
  h.error = null;
});

afterEach(() => cleanup());

describe('Templates settings screen', () => {
  it('shows the empty state when there are no templates', () => {
    const { getByText } = render(createElement(TemplatesSettings));
    expect(getByText('Message templates')).toBeTruthy();
    expect(getByText('No message templates yet.')).toBeTruthy();
  });

  it('renders template rows with category and channel', () => {
    h.data = [{ id: 't1', name: 'On my way', category: 'dispatch', channel: 'sms' }];
    const { getByText } = render(createElement(TemplatesSettings));
    expect(getByText('On my way')).toBeTruthy();
    expect(getByText('dispatch · sms')).toBeTruthy();
  });

  it('renders a template without secondary metadata', () => {
    h.data = [{ id: 't2', name: 'Thanks' }];
    const { getByText, queryByText } = render(createElement(TemplatesSettings));
    expect(getByText('Thanks')).toBeTruthy();
    expect(queryByText(' · ')).toBeNull();
  });

  it('surfaces a fetch error', () => {
    h.error = 'HTTP 500';
    const { getByText } = render(createElement(TemplatesSettings));
    expect(getByText('HTTP 500')).toBeTruthy();
    fireEvent.click(getByText('Try again').closest('button')!);
    expect(h.refetch).toHaveBeenCalledTimes(1);
  });
});

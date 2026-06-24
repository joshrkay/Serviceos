// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InboxThread } from '../messaging/useConversations';

const h = vi.hoisted(() => ({
  push: vi.fn(),
  back: vi.fn(),
  refetch: vi.fn(),
  threads: [] as InboxThread[],
  isLoading: false,
  error: null as string | null,
}));

vi.mock('expo-router', () => ({
  useRouter: () => ({ push: h.push, back: h.back, replace: vi.fn() }),
}));
vi.mock('../messaging/useConversations', () => ({
  useConversations: () => ({
    threads: h.threads,
    needsReplyCount: h.threads.filter((t) => t.needsReply).length,
    isLoading: h.isLoading,
    error: h.error,
    refetch: h.refetch,
  }),
}));

// eslint-disable-next-line import/first
import Messages from '../../app/messages';

const thread = (over: Partial<InboxThread> = {}): InboxThread => ({
  conversation: { id: 'c1', entityType: 'customer', entityId: 'cust-1', status: 'open' },
  lastMessageAt: '2026-06-20T10:00:00Z',
  lastMessagePreview: 'My AC is out',
  lastMessageDirection: 'inbound',
  needsReply: true,
  messageCount: 1,
  customerName: 'Acme Plumbing',
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  h.threads = [];
  h.isLoading = false;
  h.error = null;
});

afterEach(() => cleanup());

describe('Messages inbox', () => {
  it('Back is a >=44px tap target and returns', () => {
    const { getByText } = render(createElement(Messages));
    const back = getByText('‹ Back').closest('button')!;
    expect(back.className).toMatch(/\bmin-h-11\b/);
    fireEvent.click(back);
    expect(h.back).toHaveBeenCalledTimes(1);
  });

  it('shows the empty state when there are no threads', () => {
    const { getByText } = render(createElement(Messages));
    expect(getByText('No messages yet.')).toBeTruthy();
  });

  it('renders a thread and opens it on tap, passing the display name', () => {
    h.threads = [thread()];
    const { getByText } = render(createElement(Messages));
    expect(getByText('Acme Plumbing')).toBeTruthy();
    expect(getByText('My AC is out')).toBeTruthy();
    expect(getByText('AP')).toBeTruthy(); // avatar initials
    const row = getByText('Acme Plumbing').closest('button')!;
    expect(row.className).toMatch(/\bmin-h-11\b/);
    fireEvent.click(row);
    expect(h.push).toHaveBeenCalledWith({
      pathname: '/messages/[id]',
      params: { id: 'c1', title: 'Acme Plumbing' },
    });
  });

  it('shows a compact relative time for the last message', () => {
    // Offset from real now so the bucket is deterministic regardless of run date.
    h.threads = [thread({ lastMessageAt: new Date(Date.now() - 9 * 60_000).toISOString() })];
    const { getByText } = render(createElement(Messages));
    expect(getByText('9m')).toBeTruthy();
  });

  it('prefixes the preview with "You:" for an outbound last message', () => {
    h.threads = [thread({ lastMessageDirection: 'outbound', needsReply: false, lastMessagePreview: 'On my way' })];
    const { getByText } = render(createElement(Messages));
    expect(getByText(/You: On my way/)).toBeTruthy();
  });
});

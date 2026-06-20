// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ThreadMessage } from '../messaging/useConversationThread';

const h = vi.hoisted(() => ({
  back: vi.fn(),
  refetch: vi.fn(),
  api: vi.fn(),
  sendReply: vi.fn(),
  messages: [] as ThreadMessage[],
  isLoading: false,
  error: null as string | null,
}));

vi.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ id: 'c1', title: 'Acme Plumbing' }),
  useRouter: () => ({ back: h.back, push: vi.fn(), replace: vi.fn() }),
}));
vi.mock('../lib/useApiClient', () => ({ useApiClient: () => h.api }));
vi.mock('../messaging/sendReply', () => ({ sendReply: (...args: unknown[]) => h.sendReply(...args) }));
vi.mock('../messaging/useConversationThread', () => ({
  useConversationThread: () => ({
    messages: h.messages,
    isLoading: h.isLoading,
    error: h.error,
    refetch: h.refetch,
  }),
}));

// eslint-disable-next-line import/first
import MessageThread from '../../app/messages/[id]';

const msg = (over: Partial<ThreadMessage> = {}): ThreadMessage => ({
  id: 'm1',
  conversationId: 'c1',
  messageType: 'text',
  content: 'Hello',
  senderId: 's',
  senderRole: 'customer',
  createdAt: '2026-06-20T10:00:00Z',
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  h.messages = [];
  h.isLoading = false;
  h.error = null;
  h.sendReply = vi.fn();
});

afterEach(() => cleanup());

describe('Message thread', () => {
  it('renders the title and the message history', () => {
    h.messages = [
      msg({ id: 'in', content: 'My AC is out', senderRole: 'customer' }),
      msg({ id: 'out', content: 'On my way', senderRole: 'owner', metadata: { direction: 'outbound' } }),
      msg({ id: 'sys', content: 'Outbound call to •••4567', messageType: 'system_event', source: 'outbound_call' }),
    ];
    const { getByText } = render(createElement(MessageThread));
    expect(getByText('Acme Plumbing')).toBeTruthy();
    expect(getByText('My AC is out')).toBeTruthy();
    expect(getByText('On my way')).toBeTruthy();
    expect(getByText('Outbound call to •••4567')).toBeTruthy();
  });

  it('sends a reply and optimistically appends it', async () => {
    h.sendReply.mockResolvedValue(
      msg({ id: 'new', content: 'Heading over now', senderRole: 'owner', metadata: { direction: 'outbound' } }),
    );
    const { getByPlaceholderText, getByText, queryByText } = render(createElement(MessageThread));
    expect(queryByText('Heading over now')).toBeNull();

    fireEvent.change(getByPlaceholderText('Type a message'), { target: { value: 'Heading over now' } });
    fireEvent.click(getByText('Send').closest('button')!);

    await waitFor(() => expect(h.sendReply).toHaveBeenCalledWith(h.api, 'c1', 'Heading over now'));
    await waitFor(() => expect(getByText('Heading over now')).toBeTruthy());
  });

  it('surfaces a send failure (e.g. DNC) without losing the screen', async () => {
    h.sendReply.mockRejectedValue(new Error('This customer has opted out of texts (replied STOP).'));
    const { getByPlaceholderText, getByText, findByText } = render(createElement(MessageThread));
    fireEvent.change(getByPlaceholderText('Type a message'), { target: { value: 'hi' } });
    fireEvent.click(getByText('Send').closest('button')!);
    expect(await findByText(/opted out of texts/)).toBeTruthy();
  });

  it('the Send control is a >=44px tap target', () => {
    const { getByText } = render(createElement(MessageThread));
    expect(getByText('Send').closest('button')!.className).toMatch(/\bmin-h-11\b/);
  });
});

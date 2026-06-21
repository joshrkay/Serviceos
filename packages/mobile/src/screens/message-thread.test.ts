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
  showErrorToast: vi.fn(),
  messages: [] as ThreadMessage[],
  isLoading: false,
  error: null as string | null,
}));

vi.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ id: 'c1', title: 'Acme Plumbing' }),
  useRouter: () => ({ back: h.back, push: vi.fn(), replace: vi.fn() }),
}));
vi.mock('../lib/useApiClient', () => ({ useApiClient: () => h.api }));
vi.mock('../components/Toast', () => ({
  useToast: () => ({ showToast: vi.fn(), showErrorToast: h.showErrorToast, hideToast: vi.fn() }),
}));
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

  it('surfaces a send failure (e.g. DNC) as a toast without losing the draft', async () => {
    const failure = new Error('This customer has opted out of texts (replied STOP).');
    h.sendReply.mockRejectedValue(failure);
    const { getByPlaceholderText, getByText } = render(createElement(MessageThread));
    const input = getByPlaceholderText('Type a message') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'hi' } });
    fireEvent.click(getByText('Send').closest('button')!);
    await waitFor(() => expect(h.showErrorToast).toHaveBeenCalledWith(failure));
    // Draft is preserved for a retry (cleared only on success).
    expect(input.value).toBe('hi');
  });

  it('the Send control is a >=44px tap target', () => {
    const { getByText } = render(createElement(MessageThread));
    expect(getByText('Send').closest('button')!.className).toMatch(/\bmin-h-11\b/);
  });

  it('keeps the composer above the on-screen keyboard (KeyboardAvoidingView)', () => {
    // The bottom-anchored composer would otherwise be hidden by the keyboard on
    // both iOS and Android. The screen wraps everything in a keyboard-avoiding
    // container with iOS-correct `padding` behavior (the stub runs as iOS).
    const { getByPlaceholderText, container } = render(createElement(MessageThread));
    const kav = container.querySelector('[data-behavior]');
    expect(kav).toBeTruthy();
    expect(kav!.getAttribute('data-behavior')).toBe('padding');
    // The composer input must live inside that container, not outside it.
    expect(kav!.contains(getByPlaceholderText('Type a message'))).toBe(true);
  });
});

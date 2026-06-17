import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const apiFetchMock = vi.fn();
vi.mock('../../utils/api-fetch', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

import { CommsInboxPage } from './CommsInboxPage';
import type { InboxThread } from '../../api/conversations';

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'ERR',
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const THREAD: InboxThread = {
  conversation: {
    id: 'conv-1',
    title: 'Dana Diaz',
    entityType: 'customer',
    entityId: 'cust-1',
    status: 'open',
    createdAt: '2026-06-17T10:00:00Z',
    updatedAt: '2026-06-17T10:05:00Z',
  },
  lastMessageAt: '2026-06-17T10:05:00Z',
  lastMessagePreview: 'one more question',
  lastMessageDirection: 'inbound',
  needsReply: true,
  messageCount: 2,
  customerName: 'Dana Diaz',
};

const MESSAGES = [
  {
    id: 'm1',
    tenantId: 't1',
    conversationId: 'conv-1',
    messageType: 'text',
    content: 'one more question',
    senderId: '+15555550000',
    senderRole: 'customer',
    createdAt: '2026-06-17T10:05:00Z',
  },
];

function routeApi(url: string, init?: RequestInit): Response {
  const method = init?.method ?? 'GET';
  if (url.includes('/messages')) return jsonResponse(MESSAGES);
  if (url.includes('/reply')) {
    return jsonResponse({
      message: {
        id: 'm2',
        tenantId: 't1',
        conversationId: 'conv-1',
        messageType: 'text',
        content: 'on our way',
        senderId: 'owner-1',
        senderRole: 'owner',
        createdAt: '2026-06-17T10:06:00Z',
      },
      dispatchId: 'd1',
      channel: 'sms',
      recipient: '+15555550000',
    });
  }
  if (url.includes('/suggest-reply')) return jsonResponse({ draft: 'draft text' });
  if (url.includes('/api/conversations') && method === 'GET') {
    return jsonResponse({ threads: [THREAD] });
  }
  return jsonResponse({});
}

describe('CommsInboxPage', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    apiFetchMock.mockImplementation(async (url: string, init?: RequestInit) =>
      routeApi(url, init),
    );
  });

  it('renders the thread list with customer name, preview, and a needs-reply marker', async () => {
    render(<CommsInboxPage />);
    expect(await screen.findByText('Dana Diaz')).toBeInTheDocument();
    expect(screen.getByText('one more question')).toBeInTheDocument();
    expect(screen.getByLabelText('Needs reply')).toBeInTheDocument();
  });

  it('mobile layout contract — grid tracks use minmax(0,…) and rows are ≥44px tap targets', async () => {
    render(<CommsInboxPage />);
    await screen.findByText('Dana Diaz');

    const grid = screen.getByTestId('comms-inbox-grid');
    expect(grid.className).toContain('minmax(0,20rem)');
    expect(grid.className).toContain('minmax(0,1fr)');

    const row = screen.getByTestId('comms-thread-row');
    expect(row.className).toContain('min-h-11');
    // Long previews must shrink/truncate, not force horizontal overflow.
    expect(row.querySelector('.min-w-0')).not.toBeNull();
    expect(row.querySelector('.truncate')).not.toBeNull();
  });

  it('opens a thread and renders its messages', async () => {
    render(<CommsInboxPage />);
    fireEvent.click(await screen.findByTestId('comms-thread-row'));
    expect(await screen.findByTestId('conversation-thread')).toBeInTheDocument();
    expect(screen.getAllByText('one more question').length).toBeGreaterThan(0);
  });

  it('sends an owner reply and appends it to the thread', async () => {
    render(<CommsInboxPage />);
    fireEvent.click(await screen.findByTestId('comms-thread-row'));
    await screen.findByTestId('conversation-thread');

    fireEvent.change(screen.getByTestId('message-input-field'), {
      target: { value: 'on our way' },
    });
    fireEvent.click(screen.getByTestId('message-send-button'));

    await waitFor(() => {
      expect(
        apiFetchMock.mock.calls.some(
          ([url, init]) =>
            String(url).includes('/reply') && (init as RequestInit)?.method === 'POST',
        ),
      ).toBe(true);
    });
    expect(await screen.findByText('on our way')).toBeInTheDocument();
  });

  it('surfaces a blocked/failed send error without crashing', async () => {
    apiFetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (String(url).includes('/reply')) {
        return jsonResponse(
          { error: 'DNC_BLOCKED', message: 'Recipient has opted out (STOP/DNC); reply not sent' },
          false,
          403,
        );
      }
      return routeApi(url, init);
    });

    render(<CommsInboxPage />);
    fireEvent.click(await screen.findByTestId('comms-thread-row'));
    await screen.findByTestId('conversation-thread');

    fireEvent.change(screen.getByTestId('message-input-field'), {
      target: { value: 'hello' },
    });
    fireEvent.click(screen.getByTestId('message-send-button'));

    expect(await screen.findByTestId('comms-send-error')).toHaveTextContent(/opted out/i);
  });

  it('shows an empty state when there are no conversations', async () => {
    apiFetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes('/api/conversations')) return jsonResponse({ threads: [] });
      return jsonResponse({});
    });
    render(<CommsInboxPage />);
    expect(await screen.findByTestId('comms-inbox-empty')).toBeInTheDocument();
  });
});

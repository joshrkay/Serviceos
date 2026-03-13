import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { ConversationList, filterConversations, sortByRecent } from './ConversationList';
import { Conversation } from '../../types/conversation';

describe('P3-012 — Conversation search and recent threads', () => {
  const conversations: Conversation[] = [
    {
      id: 'conv-1',
      tenantId: 'tenant-1',
      title: 'HVAC Installation for John Smith',
      entityType: 'job',
      entityId: 'job-123',
      status: 'open',
      createdBy: 'user-1',
      createdAt: '2024-01-01T10:00:00Z',
      updatedAt: '2024-01-03T10:00:00Z',
    },
    {
      id: 'conv-2',
      tenantId: 'tenant-1',
      title: 'Plumbing Repair for Jane Doe',
      entityType: 'job',
      entityId: 'job-456',
      status: 'open',
      createdBy: 'user-1',
      createdAt: '2024-01-02T10:00:00Z',
      updatedAt: '2024-01-04T10:00:00Z',
    },
    {
      id: 'conv-3',
      tenantId: 'tenant-1',
      title: 'Electrical Work',
      entityType: 'job',
      entityId: 'job-789',
      status: 'closed',
      createdBy: 'user-1',
      createdAt: '2024-01-01T08:00:00Z',
      updatedAt: '2024-01-02T10:00:00Z',
    },
  ];

  it('happy path — search returns matching conversations', () => {
    const result = filterConversations(conversations, 'HVAC');
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('conv-1');
  });

  it('happy path — search by entity ID', () => {
    const result = filterConversations(conversations, 'job-456');
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('conv-2');
  });

  it('happy path — search with searchFields', () => {
    const searchFields = { 'conv-1': '555-1234 john@example.com' };
    const result = filterConversations(conversations, '555-1234', searchFields);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('conv-1');
  });

  it('happy path — sorted by most recent first', () => {
    const sorted = sortByRecent(conversations);
    expect(sorted[0].id).toBe('conv-2'); // Jan 4
    expect(sorted[1].id).toBe('conv-1'); // Jan 3
    expect(sorted[2].id).toBe('conv-3'); // Jan 2
  });

  it('happy path — renders conversation list and handles click', () => {
    const onSelect = vi.fn();
    render(
      <ConversationList conversations={conversations} onSelectConversation={onSelect} />
    );

    const items = screen.getAllByTestId('conversation-list-item');
    expect(items).toHaveLength(3);

    fireEvent.click(items[0]);
    expect(onSelect).toHaveBeenCalledWith('conv-2'); // Most recent first
  });

  it('validation — empty search query shows recent threads', () => {
    const result = filterConversations(conversations, '');
    expect(result).toHaveLength(3);
  });

  it('validation — no results shows empty state', () => {
    const onSelect = vi.fn();
    render(
      <ConversationList conversations={[]} onSelectConversation={onSelect} />
    );
    expect(screen.getByTestId('conversation-list-empty')).toHaveTextContent(
      'No conversations found'
    );
  });
});

import React, { useState, useMemo, useRef } from 'react';
import { Conversation } from '../../types/conversation';
import { SearchBar } from '../../components/conversations/SearchBar';

export interface ConversationListProps {
  conversations: Conversation[];
  onSelectConversation: (conversationId: string) => void;
  searchFields?: Record<string, string>; // conversationId -> searchable text
}

export function filterConversations(
  conversations: Conversation[],
  query: string,
  searchFields?: Record<string, string>
): Conversation[] {
  if (!query.trim()) return conversations;
  const lowerQuery = query.toLowerCase();

  return conversations.filter((conv) => {
    if (conv.title?.toLowerCase().includes(lowerQuery)) return true;
    if (conv.entityId?.toLowerCase().includes(lowerQuery)) return true;
    if (conv.entityType?.toLowerCase().includes(lowerQuery)) return true;
    if (searchFields?.[conv.id]?.toLowerCase().includes(lowerQuery)) return true;
    return false;
  });
}

export function sortByRecent(conversations: Conversation[]): Conversation[] {
  return [...conversations].sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  );
}

export function ConversationList({
  conversations,
  onSelectConversation,
  searchFields,
}: ConversationListProps) {
  const [searchQuery, setSearchQuery] = useState('');

  // Stabilize searchFields reference to avoid unnecessary re-filtering
  const searchFieldsJson = JSON.stringify(searchFields);
  const stableSearchFields = useRef(searchFields);
  if (JSON.stringify(stableSearchFields.current) !== searchFieldsJson) {
    stableSearchFields.current = searchFields;
  }

  const filtered = useMemo(
    () => sortByRecent(filterConversations(conversations, searchQuery, stableSearchFields.current)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [conversations, searchQuery, searchFieldsJson]
  );

  return (
    <div className="conversation-list" data-testid="conversation-list">
      <SearchBar onSearch={setSearchQuery} />

      <div className="conversation-list-items" data-testid="conversation-list-items">
        {filtered.length === 0 ? (
          <div className="conversation-list-empty" data-testid="conversation-list-empty">
            No conversations found
          </div>
        ) : (
          filtered.map((conv) => (
            <div
              key={conv.id}
              className="conversation-list-item"
              data-testid="conversation-list-item"
              onClick={() => onSelectConversation(conv.id)}
            >
              <div className="conversation-item-title" data-testid="conversation-item-title">
                {conv.title ?? `Conversation ${conv.id.slice(0, 8)}`}
              </div>
              <div className="conversation-item-meta">
                {conv.entityType && (
                  <span className="conversation-item-entity" data-testid="conversation-item-entity">
                    {conv.entityType}: {conv.entityId}
                  </span>
                )}
                <span className="conversation-item-status" data-testid="conversation-item-status">
                  {conv.status}
                </span>
                <span className="conversation-item-time" data-testid="conversation-item-time">
                  {new Date(conv.updatedAt).toLocaleDateString()}
                </span>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

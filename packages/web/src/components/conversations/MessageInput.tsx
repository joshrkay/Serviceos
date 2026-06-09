import React, { useState, useCallback } from 'react';

export interface MessageInputProps {
  onSend: (content: string) => void;
  disabled?: boolean;
  placeholder?: string;
  /**
   * When provided, shows a "Suggest reply" button that asks the AI for a
   * brand-voiced draft and drops it into the composer for the owner to edit
   * before sending. Resolves with the draft text; rejects on failure.
   */
  onSuggestReply?: () => Promise<string>;
}

export const MAX_MESSAGE_LENGTH = 5000;

export function validateMessageContent(content: string): string | null {
  const trimmed = content.trim();
  if (!trimmed) {
    return 'Message cannot be empty';
  }
  if (trimmed.length > MAX_MESSAGE_LENGTH) {
    return `Message exceeds maximum length of ${MAX_MESSAGE_LENGTH} characters`;
  }
  return null;
}

export function MessageInput({ onSend, disabled = false, placeholder = 'Type a message...', onSuggestReply }: MessageInputProps) {
  const [content, setContent] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [suggesting, setSuggesting] = useState(false);

  const handleSend = useCallback(() => {
    const validationError = validateMessageContent(content);
    if (validationError) {
      setError(validationError);
      return;
    }
    setError(null);
    onSend(content.trim());
    setContent('');
  }, [content, onSend]);

  const handleSuggest = useCallback(async () => {
    if (!onSuggestReply) return;
    setSuggesting(true);
    setError(null);
    try {
      const draft = await onSuggestReply();
      setContent(draft);
    } catch {
      setError('Could not draft a reply. Please try again.');
    } finally {
      setSuggesting(false);
    }
  }, [onSuggestReply]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend]
  );

  return (
    <div className="message-input" data-testid="message-input">
      <textarea
        className="message-input-field"
        data-testid="message-input-field"
        value={content}
        onChange={(e) => {
          setContent(e.target.value);
          if (error) setError(null);
        }}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        disabled={disabled}
        rows={1}
      />
      {onSuggestReply && (
        <button
          className="message-suggest-button"
          data-testid="message-suggest-button"
          onClick={handleSuggest}
          disabled={disabled || suggesting}
          type="button"
        >
          {suggesting ? 'Drafting…' : '✨ Suggest reply'}
        </button>
      )}
      <button
        className="message-send-button"
        data-testid="message-send-button"
        onClick={handleSend}
        disabled={disabled}
      >
        Send
      </button>
      {error && (
        <span className="message-input-error" data-testid="message-input-error">
          {error}
        </span>
      )}
    </div>
  );
}

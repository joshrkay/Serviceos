import React, { useState, useCallback } from 'react';

export interface MessageInputProps {
  /**
   * May return a promise; if it rejects, the draft is restored so a failed
   * send (e.g. a 409 asking for a channel) never loses what was typed.
   */
  onSend: (content: string) => void | Promise<unknown>;
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
    const draft = content.trim();
    setContent('');
    const pending = onSend(draft);
    if (pending && typeof (pending as Promise<unknown>).catch === 'function') {
      // #1406 D10 — give the draft back unless the owner already started a new one.
      (pending as Promise<unknown>).catch(() => {
        setContent((current) => (current === '' ? draft : current));
      });
    }
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

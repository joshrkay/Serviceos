import React, { useState, useCallback } from 'react';

export interface MessageInputProps {
  onSend: (content: string) => void;
  disabled?: boolean;
  placeholder?: string;
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

export function MessageInput({ onSend, disabled = false, placeholder = 'Type a message...' }: MessageInputProps) {
  const [content, setContent] = useState('');
  const [error, setError] = useState<string | null>(null);

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

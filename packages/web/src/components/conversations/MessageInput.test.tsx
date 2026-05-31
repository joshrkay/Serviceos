import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MessageInput } from './MessageInput';

describe('MessageInput — suggest reply', () => {
  it('does not render the suggest button when no handler is provided', () => {
    render(<MessageInput onSend={vi.fn()} />);
    expect(screen.queryByTestId('message-suggest-button')).toBeNull();
  });

  it('fills the composer with the AI draft and lets the owner edit before sending', async () => {
    const onSend = vi.fn();
    const onSuggestReply = vi.fn().mockResolvedValue('We can come Thursday at 9am — want me to confirm?');
    render(<MessageInput onSend={onSend} onSuggestReply={onSuggestReply} />);

    fireEvent.click(screen.getByTestId('message-suggest-button'));

    const field = screen.getByTestId('message-input-field') as HTMLTextAreaElement;
    await waitFor(() => {
      expect(field.value).toBe('We can come Thursday at 9am — want me to confirm?');
    });

    // It is a draft, not auto-sent.
    expect(onSend).not.toHaveBeenCalled();

    // Owner edits, then sends the edited text.
    fireEvent.change(field, { target: { value: 'Thursday 9am works — see you then!' } });
    fireEvent.click(screen.getByTestId('message-send-button'));
    expect(onSend).toHaveBeenCalledWith('Thursday 9am works — see you then!');
  });

  it('surfaces an error when drafting fails and leaves the composer empty', async () => {
    const onSuggestReply = vi.fn().mockRejectedValue(new Error('503'));
    render(<MessageInput onSend={vi.fn()} onSuggestReply={onSuggestReply} />);

    fireEvent.click(screen.getByTestId('message-suggest-button'));

    expect(await screen.findByTestId('message-input-error')).toHaveTextContent(/could not draft/i);
    expect((screen.getByTestId('message-input-field') as HTMLTextAreaElement).value).toBe('');
  });
});

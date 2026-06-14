'use client';

import { useState, useRef } from 'react';
import { Send } from 'lucide-react';

interface MessageInputProps {
  onSend: (text: string) => void;
  disabled?: boolean;
  /** Slot for mic button to the left of the text input */
  micButton?: React.ReactNode;
  /** Ghost text from interim voice transcription */
  interimTranscript?: string;
}

export default function MessageInput({ onSend, disabled, micButton, interimTranscript }: MessageInputProps) {
  const [text, setText] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  function handleSend() {
    const trimmed = text.trim();
    if (!trimmed) return;
    onSend(trimmed);
    setText('');
    inputRef.current?.focus();
  }

  return (
    <div className="shrink-0 border-t border-slate-200 bg-white px-3 py-2">
      <div className="flex items-center gap-2">
        {micButton}
        <div className="relative flex-1">
          <input
            ref={inputRef}
            type="text"
            value={text}
            onChange={e => setText(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
            placeholder={interimTranscript || 'Type a message...'}
            disabled={disabled}
            className="w-full rounded-full border border-slate-200 bg-slate-50 px-4 py-2 text-sm outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-400 disabled:opacity-50 placeholder:text-slate-400"
          />
          {interimTranscript && !text && (
            <span className="absolute left-4 top-1/2 -translate-y-1/2 text-sm text-slate-300 pointer-events-none">
              {interimTranscript}
            </span>
          )}
        </div>
        <button
          onClick={handleSend}
          disabled={disabled || !text.trim()}
          className="size-9 flex items-center justify-center rounded-full bg-blue-600 text-white disabled:opacity-30 hover:bg-blue-700 transition-colors shrink-0"
        >
          <Send size={16} />
        </button>
      </div>
    </div>
  );
}

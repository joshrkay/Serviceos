'use client';

import { useEffect } from 'react';
import { Mic, Square, Loader2 } from 'lucide-react';
import { useDeepgramSTT } from '@/hooks/useDeepgramSTT';

interface MicButtonProps {
  onTranscript: (text: string) => void;
  onInterim?: (text: string) => void;
  disabled?: boolean;
}

export default function MicButton({ onTranscript, onInterim, disabled }: MicButtonProps) {
  const { transcript, interimTranscript, isRecording, startRecording, stopRecording, error } = useDeepgramSTT();

  // Forward interim transcript to parent
  useEffect(() => {
    onInterim?.(interimTranscript);
  }, [interimTranscript, onInterim]);

  // When recording stops and we have a final transcript, send it
  useEffect(() => {
    if (!isRecording && transcript) {
      onTranscript(transcript);
    }
  }, [isRecording, transcript, onTranscript]);

  // Show error as toast (console for now)
  useEffect(() => {
    if (error) console.error('STT error:', error);
  }, [error]);

  function handleClick() {
    if (isRecording) {
      stopRecording();
    } else {
      startRecording();
    }
  }

  if (disabled) {
    return (
      <button disabled className="size-9 flex items-center justify-center rounded-full text-slate-300">
        <Mic size={18} />
      </button>
    );
  }

  if (isRecording) {
    return (
      <button
        onClick={handleClick}
        className="size-9 flex items-center justify-center rounded-full bg-red-500 text-white animate-pulse shadow-sm"
        aria-label="Stop recording"
      >
        <Square size={14} fill="currentColor" />
      </button>
    );
  }

  return (
    <button
      onClick={handleClick}
      className="size-9 flex items-center justify-center rounded-full text-slate-500 hover:text-blue-600 hover:bg-blue-50 transition-colors"
      aria-label="Start recording"
    >
      {error ? <Loader2 size={18} className="animate-spin" /> : <Mic size={18} />}
    </button>
  );
}

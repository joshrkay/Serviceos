import { useState, useCallback, useRef, useEffect } from 'react';

interface UseTTSOptions {
  rate?: number;
  pitch?: number;
  voiceName?: string;
}

interface UseTTS {
  speak: (text: string) => Promise<void>;
  stop: () => void;
  isSpeaking: boolean;
  isSupported: boolean;
}

/**
 * Hook for browser-native text-to-speech via SpeechSynthesis API.
 * Gracefully no-ops when the API isn't available (SSR, test envs).
 */
export function useTTS(options: UseTTSOptions = {}): UseTTS {
  const { rate = 1.05, pitch = 1.0, voiceName } = options;
  const [isSpeaking, setIsSpeaking] = useState(false);
  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null);
  const isSupported = typeof window !== 'undefined' && 'speechSynthesis' in window;

  // Clean up on unmount
  useEffect(() => {
    return () => {
      if (isSupported) {
        window.speechSynthesis.cancel();
      }
    };
  }, [isSupported]);

  const speak = useCallback(
    (text: string): Promise<void> => {
      if (!isSupported) return Promise.resolve();

      return new Promise<void>((resolve) => {
        // Cancel any ongoing speech
        window.speechSynthesis.cancel();

        const utterance = new SpeechSynthesisUtterance(text);
        utterance.rate = rate;
        utterance.pitch = pitch;

        // Try to find requested voice
        if (voiceName) {
          const voices = window.speechSynthesis.getVoices();
          const match = voices.find(
            (v) => v.name.toLowerCase().includes(voiceName.toLowerCase())
          );
          if (match) utterance.voice = match;
        }

        utterance.onstart = () => setIsSpeaking(true);
        utterance.onend = () => {
          setIsSpeaking(false);
          resolve();
        };
        utterance.onerror = () => {
          setIsSpeaking(false);
          resolve();
        };

        utteranceRef.current = utterance;
        window.speechSynthesis.speak(utterance);
      });
    },
    [isSupported, rate, pitch, voiceName]
  );

  const stop = useCallback(() => {
    if (!isSupported) return;
    window.speechSynthesis.cancel();
    setIsSpeaking(false);
  }, [isSupported]);

  return { speak, stop, isSpeaking, isSupported };
}

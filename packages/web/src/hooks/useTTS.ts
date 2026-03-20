import { useState, useCallback, useRef, useEffect } from 'react';

interface UseTTSOptions {
  rate?: number;
  pitch?: number;
  voiceName?: string;
  /** BCP-47 language tag (e.g. 'en-US', 'es-MX'). Selects a matching TTS voice. */
  lang?: string;
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
  const { rate = 1.05, pitch = 1.0, voiceName, lang } = options;
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

        // Set language tag if provided
        if (lang) {
          utterance.lang = lang;
        }

        // Try to find requested voice by name, or fall back to language match
        const voices = window.speechSynthesis.getVoices();
        if (voiceName) {
          const match = voices.find(
            (v) => v.name.toLowerCase().includes(voiceName.toLowerCase())
          );
          if (match) utterance.voice = match;
        } else if (lang) {
          // Select a voice matching the language tag (e.g. 'es-MX' or 'es')
          const exactMatch = voices.find((v) => v.lang === lang);
          const prefixMatch = !exactMatch && voices.find(
            (v) => v.lang.startsWith(lang.split('-')[0])
          );
          if (exactMatch) utterance.voice = exactMatch;
          else if (prefixMatch) utterance.voice = prefixMatch;
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
    [isSupported, rate, pitch, voiceName, lang]
  );

  const stop = useCallback(() => {
    if (!isSupported) return;
    window.speechSynthesis.cancel();
    setIsSpeaking(false);
  }, [isSupported]);

  return { speak, stop, isSpeaking, isSupported };
}

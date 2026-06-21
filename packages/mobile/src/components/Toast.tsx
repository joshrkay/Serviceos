/**
 * Transient toast/snackbar for action errors.
 *
 * Read failures own the screen (a list's error row, a detail's error state), but
 * *action* failures — sending a reply, switching mode, starting a call — happen
 * over a screen the owner wants to stay on. A toast surfaces those without
 * navigating away or wiping the screen: it slides in, sits for a few seconds,
 * and is dismissible with a >=44px tap (the CLAUDE.md glove-target rule).
 *
 * `ToastProvider` is mounted once at the root (`app/_layout.tsx`); any screen
 * pulls `useToast().showToast(...)` to raise one. A single toast is shown at a
 * time — a new one replaces the old, since stacked transient errors are noise.
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';
import { copyForError } from '../lib/errorCopy';

export type ToastTone = 'error' | 'info';

export interface ToastOptions {
  /** Headline line. */
  title: string;
  /** Optional second line. */
  body?: string;
  tone?: ToastTone;
  /** Auto-dismiss after this many ms; 0 keeps it until tapped. */
  durationMs?: number;
}

interface ActiveToast extends Required<Omit<ToastOptions, 'durationMs'>> {
  id: number;
  durationMs: number;
}

interface ToastApi {
  /** Raise a toast from explicit copy. */
  showToast: (options: ToastOptions) => void;
  /** Raise an error toast from any caught failure, mapped through `copyForError`. */
  showErrorToast: (err: unknown) => void;
  /** Dismiss the current toast immediately. */
  hideToast: () => void;
}

const DEFAULT_DURATION_MS = 4000;

const ToastContext = createContext<ToastApi | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<ActiveToast | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const idRef = useRef(0);

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const hideToast = useCallback(() => {
    clearTimer();
    setToast(null);
  }, [clearTimer]);

  const showToast = useCallback(
    (options: ToastOptions) => {
      clearTimer();
      const durationMs = options.durationMs ?? DEFAULT_DURATION_MS;
      const next: ActiveToast = {
        id: ++idRef.current,
        title: options.title,
        body: options.body ?? '',
        tone: options.tone ?? 'error',
        durationMs,
      };
      setToast(next);
      if (durationMs > 0) {
        timerRef.current = setTimeout(() => {
          // Only clear if this toast is still the current one.
          setToast((curr) => (curr && curr.id === next.id ? null : curr));
        }, durationMs);
      }
    },
    [clearTimer],
  );

  const showErrorToast = useCallback(
    (err: unknown) => {
      const copy = copyForError(err);
      showToast({ title: copy.title, body: copy.body, tone: 'error' });
    },
    [showToast],
  );

  useEffect(() => clearTimer, [clearTimer]);

  return (
    <ToastContext.Provider value={{ showToast, showErrorToast, hideToast }}>
      {children}
      {toast ? <Toast toast={toast} onDismiss={hideToast} /> : null}
    </ToastContext.Provider>
  );
}

/** The visual toast. Pinned bottom-of-screen, full-width inset, tappable to dismiss. */
function Toast({ toast, onDismiss }: { toast: ActiveToast; onDismiss: () => void }) {
  const surface = toast.tone === 'error' ? 'bg-destructive' : 'bg-foreground';
  const titleColor = toast.tone === 'error' ? 'text-destructiveForeground' : 'text-background';
  const bodyColor = toast.tone === 'error' ? 'text-destructiveForeground' : 'text-background';
  return (
    <View
      pointerEvents="box-none"
      className="absolute inset-x-0 bottom-0 px-4 pb-8"
      accessibilityLiveRegion="polite"
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Dismiss: ${toast.title}`}
        onPress={onDismiss}
        className={`min-h-11 justify-center rounded-lg px-4 py-3 ${surface}`}
      >
        <Text className={`text-base font-semibold ${titleColor}`}>{toast.title}</Text>
        {toast.body ? <Text className={`mt-0.5 text-sm ${bodyColor}`}>{toast.body}</Text> : null}
      </Pressable>
    </View>
  );
}

/** Imperative toast API. Throws if used outside `ToastProvider` (a wiring bug). */
export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error('useToast must be used within a ToastProvider');
  }
  return ctx;
}

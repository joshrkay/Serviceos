/**
 * Inline read-failure block — the shared replacement for the ~dozen ad-hoc
 * `<Text className="...text-destructive">{error}</Text>` sites.
 *
 * Takes whatever a read hook surfaced (an `AppError`, a string, or a bare Error),
 * runs it through `copyForError`, and renders a two-line state: a title and a
 * calmer body. When the failure is `retryable` and the screen passes an `onRetry`
 * (the hook's refetch/reload), it shows a >=44px "Try again" button — lists keep
 * their pull-to-refresh, but detail/home/proposal screens get an explicit tap.
 */
import { Pressable, Text, View } from 'react-native';
import { copyForError } from '../lib/errorCopy';

export interface ErrorStateProps {
  /** The caught failure — `AppError`, string, or Error. */
  error: unknown;
  /** Re-run the failed read; a Retry button shows only when this is set and the error is retryable. */
  onRetry?: () => void;
  /** Override the auto-retryable decision (e.g. lists that retry via pull-to-refresh pass false). */
  showRetry?: boolean;
  className?: string;
}

export function ErrorState({ error, onRetry, showRetry, className }: ErrorStateProps) {
  const copy = copyForError(error);
  const retry = (showRetry ?? copy.retryable) && Boolean(onRetry);

  return (
    <View className={className}>
      <Text className="text-base font-semibold text-destructive">{copy.title}</Text>
      <Text className="mt-1 text-sm text-mutedForeground">{copy.body}</Text>
      {retry ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Try again"
          onPress={onRetry}
          className="mt-3 min-h-11 items-center justify-center rounded-md border border-border px-4 py-3"
        >
          <Text className="text-base text-foreground">Try again</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

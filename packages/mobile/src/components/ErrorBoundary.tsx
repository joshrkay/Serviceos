/**
 * Last-resort UI error boundary.
 *
 * A render-time throw anywhere in the tree (a malformed payload, a null deref the
 * type-checker missed) would otherwise blank the app to a white screen. This
 * class boundary catches it and shows a friendly, in-voice fallback with a
 * "Try again" that re-mounts the subtree by clearing the caught error. Mounted
 * once at the root, wrapping the whole app (`app/_layout.tsx`).
 *
 * React error boundaries must be class components (no hook equivalent for
 * `componentDidCatch`), so this is the one class component in the app.
 */
import { Component, type ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';

interface Props {
  children: ReactNode;
  /** Optional hook for crash reporting; called with the caught error. */
  onError?: (error: Error) => void;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error): void {
    this.props.onError?.(error);
  }

  private reset = (): void => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    if (!this.state.error) return this.props.children;

    return (
      <View className="flex-1 items-center justify-center bg-background px-6">
        <Text className="text-2xl font-semibold text-foreground">Something went wrong</Text>
        <Text className="mt-2 text-center text-base text-mutedForeground">
          We hit a snag on this screen. Try again — your work is safe.
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Try again"
          onPress={this.reset}
          className="mt-6 min-h-11 items-center justify-center rounded-md bg-primary px-6 py-3"
        >
          <Text className="text-base font-semibold text-primaryForeground">Try again</Text>
        </Pressable>
      </View>
    );
  }
}

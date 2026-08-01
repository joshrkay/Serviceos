import { useRouter } from 'expo-router';
import { ActivityIndicator, FlatList, Pressable, RefreshControl, Text, TextInput, View } from 'react-native';
import { ErrorState } from './ErrorState';

export interface EntityRow {
  primary: string;
  secondary?: string;
}

export interface EntityListProps<T> {
  title: string;
  data: T[];
  isLoading: boolean;
  error: string | null;
  onRefresh: () => void;
  keyOf: (item: T) => string;
  renderRow: (item: T) => EntityRow;
  onPressRow?: (item: T) => void;
  emptyText?: string;
  showBack?: boolean;
  searchQuery?: string;
  onSearchChange?: (q: string) => void;
  searchPlaceholder?: string;
  headerAction?: React.ReactNode;
}

/**
 * Shared read-screen list: optional Back, title, search, pull-to-refresh,
 * loading/error/empty states, and tappable rows.
 */
export function EntityList<T>({
  title,
  data,
  isLoading,
  error,
  onRefresh,
  keyOf,
  renderRow,
  onPressRow,
  emptyText,
  showBack = true,
  searchQuery,
  onSearchChange,
  searchPlaceholder = 'Search…',
  headerAction,
}: EntityListProps<T>) {
  const router = useRouter();

  return (
    <View className="flex-1 bg-background pt-16 pb-20">
      <View className="px-6">
        {showBack ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Back"
            onPress={() => router.back()}
            className="min-h-11 justify-center"
          >
            <Text className="text-base text-mutedForeground">‹ Back</Text>
          </Pressable>
        ) : null}
        <View className="mt-2 flex-row items-center justify-between">
          <Text className="font-heading text-2xl font-semibold text-foreground">{title}</Text>
          {headerAction}
        </View>
        {onSearchChange ? (
          <TextInput
            className="mt-4 min-h-11 rounded-md border border-border px-4 py-2 text-base text-foreground"
            placeholder={searchPlaceholder}
            value={searchQuery ?? ''}
            onChangeText={onSearchChange}
          />
        ) : null}
      </View>

      {error ? (
        <View className="px-6 pt-4">
          <ErrorState error={error} onRetry={onRefresh} />
        </View>
      ) : null}

      <FlatList
        data={data}
        keyExtractor={keyOf}
        contentContainerStyle={{ padding: 24 }}
        refreshControl={<RefreshControl refreshing={isLoading} onRefresh={onRefresh} />}
        ListEmptyComponent={
          isLoading ? (
            <ActivityIndicator />
          ) : (
            <Text className="text-base text-mutedForeground">{emptyText ?? 'Nothing here yet.'}</Text>
          )
        }
        renderItem={({ item }) => {
          const row = renderRow(item);
          const body = (
            <>
              <Text className="text-base text-foreground">{row.primary}</Text>
              {row.secondary ? (
                <Text className="mt-0.5 text-sm text-mutedForeground">{row.secondary}</Text>
              ) : null}
            </>
          );
          if (!onPressRow) {
            return (
              <View className="mb-3 min-h-11 rounded-lg border border-border p-4">{body}</View>
            );
          }
          return (
            <Pressable
              accessibilityRole="button"
              onPress={() => onPressRow(item)}
              className="mb-3 min-h-11 rounded-lg border border-border bg-card p-4"
            >
              {body}
            </Pressable>
          );
        }}
      />
    </View>
  );
}

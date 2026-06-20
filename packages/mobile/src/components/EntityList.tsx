import { useRouter } from 'expo-router';
import { ActivityIndicator, FlatList, Pressable, RefreshControl, Text, View } from 'react-native';

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
}

/**
 * Shared read-screen list: a Back control, title, pull-to-refresh, loading /
 * error / empty states, and tappable rows. Each list screen (customers, jobs,
 * invoices, …) is a thin useListQuery → EntityList consumer.
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
}: EntityListProps<T>) {
  const router = useRouter();

  return (
    <View className="flex-1 bg-background pt-16">
      <View className="px-6">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back"
          onPress={() => router.back()}
          className="min-h-11 justify-center"
        >
          <Text className="text-base text-mutedForeground">‹ Back</Text>
        </Pressable>
        <Text className="mt-2 text-2xl font-semibold text-foreground">{title}</Text>
        {error ? <Text className="mt-2 text-base text-destructive">{error}</Text> : null}
      </View>

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
            <View>
              <Text className="text-base text-foreground">{row.primary}</Text>
              {row.secondary ? (
                <Text className="mt-1 text-sm text-mutedForeground">{row.secondary}</Text>
              ) : null}
            </View>
          );
          return onPressRow ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={row.primary}
              onPress={() => onPressRow(item)}
              className="mb-3 min-h-11 rounded-lg border border-border p-4"
            >
              {body}
            </Pressable>
          ) : (
            <View className="mb-3 min-h-11 rounded-lg border border-border p-4">{body}</View>
          );
        }}
      />
    </View>
  );
}

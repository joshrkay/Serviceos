import { useRouter } from 'expo-router';
import { ActivityIndicator, FlatList, Pressable, RefreshControl, Text, View } from 'react-native';
import { ErrorState } from './ErrorState';

export type BadgeTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

export interface EntityBadge {
  label: string;
  tone?: BadgeTone;
}

export interface EntityRow {
  primary: string;
  secondary?: string;
  /** Optional leading avatar text (e.g. initials). */
  leading?: string;
  /** Optional trailing value, right-aligned (e.g. a money amount). */
  trailing?: string;
  /** Optional status pill shown under the trailing value. */
  badge?: EntityBadge;
}

// Confidence/status pills share the Approvals-card tone language: a neutral
// fill with a toned label, so a list reads at a glance (paid = calm, overdue =
// loud) without competing with the row's own text.
const BADGE_TONE: Record<BadgeTone, string> = {
  neutral: 'text-mutedForeground',
  info: 'text-primary',
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-destructive',
};

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

function RowBody({ row }: { row: EntityRow }) {
  return (
    <View className="flex-row items-center">
      {row.leading ? (
        <View className="mr-3 h-10 w-10 items-center justify-center rounded-full bg-secondary">
          <Text className="text-sm font-medium text-secondaryForeground">{row.leading}</Text>
        </View>
      ) : null}
      <View className="flex-1">
        <Text className="text-base text-foreground">{row.primary}</Text>
        {row.secondary ? (
          <Text className="mt-1 text-sm text-mutedForeground">{row.secondary}</Text>
        ) : null}
      </View>
      {row.trailing || row.badge ? (
        <View className="ml-3 items-end">
          {row.trailing ? (
            <Text className="text-base font-medium text-foreground">{row.trailing}</Text>
          ) : null}
          {row.badge ? (
            <Text
              className={`mt-1 rounded-full bg-secondary px-2 py-0.5 text-xs font-medium ${
                BADGE_TONE[row.badge.tone ?? 'neutral']
              }`}
            >
              {row.badge.label}
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

/**
 * Shared read-screen list: a Back control, title, pull-to-refresh, loading /
 * error / empty states, and tappable rows. Each list screen (customers, jobs,
 * invoices, …) is a thin useListQuery → EntityList consumer; rows optionally
 * carry a leading avatar, a trailing amount, and a status badge.
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
        {/* Lists already retry via pull-to-refresh, so no explicit Retry button. */}
        {error ? <ErrorState error={error} showRetry={false} className="mt-2" /> : null}
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
          return onPressRow ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={row.primary}
              onPress={() => onPressRow(item)}
              className="mb-3 min-h-11 rounded-lg border border-border bg-card p-4"
            >
              <RowBody row={row} />
            </Pressable>
          ) : (
            <View className="mb-3 min-h-11 rounded-lg border border-border bg-card p-4">
              <RowBody row={row} />
            </View>
          );
        }}
      />
    </View>
  );
}

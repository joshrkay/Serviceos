import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { ErrorState } from './ErrorState';
import { formatSlotTimeRange, groupSlotsByDay, type Slot } from '../lib/slotPicker';

export interface SlotPickerProps {
  slots: Slot[];
  /** IANA tenant timezone — slots are stored UTC and rendered here. */
  timezone?: string;
  /** ISO start of the currently-selected slot (controlled). */
  selectedStart?: string | null;
  onSelect: (slot: Slot) => void;
  isLoading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  emptyText?: string;
}

/**
 * Open-slot chooser for manual booking (B1) and reschedule slot-pick (B2).
 * Renders slots grouped by tenant-local day; every option is a ≥44px tap
 * target (min-h-11) and wraps rather than overflowing at 320px. Times come
 * pre-computed from the availability endpoint (tenant-tz aware) and are
 * formatted in the same tenant timezone here.
 */
export function SlotPicker({
  slots,
  timezone,
  selectedStart,
  onSelect,
  isLoading,
  error,
  onRetry,
  emptyText = 'No open times in this range. Try another day.',
}: SlotPickerProps) {
  if (isLoading) {
    return (
      <View className="py-6">
        <ActivityIndicator />
      </View>
    );
  }
  if (error) {
    return <ErrorState error={error} showRetry={Boolean(onRetry)} onRetry={onRetry} className="my-2" />;
  }
  if (slots.length === 0) {
    return <Text className="py-4 text-base text-mutedForeground">{emptyText}</Text>;
  }

  const groups = groupSlotsByDay(slots, timezone);

  return (
    <View>
      {groups.map((group) => (
        <View key={group.dayKey} className="mb-4">
          <Text className="mb-2 text-sm font-medium text-mutedForeground">{group.dayLabel}</Text>
          <View className="flex-row flex-wrap gap-2">
            {group.slots.map((slot) => {
              const selected = selectedStart === slot.start;
              return (
                <Pressable
                  key={slot.start}
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  accessibilityLabel={formatSlotTimeRange(slot, timezone)}
                  onPress={() => onSelect(slot)}
                  className={`min-h-11 items-center justify-center rounded-md border px-4 py-3 ${
                    selected ? 'border-primary bg-primary/10' : 'border-border bg-card'
                  }`}
                >
                  <Text className={`text-base ${selected ? 'font-semibold text-primary' : 'text-foreground'}`}>
                    {formatSlotTimeRange(slot, timezone)}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>
      ))}
    </View>
  );
}

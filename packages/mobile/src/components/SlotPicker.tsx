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
  /**
   * #1243 / PRD 3.3 — `config.notes` from GET /api/dispatch/availability: one
   * line per setting (hours, buffer, timezone) the offered times fell back to a
   * default for. Shown so the owner learns the hours are wrong BEFORE a
   * customer books, not after.
   */
  configNotes?: string[];
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
  configNotes,
}: SlotPickerProps) {
  const notice =
    configNotes && configNotes.length > 0 ? (
      <View
        accessibilityRole="alert"
        className="mb-4 rounded-md border border-border bg-muted px-4 py-3"
      >
        <Text className="mb-1 text-sm font-semibold text-foreground">
          These times use default settings
        </Text>
        {configNotes.map((note) => (
          <Text key={note} className="text-sm text-mutedForeground">
            {note}
          </Text>
        ))}
      </View>
    ) : null;

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
    return (
      <View>
        {notice}
        <Text className="py-4 text-base text-mutedForeground">{emptyText}</Text>
      </View>
    );
  }

  const groups = groupSlotsByDay(slots, timezone);

  return (
    <View>
      {notice}
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

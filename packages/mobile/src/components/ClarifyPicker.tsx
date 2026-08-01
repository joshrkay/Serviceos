import { Pressable, Text, View } from 'react-native';

export interface ClarifyOption {
  id: string;
  label: string;
  description?: string;
}

export interface ClarifyPickerProps {
  title: string;
  options: ClarifyOption[];
  onSelect: (option: ClarifyOption) => void;
}

/** One-tap voice_clarification picker — never silently guess entity matches. */
export function ClarifyPicker({ title, options, onSelect }: ClarifyPickerProps) {
  return (
    <View className="rounded-lg border border-border bg-card p-4">
      <Text className="text-base font-medium text-foreground">{title}</Text>
      <Text className="mt-1 text-sm text-mutedForeground">Tap the match you meant.</Text>
      {options.map((opt) => (
        <Pressable
          key={opt.id}
          accessibilityRole="button"
          accessibilityLabel={opt.label}
          onPress={() => onSelect(opt)}
          className="mt-3 min-h-11 justify-center rounded-md border border-border px-4 py-3"
        >
          <Text className="text-base text-foreground">{opt.label}</Text>
          {opt.description ? (
            <Text className="mt-0.5 text-sm text-mutedForeground">{opt.description}</Text>
          ) : null}
        </Pressable>
      ))}
    </View>
  );
}

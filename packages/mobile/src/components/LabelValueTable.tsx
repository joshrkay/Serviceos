import { Text, View } from 'react-native';

export interface LabelValueRow {
  label: string;
  value?: string | null;
}

export function LabelValueTable({ rows }: { rows: LabelValueRow[] }) {
  const visible = rows.filter((r) => r.value);
  if (visible.length === 0) return null;

  return (
    <View className="rounded-lg border border-border">
      {visible.map((r, i) => (
        <View
          key={r.label}
          className={`flex-row justify-between px-4 py-3 ${i < visible.length - 1 ? 'border-b border-border' : ''}`}
        >
          <Text className="text-base text-mutedForeground">{r.label}</Text>
          <Text className="max-w-[60%] text-right text-base text-foreground">{r.value}</Text>
        </View>
      ))}
    </View>
  );
}

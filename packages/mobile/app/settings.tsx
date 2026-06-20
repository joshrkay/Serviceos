import { useRouter } from 'expo-router';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import { useMe } from '../src/hooks/useMe';
import { useSignOut } from '../src/push/useSignOut';

export default function Settings() {
  const router = useRouter();
  const { me, isLoading, error } = useMe();
  const signOut = useSignOut();

  const rows: Array<{ label: string; value?: string }> = [
    { label: 'Role', value: me?.role },
    { label: 'Mode', value: me?.current_mode },
    { label: 'Field-capable', value: me ? (me.can_field_serve ? 'Yes' : 'No') : undefined },
    { label: 'Tenant', value: me?.tenant_id },
  ];

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
        <Text className="mt-2 text-2xl font-semibold text-foreground">Settings</Text>
      </View>

      <ScrollView contentContainerStyle={{ padding: 24 }}>
        {isLoading ? <ActivityIndicator /> : null}
        {error ? <Text className="text-base text-destructive">{error.message}</Text> : null}

        <View className="rounded-lg border border-border">
          {rows
            .filter((r) => r.value !== undefined)
            .map((r) => (
              <View key={r.label} className="flex-row justify-between border-b border-border px-4 py-3">
                <Text className="text-base text-mutedForeground">{r.label}</Text>
                <Text className="text-base text-foreground">{r.value}</Text>
              </View>
            ))}
        </View>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Sign out"
          onPress={() => void signOut()}
          className="mt-8 min-h-11 items-center justify-center rounded-md border border-border px-4 py-3"
        >
          <Text className="text-base text-destructive">Sign out</Text>
        </Pressable>
      </ScrollView>
    </View>
  );
}

import { useLocalSearchParams, useRouter } from 'expo-router';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import { useDetailQuery } from '../../src/hooks/useDetailQuery';

interface Customer {
  id: string;
  name?: string;
  phone?: string;
  email?: string;
  address?: string;
}

export default function CustomerDetail() {
  const params = useLocalSearchParams<{ id: string }>();
  const id = Array.isArray(params.id) ? params.id[0] : (params.id ?? '');
  const router = useRouter();
  const { data, isLoading, error } = useDetailQuery<Customer>(id ? `/api/customers/${id}` : null);

  const rows: Array<{ label: string; value?: string }> = [
    { label: 'Phone', value: data?.phone },
    { label: 'Email', value: data?.email },
    { label: 'Address', value: data?.address },
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
          <Text className="text-base text-mutedForeground">‹ Customers</Text>
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={{ padding: 24 }}>
        {isLoading ? <ActivityIndicator /> : null}
        {error ? <Text className="text-base text-destructive">{error}</Text> : null}

        {data ? (
          <View>
            <Text className="text-2xl font-semibold text-foreground">{data.name ?? 'Unnamed customer'}</Text>
            <View className="mt-5 rounded-lg border border-border">
              {rows
                .filter((r) => r.value)
                .map((r) => (
                  <View key={r.label} className="flex-row justify-between border-b border-border px-4 py-3">
                    <Text className="text-base text-mutedForeground">{r.label}</Text>
                    <Text className="text-base text-foreground">{r.value}</Text>
                  </View>
                ))}
            </View>
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}

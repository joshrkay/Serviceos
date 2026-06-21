import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import { useDetailQuery } from '../../src/hooks/useDetailQuery';
import { useApiClient } from '../../src/lib/useApiClient';
import { startCustomerConversation } from '../../src/messaging/startCustomerConversation';
import { useStartCall } from '../../src/calls/useStartCall';
import { ErrorState } from '../../src/components/ErrorState';
import { useToast } from '../../src/components/Toast';
import { useReconnectRetry } from '../../src/lib/useReconnectRetry';

interface Customer {
  id: string;
  displayName?: string;
  firstName?: string;
  lastName?: string;
  primaryPhone?: string;
  secondaryPhone?: string;
  email?: string;
}

function customerName(c?: Customer): string {
  if (!c) return 'Customer';
  return c.displayName || [c.firstName, c.lastName].filter(Boolean).join(' ') || 'Unnamed customer';
}

export default function CustomerDetail() {
  const params = useLocalSearchParams<{ id: string }>();
  const id = Array.isArray(params.id) ? params.id[0] : (params.id ?? '');
  const router = useRouter();
  const api = useApiClient();
  const { showToast, showErrorToast } = useToast();
  const { data, isLoading, error, refetch } = useDetailQuery<Customer>(
    id ? `/api/customers/${id}` : null,
  );
  const { startCall, isCalling, error: callError } = useStartCall();
  const [messaging, setMessaging] = useState(false);

  // Heal the detail on reconnect if the load failed while offline.
  useReconnectRetry(refetch, Boolean(error));

  // useStartCall keeps its own (already-friendly) error — surface it as a toast
  // so a call failure doesn't push a destructive line into the contact card.
  useEffect(() => {
    if (callError) showToast({ title: callError, tone: 'error' });
  }, [callError, showToast]);

  const name = customerName(data ?? undefined);

  const onMessage = async () => {
    if (!id || messaging) return;
    setMessaging(true);
    try {
      const conversationId = await startCustomerConversation(api, id);
      router.push({ pathname: '/messages/[id]', params: { id: conversationId, title: name } });
    } catch {
      showToast({
        title: "Couldn't open the conversation",
        body: 'Give it another try in a moment.',
        tone: 'error',
      });
    } finally {
      setMessaging(false);
    }
  };

  const rows: Array<{ label: string; value?: string }> = [
    { label: 'Phone', value: data?.primaryPhone },
    { label: 'Alt phone', value: data?.secondaryPhone },
    { label: 'Email', value: data?.email },
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
        {error ? <ErrorState error={error} showRetry onRetry={() => void refetch()} /> : null}

        {data ? (
          <View>
            <Text className="text-2xl font-semibold text-foreground">{name}</Text>

            <View className="mt-4 flex-row gap-2">
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Message"
                onPress={() => void onMessage()}
                disabled={messaging}
                className="min-h-11 flex-1 items-center justify-center rounded-md bg-primary px-4 py-3"
              >
                {messaging ? (
                  <ActivityIndicator />
                ) : (
                  <Text className="text-base font-semibold text-primaryForeground">Message</Text>
                )}
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Call"
                onPress={() => void startCall(id)}
                disabled={isCalling || !data.primaryPhone}
                className="min-h-11 flex-1 items-center justify-center rounded-md border border-border px-4 py-3"
              >
                {isCalling ? (
                  <ActivityIndicator />
                ) : (
                  <Text className="text-base text-foreground">Call</Text>
                )}
              </Pressable>
            </View>

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

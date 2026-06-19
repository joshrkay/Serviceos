import { useAuth } from '@clerk/clerk-expo';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { useMe, type Mode } from '../src/hooks/useMe';

const MODES: Mode[] = ['supervisor', 'both', 'tech'];

// Home / bootstrap screen. Proves the auth + API wiring: it loads GET /api/me
// and lets the owner switch mode (POST /api/me/mode). Real Home/Today content
// (money loop, approvals) arrives in later units.
export default function Home() {
  const { signOut } = useAuth();
  const router = useRouter();
  const { me, isLoading, error, switchMode } = useMe();
  const [modeError, setModeError] = useState<string | null>(null);

  if (isLoading) {
    return (
      <View className="flex-1 items-center justify-center bg-background">
        <ActivityIndicator />
      </View>
    );
  }

  if (error) {
    return (
      <View className="flex-1 items-center justify-center bg-background px-6">
        <Text className="text-base text-destructive">{error.message}</Text>
      </View>
    );
  }

  return (
    <View className="flex-1 justify-center bg-background px-6">
      <Text className="text-2xl font-semibold text-foreground">ServiceOS</Text>
      <Text className="mt-1 text-base text-mutedForeground">
        You learned the trade. We&apos;ll run the business.
      </Text>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Speak an action"
        onPress={() => router.push('/voice')}
        className="mt-6 min-h-11 items-center justify-center rounded-md bg-primary px-4 py-3"
      >
        <Text className="text-base font-semibold text-primaryForeground">Speak an action</Text>
      </Pressable>

      <View className="mt-4 rounded-lg border border-border p-4">
        <Text className="text-base text-foreground">Role: {me?.role}</Text>
        <Text className="mt-1 text-base text-foreground">Mode: {me?.current_mode}</Text>
        <Text className="mt-1 text-base text-mutedForeground">Tenant: {me?.tenant_id}</Text>
      </View>

      <Text className="mt-6 mb-2 text-base text-mutedForeground">Switch mode</Text>
      <View className="flex-row gap-2">
        {MODES.map((m) => {
          const active = me?.current_mode === m;
          return (
            <Pressable
              key={m}
              accessibilityRole="button"
              accessibilityLabel={`Switch to ${m} mode`}
              onPress={() => {
                setModeError(null);
                void switchMode(m).catch((e) =>
                  setModeError(e instanceof Error ? e.message : 'Could not switch mode.'),
                );
              }}
              className={`min-h-11 flex-1 items-center justify-center rounded-md px-3 py-2 ${
                active ? 'bg-primary' : 'bg-secondary'
              }`}
            >
              <Text className={active ? 'text-primaryForeground' : 'text-secondaryForeground'}>
                {m}
              </Text>
            </Pressable>
          );
        })}
      </View>
      {modeError ? (
        <Text className="mt-2 text-base text-destructive">{modeError}</Text>
      ) : null}

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Sign out"
        onPress={() => {
          void signOut();
        }}
        className="mt-6 min-h-11 items-center justify-center rounded-md border border-border px-4 py-3"
      >
        <Text className="text-base text-foreground">Sign out</Text>
      </Pressable>
    </View>
  );
}

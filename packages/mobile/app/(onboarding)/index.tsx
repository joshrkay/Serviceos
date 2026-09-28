import { useAuth } from '@clerk/clerk-expo';
import { useRouter } from 'expo-router';
import { Pressable, Text, View } from 'react-native';
import { skipSetupGateForSession } from '../../src/hooks/useOnboardingStatus';

export default function Onboarding() {
  const router = useRouter();
  const { userId } = useAuth();

  const onSkip = () => {
    // Explicit deferral — the setup gate honors this for the session instead
    // of bouncing the owner straight back here.
    skipSetupGateForSession(userId);
    router.replace('/');
  };

  return (
    <View className="flex-1 bg-background px-6 pb-20 pt-24">
      <Text className="font-heading text-2xl font-semibold text-foreground">Welcome</Text>
      <Text className="mt-2 text-base text-mutedForeground">
        Start with your voice — tell us about your business and we&apos;ll set things up.
      </Text>

      <View className="flex-1 items-center justify-center">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Hold to speak"
          onPress={() => router.push('/voice')}
          className="h-44 w-44 items-center justify-center rounded-full bg-primary"
        >
          <Text className="text-lg font-semibold text-primaryForeground">Tap mic</Text>
        </Pressable>
        <Text className="mt-4 text-center text-base text-mutedForeground">
          Voice-first onboarding — speak naturally about your trade, service area, and crew.
        </Text>
      </View>

      <Pressable
        accessibilityRole="button"
        onPress={onSkip}
        className="min-h-11 items-center justify-center rounded-md border border-border px-4 py-3"
      >
        <Text className="text-base text-foreground">Skip for now</Text>
      </Pressable>
    </View>
  );
}

import { useRouter } from 'expo-router';
import { Pressable, Text, View } from 'react-native';

/**
 * Unmatched-route screen (expo-router `+not-found` convention). Unknown deep
 * links render this instead of a blank page. It lives under the root
 * layout's AuthGate, so signed-out deep links still bounce to sign-in first.
 */
export default function NotFound() {
  const router = useRouter();

  return (
    <View className="flex-1 items-center justify-center bg-background px-6">
      <Text className="font-heading text-2xl font-semibold text-foreground">
        That page doesn&apos;t exist
      </Text>
      <Text className="mt-2 text-center text-base text-mutedForeground">
        The link you followed is broken or out of date.
      </Text>

      <Pressable
        accessibilityRole="button"
        onPress={() => router.replace('/')}
        className="mt-6 min-h-11 items-center justify-center rounded-md bg-primary px-6 py-3"
      >
        <Text className="text-base font-semibold text-primaryForeground">Back to home</Text>
      </Pressable>
    </View>
  );
}

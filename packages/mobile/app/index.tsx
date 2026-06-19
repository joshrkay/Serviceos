import { Text, View } from 'react-native';

// Placeholder home so the app renders. Replaced by the real Home/Today screen
// (GET /api/me + /api/proposals/inbox) in a later unit.
export default function Home() {
  return (
    <View className="flex-1 items-center justify-center bg-background px-6">
      <Text className="text-2xl font-semibold text-foreground">ServiceOS</Text>
      <Text className="mt-2 text-center text-base text-mutedForeground">
        You learned the trade. We&apos;ll run the business.
      </Text>
    </View>
  );
}

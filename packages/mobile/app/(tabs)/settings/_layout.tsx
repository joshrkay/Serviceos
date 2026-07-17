import { Stack } from 'expo-router';

export default function SettingsLayout() {
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="index" />
      <Stack.Screen name="team" />
      <Stack.Screen name="voice" />
      <Stack.Screen name="brand-voice" />
      <Stack.Screen name="templates" />
    </Stack>
  );
}

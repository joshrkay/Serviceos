import '../global.css';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';

// Root layout. Auth (ClerkProvider) and the push notification router are wired
// in later units (U2, U8); this scaffold just mounts the Expo Router stack.
export default function RootLayout() {
  return (
    <>
      <StatusBar style="auto" />
      <Stack screenOptions={{ headerShown: false }} />
    </>
  );
}

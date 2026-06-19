import { useSignIn } from '@clerk/clerk-expo';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Pressable, Text, TextInput, View } from 'react-native';

// Native email + password sign-in. Clerk-expo has no prebuilt native UI, so we
// drive the flow with the `useSignIn` hook. (OAuth / email-code strategies can
// be added later depending on the tenant's Clerk config.)
export default function SignIn() {
  const { signIn, setActive, isLoaded } = useSignIn();
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const onSignIn = async () => {
    if (!isLoaded || busy) return;
    setBusy(true);
    setError(null);
    try {
      const attempt = await signIn.create({ identifier: email.trim(), password });
      if (attempt.status === 'complete') {
        await setActive({ session: attempt.createdSessionId });
        router.replace('/');
      } else {
        setError('Additional verification is required to sign in.');
      }
    } catch (err) {
      const message =
        (err as { errors?: { message?: string }[] })?.errors?.[0]?.message ??
        'Sign-in failed. Check your email and password.';
      setError(message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <View className="flex-1 justify-center bg-background px-6">
      <Text className="mb-1 text-2xl font-semibold text-foreground">Sign in</Text>
      <Text className="mb-6 text-base text-mutedForeground">
        You learned the trade. We&apos;ll run the business.
      </Text>

      <TextInput
        className="mb-3 min-h-11 rounded-md border border-border px-4 text-base text-foreground"
        placeholder="Email"
        placeholderTextColor="#717182"
        autoCapitalize="none"
        autoComplete="email"
        keyboardType="email-address"
        value={email}
        onChangeText={setEmail}
      />
      <TextInput
        className="mb-3 min-h-11 rounded-md border border-border px-4 text-base text-foreground"
        placeholder="Password"
        placeholderTextColor="#717182"
        secureTextEntry
        value={password}
        onChangeText={setPassword}
      />

      {error ? <Text className="mb-3 text-base text-destructive">{error}</Text> : null}

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Sign in"
        onPress={onSignIn}
        disabled={busy || !isLoaded}
        className="min-h-11 items-center justify-center rounded-md bg-primary px-4 py-3"
      >
        {busy ? (
          <ActivityIndicator color="#ffffff" />
        ) : (
          <Text className="text-base font-semibold text-primaryForeground">Sign in</Text>
        )}
      </Pressable>
    </View>
  );
}

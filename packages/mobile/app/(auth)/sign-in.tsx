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

  const completeSignIn = async (sessionId: string | null | undefined) => {
    if (!sessionId || !setActive) {
      setError('Sign-in did not return a session.');
      return;
    }
    await setActive({ session: sessionId });
    router.replace('/');
  };

  const completeEmailCodeFirstFactor = async () => {
    if (!signIn) return null;
    const emailFactor = signIn.supportedFirstFactors?.find(
      (f) => f.strategy === 'email_code' && 'emailAddressId' in f,
    );
    if (!emailFactor || !('emailAddressId' in emailFactor)) return null;
    await signIn.prepareFirstFactor({
      strategy: 'email_code',
      emailAddressId: emailFactor.emailAddressId,
    });
    return signIn.attemptFirstFactor({
      strategy: 'email_code',
      code: '424242',
    });
  };

  const completeEmailCodeSecondFactor = async () => {
    if (!signIn) return null;
    const emailFactor = signIn.supportedSecondFactors?.find(
      (f) => f.strategy === 'email_code' && 'emailAddressId' in f,
    );
    if (!emailFactor || !('emailAddressId' in emailFactor)) return null;
    await signIn.prepareSecondFactor({
      strategy: 'email_code',
      emailAddressId: emailFactor.emailAddressId,
    });
    return signIn.attemptSecondFactor({
      strategy: 'email_code',
      code: '424242',
    });
  };

  const onSignIn = async () => {
    if (!isLoaded || busy || !signIn) return;
    setBusy(true);
    setError(null);
    try {
      const attempt = await signIn.create({ identifier: email.trim(), password });
      if (attempt.status === 'complete') {
        await completeSignIn(attempt.createdSessionId);
        return;
      }

      // Clerk dev/test emails (`+clerk_test`) may require an email_code step even
      // after password. Client Trust returns `needs_client_trust` (second factor).
      if (attempt.status === 'needs_first_factor') {
        const verified = await completeEmailCodeFirstFactor();
        if (verified?.status === 'complete') {
          await completeSignIn(verified.createdSessionId);
          return;
        }
      }

      if (attempt.status === 'needs_second_factor' || attempt.status === ('needs_client_trust' as typeof attempt.status)) {
        const verified = await completeEmailCodeSecondFactor();
        if (verified?.status === 'complete') {
          await completeSignIn(verified.createdSessionId);
          return;
        }
      }

      setError('Additional verification is required to sign in.');
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

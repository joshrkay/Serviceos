import { useSignIn } from '@clerk/clerk-expo';
import { useLocalSearchParams, useRouter, type Href } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Pressable, Text, TextInput, View } from 'react-native';
import { readSessionExpiredParams } from '../../src/lib/sessionExpired';

// Clerk's magic test code auto-succeeds ONLY for `+clerk_test` addresses.
// It must never be attempted for a real account: Clerk emails a real
// one-time code and '424242' would simply fail, locking the user out.
const CLERK_TEST_CODE = '424242';
const isClerkTestEmail = (email: string): boolean => /\+clerk_test@/i.test(email);

type PendingFactor = 'first' | 'second';

// Native email + password sign-in. Clerk-expo has no prebuilt native UI, so we
// drive the flow with the `useSignIn` hook. When Clerk demands an email_code
// step (first factor, second factor, or Client Trust on a new device) we
// prepare the factor — which sends the code email — and collect the code here.
export default function SignIn() {
  const { signIn, setActive, isLoaded } = useSignIn();
  const router = useRouter();
  // A session-expired redirect (from useApiClient) carries `reason` + `next`:
  // explain why we're here, and resume to `next` after re-auth instead of Home.
  const params = useLocalSearchParams<{ reason?: string; next?: string }>();
  const { expired, next } = readSessionExpiredParams(params);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [pendingFactor, setPendingFactor] = useState<PendingFactor | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const completeSignIn = async (sessionId: string | null | undefined) => {
    if (!sessionId || !setActive) {
      setError('Sign-in did not return a session.');
      return;
    }
    await setActive({ session: sessionId });
    // Resume where the expired session left off, else land on Home.
    router.replace((next ?? '/') as Href);
  };

  // Send the email_code for the given factor. Returns false when the factor
  // isn't offered by Clerk for this account (nothing was prepared).
  const prepareEmailCode = async (factor: PendingFactor): Promise<boolean> => {
    if (!signIn) return false;
    const factors =
      factor === 'first' ? signIn.supportedFirstFactors : signIn.supportedSecondFactors;
    const emailFactor = factors?.find(
      (f) => f.strategy === 'email_code' && 'emailAddressId' in f,
    );
    if (!emailFactor || !('emailAddressId' in emailFactor)) return false;
    if (factor === 'first') {
      await signIn.prepareFirstFactor({
        strategy: 'email_code',
        emailAddressId: emailFactor.emailAddressId,
      });
    } else {
      await signIn.prepareSecondFactor({
        strategy: 'email_code',
        emailAddressId: emailFactor.emailAddressId,
      });
    }
    return true;
  };

  const attemptEmailCode = async (factor: PendingFactor, oneTimeCode: string) => {
    if (!signIn) return null;
    return factor === 'first'
      ? signIn.attemptFirstFactor({ strategy: 'email_code', code: oneTimeCode })
      : signIn.attemptSecondFactor({ strategy: 'email_code', code: oneTimeCode });
  };

  // Prepare the email_code step, then either auto-complete (test accounts
  // only) or hand off to the code-entry UI for the real emailed code.
  const startEmailCodeStep = async (factor: PendingFactor): Promise<void> => {
    const prepared = await prepareEmailCode(factor);
    if (!prepared) {
      setError('Additional verification is required to sign in.');
      return;
    }
    if (isClerkTestEmail(email)) {
      const verified = await attemptEmailCode(factor, CLERK_TEST_CODE);
      if (verified?.status === 'complete') {
        await completeSignIn(verified.createdSessionId);
        return;
      }
      setError('Additional verification is required to sign in.');
      return;
    }
    setCode('');
    setPendingFactor(factor);
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

      // Client Trust (new-device verification) returns `needs_client_trust`
      // and is satisfied through the second-factor email_code API.
      if (attempt.status === 'needs_first_factor') {
        await startEmailCodeStep('first');
        return;
      }
      if (
        attempt.status === 'needs_second_factor' ||
        attempt.status === ('needs_client_trust' as typeof attempt.status)
      ) {
        await startEmailCodeStep('second');
        return;
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

  const onVerifyCode = async () => {
    if (busy || !pendingFactor || !code.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const verified = await attemptEmailCode(pendingFactor, code.trim());
      if (verified?.status === 'complete') {
        await completeSignIn(verified.createdSessionId);
        return;
      }
      setError('That code did not work. Check the latest email and try again.');
    } catch (err) {
      const message =
        (err as { errors?: { message?: string }[] })?.errors?.[0]?.message ??
        'That code did not work. Check the latest email and try again.';
      setError(message);
    } finally {
      setBusy(false);
    }
  };

  const onBackToPassword = () => {
    setPendingFactor(null);
    setCode('');
    setError(null);
  };

  if (pendingFactor) {
    return (
      <View className="flex-1 justify-center bg-background px-6">
        <Text className="mb-1 text-2xl font-semibold text-foreground">Check your email</Text>
        <Text className="mb-6 text-base text-mutedForeground">
          We sent a one-time code to {email.trim()}. Enter it below to finish
          signing in.
        </Text>

        <TextInput
          className="mb-3 min-h-11 rounded-md border border-border px-4 text-base text-foreground"
          placeholder="One-time code"
          placeholderTextColor="#717182"
          autoCapitalize="none"
          autoComplete="one-time-code"
          keyboardType="number-pad"
          value={code}
          onChangeText={setCode}
        />

        {error ? <Text className="mb-3 text-base text-destructive">{error}</Text> : null}

        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Verify code"
          onPress={onVerifyCode}
          disabled={busy || !code.trim()}
          className="min-h-11 items-center justify-center rounded-md bg-primary px-4 py-3"
        >
          {busy ? (
            <ActivityIndicator color="#ffffff" />
          ) : (
            <Text className="text-base font-semibold text-primaryForeground">Verify code</Text>
          )}
        </Pressable>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back to sign in"
          onPress={onBackToPassword}
          disabled={busy}
          className="mt-3 min-h-11 items-center justify-center rounded-md px-4 py-3"
        >
          <Text className="text-base font-medium text-mutedForeground">Back to sign in</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View className="flex-1 justify-center bg-background px-6">
      <Text className="mb-1 text-2xl font-semibold text-foreground">Sign in</Text>
      <Text className="mb-6 text-base text-mutedForeground">
        You learned the trade. We&apos;ll run the business.
      </Text>

      {expired ? (
        <View
          className="mb-6 rounded-lg border border-border bg-accent p-4"
          accessibilityRole="alert"
        >
          <Text className="text-base font-medium text-accentForeground">Your session expired</Text>
          <Text className="mt-1 text-sm text-mutedForeground">
            Please sign in again to pick up where you left off.
          </Text>
        </View>
      ) : null}

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

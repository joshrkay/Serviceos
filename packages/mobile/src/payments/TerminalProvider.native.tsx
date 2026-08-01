import { useCallback, type ReactNode } from 'react';
import { StripeTerminalProvider } from '@stripe/stripe-terminal-react-native';
import { useApiClient } from '../lib/useApiClient';
import { createTerminalConnectionToken } from '../api/terminal';
import { isTerminalSdkAvailable } from './terminalTypes';

/**
 * Wraps the signed-in tree with Stripe Terminal when the native module is linked.
 * tokenProvider is called by the SDK whenever it needs a fresh connection token.
 */
export function TerminalProvider({ children }: { children: ReactNode }): JSX.Element {
  const client = useApiClient();

  const tokenProvider = useCallback(async () => {
    const { secret } = await createTerminalConnectionToken(client);
    return secret;
  }, [client]);

  if (!isTerminalSdkAvailable()) {
    return <>{children}</>;
  }

  return (
    <StripeTerminalProvider logLevel="verbose" tokenProvider={tokenProvider}>
      <>{children}</>
    </StripeTerminalProvider>
  );
}

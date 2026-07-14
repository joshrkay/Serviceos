import type { ReactNode } from 'react';

/**
 * Web / Expo export: Terminal native module is unavailable — pass children through.
 */
export function TerminalProvider({ children }: { children: ReactNode }): JSX.Element {
  return <>{children}</>;
}

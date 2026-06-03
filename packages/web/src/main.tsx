import React from 'react';
import ReactDOM from 'react-dom/client';
import { ClerkProvider } from '@clerk/clerk-react';
import { RouterProvider } from 'react-router';
import { router } from './routes';
import { AuthTokenBridge } from './components/auth/AuthTokenBridge';
import { AnalyticsIdentityBridge } from './components/auth/AnalyticsIdentityBridge';
import { TenantTimezoneProvider } from './hooks/useTenantTimezone';
import { getRuntimeConfigValue } from './lib/runtimeConfig';
import { initAnalytics } from './lib/analytics';
import './index.css';

const CLERK_PUBLISHABLE_KEY = getRuntimeConfigValue(
  'VITE_CLERK_PUBLISHABLE_KEY'
) as string | undefined;

if (!CLERK_PUBLISHABLE_KEY) {
  throw new Error('VITE_CLERK_PUBLISHABLE_KEY is required — add it to your .env file');
}

// Warm the analytics bundle if a key is configured. No-op when not.
initAnalytics();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ClerkProvider
      publishableKey={CLERK_PUBLISHABLE_KEY}
      signInUrl="/login"
      signUpUrl="/signup"
      afterSignOutUrl="/login"
    >
      <AuthTokenBridge />
      <AnalyticsIdentityBridge />
      <TenantTimezoneProvider>
        <RouterProvider router={router} />
      </TenantTimezoneProvider>
    </ClerkProvider>
  </React.StrictMode>
);

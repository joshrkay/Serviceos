import React from 'react';
import ReactDOM from 'react-dom/client';
import { ClerkProvider } from '@clerk/clerk-react';
import { RouterProvider } from 'react-router';
import { router } from './routes';
import { ErrorBoundary } from './components/layout/ErrorBoundary';
import { AuthTokenBridge } from './components/auth/AuthTokenBridge';
import { AnalyticsIdentityBridge } from './components/auth/AnalyticsIdentityBridge';
import { TenantTimezoneProvider } from './hooks/useTenantTimezone';
import { getRuntimeConfigValue } from './lib/runtimeConfig';
import { initAnalytics } from './lib/analytics';
import { initErrorReporting } from './lib/errorReporter';
import { registerServiceWorker } from './pwa/register-sw';
import './index.css';

const CLERK_PUBLISHABLE_KEY = getRuntimeConfigValue(
  'VITE_CLERK_PUBLISHABLE_KEY'
) as string | undefined;

if (!CLERK_PUBLISHABLE_KEY) {
  throw new Error('VITE_CLERK_PUBLISHABLE_KEY is required — add it to your .env file');
}

// Warm the analytics bundle if a key is configured. No-op when not.
initAnalytics();

// ARCH-31 / OBS-43 — global async-error capture. Registers
// window 'unhandledrejection' / 'error' listeners once, at boot, before
// anything else can run and throw. Reports via the same (off-by-default)
// PostHog client as initAnalytics() above.
initErrorReporting();

// Boot Pendo SDK with an anonymous visitor. The SDK resolves the previous
// visitor from cookies/localStorage if available, otherwise falls back to
// a new anonymous visitor. Called exactly once per page lifecycle.
// Guarded: the snippet is a third-party script that ad blockers commonly
// block — analytics must never prevent the app from rendering.
try {
  if (typeof pendo !== 'undefined' && pendo) {
    pendo.initialize({ visitor: { id: '' } });
  }
} catch {
  // Pendo unavailable — proceed without product analytics.
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {/* Outermost boundary: route-level errorElements only cover the routed
        subtree — a render throw in the providers above RouterProvider would
        otherwise white-screen the app with no fallback. */}
    <ErrorBoundary>
      <ClerkProvider
        publishableKey={CLERK_PUBLISHABLE_KEY}
        clerkJSVersion="5.127.0"
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
    </ErrorBoundary>
  </React.StrictMode>
);

// R4 (native-mobile parity): register the service worker after boot so Rivet
// is installable and opens offline. No-ops in dev / unsupported browsers.
void registerServiceWorker();

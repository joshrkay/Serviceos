import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// DEV-ONLY: when VITE_AUTH_MODE=dev, swap the Clerk SDK for a local shim so
// the authenticated app boots headlessly without Clerk's hosted frontend
// (unreachable in sandboxed CI / verification). Never active in a real build.
const devAuth = process.env.VITE_AUTH_MODE === 'dev';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      // @stripe/react-stripe-js@3.x ships no `exports` map and its `browser`
      // field points at the UMD build. Under vite 8 that combination breaks
      // the DEV server both ways: the dep optimizer emits default-export
      // interop glue the package doesn't have ("does not provide an export
      // named 'default'" on /pay), and merely excluding it from optimization
      // makes resolution follow `browser` to the UMD file, which has no named
      // ESM exports ("does not provide an export named 'Elements'"). Alias
      // straight to the real ESM entry so both dev and build see the same
      // named-exports module. Production output was verified unchanged.
      '@stripe/react-stripe-js': fileURLToPath(
        new URL(
          '../../node_modules/@stripe/react-stripe-js/dist/react-stripe.esm.mjs',
          import.meta.url,
        ),
      ),
      ...(devAuth
        ? {
            '@clerk/clerk-react': fileURLToPath(
              new URL('./src/dev/clerk-dev-shim.tsx', import.meta.url),
            ),
          }
        : {}),
    },
  },
  build: {
    rollupOptions: {
      output: {
        // Split large third-party libraries out of the app bundle so the
        // initial download stays small and vendor code is cached across
        // deploys (BUG-6: previously a single 1.56 MB bundle).
        manualChunks(id) {
          if (!id.includes('node_modules')) return;
          if (id.includes('recharts') || id.includes('d3-')) return 'charts';
          if (id.includes('@clerk')) return 'clerk';
          if (id.includes('@stripe')) return 'stripe';
          if (
            id.includes('react-router') ||
            id.includes('react-dom') ||
            id.includes('/node_modules/react/') ||
            id.includes('scheduler')
          ) {
            return 'react-vendor';
          }
          if (id.includes('@radix-ui')) return 'radix';
          if (id.includes('lucide-react')) return 'icons';
          return 'vendor';
        },
      },
    },
  },
  server: {
    proxy: {
      // ws: true so the /api/ws client-gateway WebSocket handshake is
      // forwarded in dev (a plain string target proxies HTTP only, leaving
      // useResilientStream in a permanent reconnect loop locally).
      '/api': {
        target: process.env.VITE_API_URL || 'http://localhost:3000',
        changeOrigin: true,
        ws: true,
      },
      // All view-token-gated public API mounts (intake/estimates/invoices/
      // feedback) live at bare /public on the API — proxy the whole prefix,
      // not just /public/intake.
      '/public': process.env.VITE_API_URL || 'http://localhost:3000',
      // Dev-only object storage receiver; the API's DevStorageProvider
      // returns upload URLs under this prefix when STORAGE_* env vars
      // are absent. Prod uses presigned R2/S3 URLs that hit R2 directly.
      '/storage-dev': process.env.VITE_API_URL || 'http://localhost:3000',
    },
  },
});

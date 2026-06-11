import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
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
      '/api': process.env.VITE_API_URL || 'http://localhost:3000',
      '/public/intake': process.env.VITE_API_URL || 'http://localhost:3000',
      // Dev-only object storage receiver; the API's DevStorageProvider
      // returns upload URLs under this prefix when STORAGE_* env vars
      // are absent. Prod uses presigned R2/S3 URLs that hit R2 directly.
      '/storage-dev': process.env.VITE_API_URL || 'http://localhost:3000',
    },
  },
});

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      '/api': process.env.VITE_API_URL || 'http://localhost:3000',
      // Dev-only object storage receiver; the API's DevStorageProvider
      // returns upload URLs under this prefix when STORAGE_* env vars
      // are absent. Prod uses presigned R2/S3 URLs that hit R2 directly.
      '/storage-dev': process.env.VITE_API_URL || 'http://localhost:3000',
    },
  },
});

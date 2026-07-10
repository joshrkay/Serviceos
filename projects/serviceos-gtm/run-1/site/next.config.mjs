/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Static-first: marketing pages are statically generated at build time.
  // Only the /api/* route handlers are dynamic (Node runtime).
  poweredByHeader: false,
  async headers() {
    // Preview-safety belt-and-suspenders: any non-production Vercel env gets a
    // noindex header at the edge in addition to robots.ts disallow-all.
    const isProd = process.env.VERCEL_ENV === 'production';
    if (isProd) return [];
    return [
      {
        source: '/:path*',
        headers: [{ key: 'X-Robots-Tag', value: 'noindex, nofollow' }],
      },
    ];
  },
};

export default nextConfig;

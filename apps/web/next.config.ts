import path from 'node:path';
import type { NextConfig } from 'next';

const apiUrl = process.env.API_INTERNAL_URL ?? 'http://localhost:4000';

const csp = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

const config: NextConfig = {
  output: 'standalone',
  outputFileTracingRoot: path.join(__dirname, '../..'),
  poweredByHeader: false,
  rewrites() {
    return Promise.resolve([{ source: '/api/:path*', destination: `${apiUrl}/:path*` }]);
  },
  headers() {
    return Promise.resolve([
      {
        source: '/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: csp },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
    ]);
  },
};

export default config;

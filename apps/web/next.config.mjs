/** @type {import('next').NextConfig} */
const API = process.env.API_INTERNAL_URL || 'http://localhost:4000';

const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'no-referrer' },
  { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
  { key: 'Permissions-Policy', value: 'camera=(self), microphone=(), geolocation=()' },
];

export default {
  reactStrictMode: true,
  poweredByHeader: false,
  output: 'standalone',
  // o navegador fala apenas com o Next; /api/* é repassado para a API (mesma origem => cookie httpOnly seguro)
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${API}/api/:path*` }];
  },
  async headers() {
    return [
      { source: '/:path*', headers: securityHeaders },
      // o token do link não deve vazar para outros sites
      { source: '/enviar/:token', headers: [{ key: 'Cache-Control', value: 'no-store' }] },
    ];
  },
};

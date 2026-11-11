/** @type {import('next').NextConfig} */
const backendOrigin =
  process.env.BYTEFORGE_API_INTERNAL_URL || 'http://localhost:8000';

const nextConfig = {
  eslint: {
    ignoreDuringBuilds: true,
  },
  images: { unoptimized: true },
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: `${backendOrigin}/api/:path*`,
      },
    ];
  },
};

module.exports = nextConfig;

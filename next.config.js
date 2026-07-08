/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  productionBrowserSourceMaps: false,
  output: 'standalone',
  outputFileTracingRoot: __dirname,
  // Disable critters optimizeCss to avoid missing module during build
  experimental: {
    optimizeCss: false,
    scrollRestoration: true,
  },
  // Inject project root path as environment variable
  env: {
    NEXT_PUBLIC_PROJECT_ROOT: process.cwd(),
  },
  // Turbopack (default since Next 16) resolves Node builtins in client
  // bundles itself; no fallback stubs needed.
  turbopack: {},
  // Kept for `next build --webpack`: exclude server-only modules from the
  // client bundle.
  webpack: (config, { isServer }) => {
    if (!isServer) {
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        path: false,
        os: false,
      };
    }
    return config;
  },
};

module.exports = nextConfig;

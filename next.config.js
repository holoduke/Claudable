/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  productionBrowserSourceMaps: false,
  // Disable critters optimizeCss to avoid missing module during build
  experimental: {
    optimizeCss: false,
    scrollRestoration: true,
  },
  // Turbopack (default since Next 16) resolves Node builtins in client
  // bundles itself; no fallback stubs needed.
  turbopack: {},
};

module.exports = nextConfig;

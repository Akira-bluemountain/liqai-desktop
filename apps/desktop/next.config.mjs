/**
 * Next.js configuration for Tauri.
 *
 * SECURITY:
 *   - `output: 'export'` produces a static site (no SSR, no Node server)
 *     — Tauri loads the bundle from the local disk only.
 *   - `images: { unoptimized: true }` because Next's image optimiser needs
 *     a server (incompatible with static export).
 *   - `trailingSlash: true` ensures all routes resolve to directory-index
 *     paths which the Tauri asset protocol serves cleanly.
 */
/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'export',
  distDir: 'out',
  images: { unoptimized: true },
  trailingSlash: true,
  reactStrictMode: true,
  assetPrefix: '',
  poweredByHeader: false,
};

export default nextConfig;

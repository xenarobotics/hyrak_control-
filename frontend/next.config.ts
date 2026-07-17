import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactCompiler: true,
  // Cesium assets are copied to public/cesium via postinstall script
  turbopack: {},
  // Allow external hostnames to reach the dev server (e.g. Cloudflare Tunnel)
  allowedDevOrigins: ['dev.xenarobotics.com'],
};

export default nextConfig;

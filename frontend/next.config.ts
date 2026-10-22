import type { NextConfig } from "next";

const nextConfig: NextConfig = {
    // Next's dev badge sat on the rail's Account button.
    devIndicators: { position: 'bottom-right' },
  reactCompiler: true,
  // Cesium assets are copied to public/cesium via postinstall script
  turbopack: {},
  // Allow external hostnames to reach the dev server (e.g. Cloudflare Tunnel)
  allowedDevOrigins: ['dev.xenarobotics.com'],
};

export default nextConfig;

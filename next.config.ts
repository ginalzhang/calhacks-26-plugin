import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // The dev-mode "N" badge sits over the side panel's bottom-left tiles.
  devIndicators: false,
  // Steady drives the real pointer: no other site may frame it (clickjacking / hidden-iframe control).
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
          // Lets scripts/demo-chrome.sh tell this build apart from another Steady checkout on the same port.
          { key: "X-Steady-Build", value: "calhacks-26-plugin" },
        ],
      },
    ];
  },
};

export default nextConfig;

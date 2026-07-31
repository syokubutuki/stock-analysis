import type { NextConfig } from "next";
import { LEGACY_HOST } from "./app/lib/site-url";

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        source: "/:path*",
        has: [{ type: "host", value: LEGACY_HOST }],
        headers: [{ key: "X-Robots-Tag", value: "noindex, follow" }],
      },
    ];
  },
};

export default nextConfig;

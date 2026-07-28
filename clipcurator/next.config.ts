import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
  // Proxy VOD and clip file requests to the clipper backend
  // so the video player can load them without CORS issues
  async rewrites() {
    const clipperUrl = process.env.CLIPPER_URL || "http://localhost:8100";
    return [
      {
        source: "/vod/:path*",
        destination: `${clipperUrl}/vod/:path*`,
      },
      {
        source: "/clip/:path*",
        destination: `${clipperUrl}/clip/:path*`,
      },
    ];
  },
};

export default nextConfig;

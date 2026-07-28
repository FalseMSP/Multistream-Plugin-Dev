import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
  // Serve ClipCurator under /clipcurator so it can be reverse-proxied
  // by the multistream overlay server on port 2999.
  // Access at: http://host:2999/clipcurator/
  basePath: "/clipcurator",
  // Tell Turbopack where the clipcurator project root is.
  // This is needed because the parent directory has its own package-lock.json
  // which confuses Next.js about the workspace root.
  turbopack: {
    root: ".",
  },
  // Proxy VOD and clip file requests to the clipper backend
  // so the video player can load them without CORS issues.
  // Note: these paths are relative to basePath, so /vod/... actually
  // means /clipcurator/vod/... in the browser.
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

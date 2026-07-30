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

  // Allow the dev server (HMR / webpack-hmr websocket) to be reached from
  // hosts other than localhost. Without this, browsers hitting the dev
  // server from a public IP get the "Blocked cross-origin request" warning.
  allowedDevOrigins: [
    "129.213.29.112",
    "localhost",
    "127.0.0.1",
  ],

  // Tell Turbopack where the clipcurator project root is.
  // MUST be an absolute path — a relative value like "." corrupts the
  // React Client Manifest and breaks client hydration.
  turbopack: {
    root: process.cwd(),
  },

  // Proxy VOD, clip, and backing-track file requests to the clipper backend
  // so the browser can load them without CORS issues.
  // Note: these paths are relative to basePath, so /vod/... actually
  // means /clipcurator/vod/... in the browser.
  //
  // IMPORTANT: storagePath in the DB is "/vods/{id}/master.mp4" (plural),
  // but the clipper's endpoint is "/vod/{id}/master.mp4" (singular).
  // We add rewrite rules for BOTH plural and singular to handle this
  // mismatch without needing to migrate existing DB rows.
  async rewrites() {
    const clipperUrl = process.env.CLIPPER_URL || "http://localhost:8100";
    return [
      // VOD files (plural storagePath → singular clipper endpoint)
      {
        source: "/vods/:path*",
        destination: `${clipperUrl}/vod/:path*`,
      },
      {
        source: "/vod/:path*",
        destination: `${clipperUrl}/vod/:path*`,
      },
      // Clip files (plural storagePath → singular clipper endpoint)
      {
        source: "/clips/:path*",
        destination: `${clipperUrl}/clip/:path*`,
      },
      {
        source: "/clip/:path*",
        destination: `${clipperUrl}/clip/:path*`,
      },
      // Backing tracks
      {
        source: "/backing/:path*",
        destination: `${clipperUrl}/backing/:path*`,
      },
    ];
  },
};

export default nextConfig;

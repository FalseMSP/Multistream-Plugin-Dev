import type { NextConfig } from "next";
import path from "node:path";

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
  // server from a public IP get the "Blocked cross-origin request to
  // Next.js dev resource" warning, which can stall hydration.
  // Add your own host/IP here if you access from somewhere else.
  allowedDevOrigins: [
    "129.213.29.112",
    "localhost",
    "127.0.0.1",
  ],

  // Tell Turbopack where the clipcurator project root is.
  // MUST be an absolute path — a relative value like "." corrupts the
  // React Client Manifest and breaks client hydration, which is what
  // causes "buttons don't work" (the server-rendered HTML loads, but
  // React never attaches event handlers on the client).
  //
  // We use process.cwd() because `next dev` is always launched from
  // inside the clipcurator/ directory (see start-clipcurator.sh).
  turbopack: {
    root: process.cwd(),
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

// `path` is imported above for any future absolute-path needs; keep the
// import so the linter doesn't strip it if you switch to path.resolve().
void path;

export default nextConfig;

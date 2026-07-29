'use strict';

/**
 * clipcurator-proxy.js
 * ────────────────────
 * Reverse-proxy for ClipCurator's Next.js app.
 *
 * Mounts on the overlay server at /clipcurator and forwards all requests
 * to the Next.js dev server running on an internal port (default 3001).
 *
 * This means ClipCurator is accessible at http://host:2999/clipcurator
 * instead of a separate port — everything lives under the same origin.
 *
 * The Next.js app is configured with basePath: '/clipcurator' so its
 * internal routing (API calls, static assets, client-side navigation)
 * all use the /clipcurator prefix automatically.
 *
 * Authentication is handled by the ClipCurator Next.js app's own
 * middleware (middleware.ts), which validates the dash_session cookie
 * by calling GET /api/auth/check on the overlay server. The proxy
 * does NOT add its own auth gate — it simply forwards requests.
 *
 * No UDP is needed — everything is HTTP (REST + SSE).
 */

const http = require('http');
const log  = require('./logger');
const auth = require('./dashboard/auth');

const CLIPCURATOR_HOST = process.env.CLIPCURATOR_HOST || '127.0.0.1';
const CLIPCURATOR_PORT = parseInt(process.env.CLIPCURATOR_PORT || '3001', 10);
const PREFIX = '/clipcurator';

/**
 * Handle an incoming request and proxy it to the ClipCurator Next.js app.
 *
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse}  res
 */
function handleClipCuratorRequest(req, res) {
  const url = req.url.split('?')[0];

  // If someone hits exactly /clipcurator (no trailing slash), redirect to /clipcurator/
  // This ensures Next.js basePath routing works correctly.
  if (url === PREFIX) {
    const query = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
    res.writeHead(302, { Location: PREFIX + '/' + query });
    res.end();
    return;
  }

  // Forward the request to the Next.js app
  proxyRequest(req, res);
}

/**
 * Proxy a single HTTP request to the ClipCurator Next.js backend.
 * Streams the request body (if any) and the response body back to the client.
 * Supports all HTTP methods (GET, POST, PUT, DELETE, etc.) and SSE streams.
 */
function proxyRequest(req, res) {
  const proxyOptions = {
    hostname: CLIPCURATOR_HOST,
    port:     CLIPCURATOR_PORT,
    path:     req.url,
    method:   req.method,
    headers:  {
      ...req.headers,
      host: `${CLIPCURATOR_HOST}:${CLIPCURATOR_PORT}`,
      // Preserve the original request's forwarded info
      'x-forwarded-for':  req.socket.remoteAddress,
      'x-forwarded-host': req.headers.host || '',
      'x-forwarded-proto': 'http',
    },
  };

  // Remove hop-by-hop headers that shouldn't be forwarded
  delete proxyOptions.headers['connection'];
  delete proxyOptions.headers['keep-alive'];
  delete proxyOptions.headers['transfer-encoding'];
  delete proxyOptions.headers['te'];
  delete proxyOptions.headers['trailer'];
  delete proxyOptions.headers['upgrade'];

  const proxyReq = http.request(proxyOptions, (proxyRes) => {
    // Check if the backend is returning an error that indicates it's not running
    if (proxyRes.statusCode === 502 || proxyRes.statusCode === 503) {
      serveBackendUnavailable(res);
      proxyRes.resume(); // drain the response
      return;
    }

    // Forward the response headers
    const headers = { ...proxyRes.headers };
    // Remove hop-by-hop headers from the response
    delete headers['connection'];
    delete headers['keep-alive'];
    delete headers['transfer-encoding'];

    res.writeHead(proxyRes.statusCode, headers);
    // Pipe the response body back to the client
    proxyRes.pipe(res);
  });

  proxyReq.on('error', (err) => {
    // If the Next.js backend isn't running, show a helpful message
    if (err.code === 'ECONNREFUSED') {
      serveBackendUnavailable(res);
    } else {
      log.error(`[clipcurator-proxy] Proxy error: ${err.message}`);
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<html><body><h2>ClipCurator Error</h2><p>Proxy error: ${err.message}</p></body></html>`);
      }
    }
  });

  // Pipe the request body (for POST/PUT) to the backend
  req.pipe(proxyReq);
}

/**
 * Serve a friendly "backend not running" page.
 */
function serveBackendUnavailable(res) {
  res.writeHead(502, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>ClipCurator — Not Running</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0a0a0a; color: #e5e5e5; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
    .card { background: #1a1a1a; border: 1px solid #333; border-radius: 8px; padding: 32px; max-width: 480px; text-align: center; }
    h2 { color: #ef4444; margin: 0 0 12px; }
    p { color: #999; font-size: 14px; line-height: 1.6; }
    code { background: #2a2a2a; padding: 2px 6px; border-radius: 4px; font-size: 13px; color: #10b981; }
  </style>
</head>
<body>
  <div class="card">
    <h2>ClipCurator is not running</h2>
    <p>The ClipCurator Next.js backend is not reachable on
    <code>${CLIPCURATOR_HOST}:${CLIPCURATOR_PORT}</code>.</p>
    <p>Start it with <code>./dev-both.sh clips</code> or
    <code>cd clipcurator && npm run dev -- -p 3001</code></p>
  </div>
</body>
</html>`);
}

/**
 * Mount the ClipCurator proxy onto an overlay-server instance.
 *
 * @param {{ addPrefixRoute: Function }} overlayModule
 */
function mountOnOverlayServer(overlayModule) {
  // Register an auth-check API endpoint used by ClipCurator's middleware.ts
  // to validate the dash_session cookie. This is called by the Next.js app
  // (running on port 3001) to check if the user is authenticated on the
  // overlay server (port 2999).
  overlayModule.addRoute('/api/auth/check', (req, res) => {
    const authenticated = auth._isAuthenticated(req);
    res.writeHead(200, {
      'Content-Type':  'application/json; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify({ authenticated }));
  });

  // Register prefix-based proxy for /clipcurator/*
  overlayModule.addPrefixRoute(PREFIX, handleClipCuratorRequest);
  log.info(`[clipcurator-proxy] Mounted at ${PREFIX}/* → ${CLIPCURATOR_HOST}:${CLIPCURATOR_PORT}`);
}

module.exports = {
  handleClipCuratorRequest,
  mountOnOverlayServer,
  PREFIX,
};

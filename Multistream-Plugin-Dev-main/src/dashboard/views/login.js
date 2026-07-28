'use strict';

/**
 * Login page HTML builder.
 * ────────────────────────────────────────────────────────────────────────────
 * Returns a complete standalone HTML document for the dashboard login page.
 * The single `errorMsg` parameter is interpolated into the page if present.
 *
 * Kept as a template literal (rather than a static .html file) because the
 * page is tiny and the only interpolation is the error message — a static
 * file + tiny templating helper would add machinery for negligible gain.
 */

function buildLoginPage(errorMsg = '') {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Dashboard · Login</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --bg:      #0d0d0f;
    --surface: #16171a;
    --border:  #2a2b30;
    --accent:  #e53935;
    --text:    #e8e8ec;
    --muted:   #5a5a6a;
  }
  html, body { height: 100%; background: var(--bg); font-family: system-ui, sans-serif; color: var(--text); display: flex; align-items: center; justify-content: center; }
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 36px 32px; width: 100%; max-width: 360px; }
  h1 { font-size: 18px; font-weight: 700; margin-bottom: 24px; display: flex; align-items: center; gap: 10px; }
  h1 svg { color: var(--accent); }
  label { font-size: 12px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); display: block; margin-bottom: 6px; }
  input[type=password] {
    width: 100%; padding: 10px 12px; background: var(--bg); border: 1px solid var(--border);
    border-radius: 5px; color: var(--text); font-size: 14px; outline: none; transition: border-color 0.15s;
  }
  input[type=password]:focus { border-color: var(--accent); }
  button {
    width: 100%; margin-top: 18px; padding: 10px; background: var(--accent); color: #fff;
    border: none; border-radius: 5px; font-size: 14px; font-weight: 700; cursor: pointer;
    letter-spacing: 0.04em; transition: opacity 0.15s;
  }
  button:hover { opacity: 0.88; }
  .error { margin-top: 14px; font-size: 12px; color: var(--accent); text-align: center; }
</style>
</head>
<body>
<div class="card">
  <h1>
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
      <rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>
    </svg>
    Stream Dashboard
  </h1>
  <form method="POST" action="/dashboard/login">
    <label for="pwd">Password</label>
    <input id="pwd" type="password" name="password" autofocus autocomplete="current-password" placeholder="Enter dashboard password">
    <button type="submit">Sign in</button>
  </form>
  ${errorMsg ? `<p class="error">${errorMsg}</p>` : ''}
</div>
</body>
</html>`;
}

module.exports = { buildLoginPage };

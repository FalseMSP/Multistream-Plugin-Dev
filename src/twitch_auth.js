/**
 * twitch-auth.js  —  run this ONCE to authorise the broadcaster account.
 *
 * No local server needed. Flow:
 *  1. Script prints an authorisation URL.
 *  2. Open it in a browser while logged in as the broadcaster and click Authorise.
 *  3. The browser redirects to http://localhost and shows an error (that's fine).
 *  4. Copy the full URL from the address bar and paste it back into this script.
 *  5. Tokens are saved to .twitch-tokens.json and the bot can be restarted.
 *
 * One-time setup in the Twitch Developer Console:
 *  • Add  http://localhost  as an OAuth Redirect URI for your app.
 *    (No port, no path — just http://localhost)
 *
 * Required env vars (same as the main app):
 *   TWITCH_CLIENT_ID
 *   TWITCH_CLIENT_SECRET
 */

require('dotenv').config();
const https    = require('https');
const fs       = require('fs');
const path     = require('path');
const crypto   = require('crypto');
const readline = require('readline');

const CLIENT_ID     = process.env.TWITCH_CLIENT_ID     ?? '';
const CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET ?? '';
const REDIRECT_URI  = 'http://localhost';
const TOKEN_FILE    = path.resolve('.twitch-tokens.json');

const SCOPES = [
  'bits:read',
  'channel:read:subscriptions',
  'channel:manage:vips',
  'moderator:manage:banned_users',
].join(' ');

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('ERROR: TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET must be set in .env');
  process.exit(1);
}

const state = crypto.randomBytes(16).toString('hex');

const authUrl =
  `https://id.twitch.tv/oauth2/authorize` +
  `?client_id=${CLIENT_ID}` +
  `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
  `&response_type=code` +
  `&scope=${encodeURIComponent(SCOPES)}` +
  `&state=${state}`;

console.log('\n──────────────────────────────────────────────────────────────');
console.log('STEP 1 — Make sure http://localhost is added as an OAuth Redirect');
console.log('         URI in your Twitch Developer Console app settings.');
console.log('\nSTEP 2 — Open this URL in a browser logged in as the BROADCASTER:');
console.log('\n  ' + authUrl);
console.log('\nSTEP 3 — After clicking Authorise, the browser will show an error');
console.log('         page (connection refused). That is expected.');
console.log('         Copy the full URL from the address bar and paste it below.');
console.log('──────────────────────────────────────────────────────────────\n');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

rl.question('Paste the redirect URL here: ', async (input) => {
  rl.close();
  input = input.trim();

  let code, returnedState;
  try {
    // The pasted value might be just the URL or have surrounding whitespace/quotes
    const url      = new URL(input.replace(/^['"`]+|['"`]+$/g, ''));
    code           = url.searchParams.get('code');
    returnedState  = url.searchParams.get('state');
    const error    = url.searchParams.get('error');
    if (error) throw new Error(`Twitch denied authorisation: ${error}`);
    if (!code)  throw new Error('No "code" parameter found in the URL');
  } catch (err) {
    console.error('\nERROR parsing URL:', err.message);
    console.error('Make sure you pasted the full URL from the address bar.\n');
    process.exit(1);
  }

  if (returnedState !== state) {
    console.error('\nERROR: State mismatch. Please run the script again from scratch.\n');
    process.exit(1);
  }

  console.log('\nExchanging code for tokens…');
  try {
    const tokenRes = await post('https://id.twitch.tv/oauth2/token', new URLSearchParams({
      client_id:     CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code,
      grant_type:    'authorization_code',
      redirect_uri:  REDIRECT_URI,
    }).toString());

    const tokens = {
      access_token:  tokenRes.access_token,
      refresh_token: tokenRes.refresh_token,
      expires_at:    Date.now() + (tokenRes.expires_in - 60) * 1000,
      scopes:        tokenRes.scope ?? [],
    };

    fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2));
    console.log(`\n✅ Tokens saved to ${TOKEN_FILE}`);
    console.log('   Scopes granted:', tokens.scopes.join(', '));
    console.log('   Restart the bot to apply.\n');
  } catch (err) {
    console.error('\nERROR exchanging code:', err.message, '\n');
    process.exit(1);
  }
});

// Minimal promise-based HTTPS POST (no extra dependencies)
function post(url, body) {
  return new Promise((resolve, reject) => {
    const u   = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      path:     u.pathname,
      method:   'POST',
      headers:  {
        'Content-Type':   'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.error) reject(new Error(`${json.error}: ${json.message}`));
          else resolve(json);
        } catch { reject(new Error('Non-JSON response: ' + data)); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}
const { google } = require('googleapis');
const fs         = require('fs');
const readline   = require('readline');

const SCOPES     = ['https://www.googleapis.com/auth/youtube.force-ssl'];
const TOKEN_FILE = '.youtube-tokens.json';
const creds      = JSON.parse(fs.readFileSync('client_secret.json'));
const { client_id, client_secret } = creds.installed ?? creds.web;

// Use a plain localhost URI — no port, no server needed
const REDIRECT_URI = 'http://localhost';
const oauth2 = new google.auth.OAuth2(client_id, client_secret, REDIRECT_URI);

const authUrl = oauth2.generateAuthUrl({
  access_type: 'offline',
  scope:       SCOPES,
  prompt:      'consent',
});

console.log('\nSTEP 1 — Add this as an Authorized Redirect URI in Google Cloud Console:');
console.log('         http://localhost');
console.log('\nSTEP 2 — Open this URL in a browser logged in as the broadcaster:');
console.log('\n  ' + authUrl);
console.log('\nSTEP 3 — After authorizing, the browser will show a connection refused');
console.log('         error. That is expected. Copy the full URL from the address bar.');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.question('\nPaste the redirect URL here: ', async (input) => {
  rl.close();
  try {
    const url  = new URL(input.trim());
    const code = url.searchParams.get('code');
    if (!code) throw new Error('No code found in URL');

    const { tokens } = await oauth2.getToken(code);
    fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2));
    console.log('\n✅ Tokens saved to', TOKEN_FILE);
    console.log('   Restart the bot to apply.\n');
  } catch (err) {
    console.error('\nERROR:', err.message);
    process.exit(1);
  }
});
// Party Machines Booth — Google Drive sign-in helper (Cloudflare Worker, free plan).
// Keeps your Google "refresh token" so the booth never asks you to sign in again.
// Variables to set in Cloudflare: CLIENT_ID, CLIENT_SECRET, BOOTH_KEY (all secret), then REFRESH_TOKEN after step "auth".
const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const ALLOWED = ['https://partymachinessa.github.io'];
let cache = { token: '', exp: 0 };

export default {
  async fetch(req, env) {
    const url = new URL(req.url), origin = req.headers.get('Origin') || '';
    const okOrigin = ALLOWED.includes(origin) || /^http:\/\/localhost(:\d+)?$/.test(origin);
    const cors = { 'Access-Control-Allow-Origin': okOrigin ? origin : ALLOWED[0], 'Access-Control-Allow-Headers': 'X-Booth-Key', 'Vary': 'Origin' };
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
    const redirect = url.origin + '/callback';

    // 1) one-time: open  https://<this-worker>/auth?key=BOOTH_KEY  and approve Google
    if (url.pathname === '/auth') {
      if (url.searchParams.get('key') !== env.BOOTH_KEY) return new Response('Wrong key', { status: 403 });
      const p = new URLSearchParams({ client_id: env.CLIENT_ID, redirect_uri: redirect, response_type: 'code', scope: SCOPE, access_type: 'offline', prompt: 'consent' });
      return Response.redirect('https://accounts.google.com/o/oauth2/v2/auth?' + p, 302);
    }
    // 2) Google sends you back here; show the refresh token so you can save it as REFRESH_TOKEN
    if (url.pathname === '/callback') {
      const code = url.searchParams.get('code'); if (!code) return new Response('No code from Google: ' + (url.searchParams.get('error') || ''), { status: 400 });
      const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ code, client_id: env.CLIENT_ID, client_secret: env.CLIENT_SECRET, redirect_uri: redirect, grant_type: 'authorization_code' }) });
      const j = await r.json();
      if (!j.refresh_token) return new Response('Google did not give a refresh token: ' + JSON.stringify(j), { status: 400 });
      return new Response('<meta name=viewport content="width=device-width"><body style="font:16px system-ui;padding:20px"><h2>Almost done</h2><p>Copy this and save it in Cloudflare as a secret variable named <b>REFRESH_TOKEN</b>:</p><textarea style="width:100%;height:140px" onclick="this.select()">' + j.refresh_token + '</textarea>', { headers: { 'Content-Type': 'text/html' } });
    }
    // 3) the booth asks for a fresh upload key
    if (url.pathname === '/token') {
      if (req.headers.get('X-Booth-Key') !== env.BOOTH_KEY) return new Response('Wrong key', { status: 403, headers: cors });
      if (!env.REFRESH_TOKEN) return new Response('REFRESH_TOKEN is not set yet', { status: 500, headers: cors });
      if (cache.token && Date.now() < cache.exp - 120000) return Response.json({ access_token: cache.token, expires_in: Math.floor((cache.exp - Date.now()) / 1000) }, { headers: cors });
      const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: env.CLIENT_ID, client_secret: env.CLIENT_SECRET, refresh_token: env.REFRESH_TOKEN, grant_type: 'refresh_token' }) });
      const j = await r.json(); if (!j.access_token) return Response.json(j, { status: 502, headers: cors });
      cache = { token: j.access_token, exp: Date.now() + j.expires_in * 1000 };
      return Response.json({ access_token: j.access_token, expires_in: j.expires_in }, { headers: cors });
    }
    return new Response('Party Machines helper is running.', { headers: cors });
  },
};

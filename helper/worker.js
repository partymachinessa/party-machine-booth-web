// Party Machines Booth — helper (Cloudflare Worker, free plan).
// 1. Keeps your Google "refresh token" so the booth never asks you to sign in again.
// 2. Shows guests a Party Machines page for their video (instead of a plain Google Drive folder), and streams the video from your Drive.
// Variables in Cloudflare: CLIENT_ID, CLIENT_SECRET, BOOTH_KEY. The Google login is kept in the BOOTH storage (KV);
// REFRESH_TOKEN is only the old fallback. To reconnect Google open  https://<this-worker>/auth?key=BOOTH_KEY  and approve.
const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const ALLOWED = ['https://partymachinessa.github.io'];
const SITE = 'https://partymachinessa.github.io/party-machine-booth-web/';
const DRIVE = 'https://www.googleapis.com/drive/v3/';
let cache = { token: '', exp: 0 };

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const html = (body, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });

async function refreshToken(env) { return (env.BOOTH && await env.BOOTH.get('refresh_token')) || env.REFRESH_TOKEN || ''; }
async function accessToken(env) {
  if (cache.token && Date.now() < cache.exp - 120000) return { access_token: cache.token, expires_in: Math.floor((cache.exp - Date.now()) / 1000) };
  const rt = await refreshToken(env); if (!rt) return { error: 'not_connected' };
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env.CLIENT_ID, client_secret: env.CLIENT_SECRET, refresh_token: rt, grant_type: 'refresh_token' }) });
  const j = await r.json(); if (!j.access_token) return { error: j.error || 'google_error', detail: j.error_description || '' };
  cache = { token: j.access_token, exp: Date.now() + j.expires_in * 1000 };
  return { access_token: j.access_token, expires_in: j.expires_in };
}
async function drive(env, path) {
  const t = await accessToken(env); if (!t.access_token) throw Object.assign(new Error('google'), { status: 503 });
  const r = await fetch(DRIVE + path, { headers: { Authorization: 'Bearer ' + t.access_token } });
  if (!r.ok) throw Object.assign(new Error('drive ' + r.status), { status: r.status });
  return r.json();
}
const isPublic = async (env, id) => (await drive(env, `files/${id}/permissions?fields=permissions(type,role)`)).permissions.some(p => p.type === 'anyone');
const info = async (env, id) => { try { return JSON.parse((await drive(env, `files/${id}?fields=description`)).description || '{}'); } catch { return {}; } };

/* ---------- guest page ---------- */
async function videoPage(env, id, base) {
  const f = await drive(env, `files/${id}?fields=id,name,mimeType,parents,description`);
  if (f.mimeType !== 'application/vnd.google-apps.folder' || !(await isPublic(env, id))) return notFound();
  const kids = (await drive(env, `files?q=${encodeURIComponent(`'${id}' in parents and trashed=false`)}&fields=files(id,name,mimeType,createdTime)&orderBy=createdTime&pageSize=1000`)).files;
  const subs = kids.filter(k => k.mimeType === 'application/vnd.google-apps.folder');
  let ev, clips = [];
  if (subs.length) {                                         // an event folder: the gallery of every video
    ev = { name: f.name.replace(/^\d{4}-\d\d-\d\d_/, '').replace(/-/g, ' '), ...JSON.parse(f.description || '{}') };
    for (let i = 0; i < subs.length; i += 40) {
      const part = subs.slice(i, i + 40), q = '(' + part.map(s => `'${s.id}' in parents`).join(' or ') + ') and trashed=false';
      const files = (await drive(env, `files?q=${encodeURIComponent(q)}&fields=files(id,name,mimeType,parents)&pageSize=1000`)).files;
      for (const s of part) clips.push({ when: s.createdTime, files: files.filter(x => x.parents && x.parents[0] === s.id) });
    }
  } else {                                                   // one guest's folder: their video(s)
    ev = { name: '', ...(f.parents ? await info(env, f.parents[0]) : {}) };
    clips = [{ when: f.createdTime, files: kids }];
  }
  clips = clips.map(c => ({ main: c.files.find(x => /template/.test(x.name) && x.mimeType.startsWith('video')) || c.files.find(x => x.mimeType.startsWith('video') && !/_plain/.test(x.name)),
    plain: c.files.find(x => /_plain/.test(x.name) && x.mimeType.startsWith('video')), thumb: c.files.find(x => x.mimeType.startsWith('image')) })).filter(c => c.main || c.plain);
  return html(page(ev, clips, !subs.length, base));
}
const notFound = () => html(shell('Video not found', `<div class="hero"><img class="logo" src="${SITE}logo.png" alt=""><h1>Video not found</h1><p class="sub">This link is not active any more. Ask the Party Machines team for a new QR code.</p></div>`), 404);
function shell(title, body, script = '') {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>${esc(title)}</title>
<link rel="icon" href="${SITE}icon-192.png"><link rel="apple-touch-icon" href="${SITE}icon-180.png"><meta name="theme-color" content="#071233">
<meta property="og:title" content="${esc(title)}"><meta property="og:image" content="${SITE}icon-512.png">
<style>
:root{--bg:#071233;--panel:#0f1f4d;--line:#22356f;--text:#f3f6ff;--mut:#9fb0d8;--accent:#ffd21f;--ink:#1a1400;--blue:#2f7bff}
*{box-sizing:border-box}html,body{margin:0;background:var(--bg);color:var(--text);font:16px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
body{background:radial-gradient(circle at 50% -10%,#1d3f96 0%,var(--bg) 60%) fixed}
main{max-width:720px;margin:0 auto;padding:22px 16px calc(env(safe-area-inset-bottom) + 28px);display:flex;flex-direction:column;gap:18px}
.hero{text-align:center;display:flex;flex-direction:column;align-items:center;gap:6px}
.logo{width:96px;height:96px;border-radius:24px;box-shadow:0 8px 30px rgba(0,0,0,.45)}
h1{margin:6px 0 0;font-size:clamp(26px,7vw,38px);line-height:1.1}h1 b{color:var(--accent)}
.sub{color:var(--mut);margin:0}
.card{background:var(--panel);border:1px solid var(--line);border-radius:22px;padding:12px;display:flex;flex-direction:column;gap:10px}
video{width:100%;border-radius:14px;background:#000;display:block;max-height:70vh}
.tabs{display:flex;background:#0a1740;border-radius:99px;padding:4px;gap:4px}.tabs button{flex:1;border:0;border-radius:99px;padding:10px;font:inherit;font-weight:700;background:none;color:var(--mut)}.tabs button.on{background:var(--blue);color:#fff}
.btn{display:flex;align-items:center;justify-content:center;gap:8px;min-height:54px;border-radius:16px;border:1px solid var(--line);background:#14275e;color:var(--text);font:inherit;font-weight:800;text-decoration:none;width:100%}
.btn.primary{background:var(--accent);color:var(--ink);border-color:transparent;font-size:18px}
.row{display:flex;gap:10px}.row>*{flex:1}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px}
.tile{position:relative;aspect-ratio:3/4;border-radius:16px;overflow:hidden;background:#0a1740;border:1px solid var(--line);padding:0;cursor:pointer}
.tile img{width:100%;height:100%;object-fit:cover;display:block}.tile span{position:absolute;left:8px;bottom:8px;background:rgba(0,0,0,.6);border-radius:99px;padding:2px 10px;font-size:13px;color:#fff}
.tile i{position:absolute;inset:0;display:grid;place-items:center;font-style:normal;font-size:34px;color:rgba(255,255,255,.9);text-shadow:0 2px 10px #000}
#viewer{position:fixed;inset:0;background:rgba(3,8,26,.96);z-index:9;display:none;flex-direction:column;gap:12px;padding:16px 16px calc(env(safe-area-inset-bottom) + 16px);overflow:auto}#viewer.show{display:flex}
#viewer .top{display:flex;justify-content:space-between;align-items:center}#viewer .x{border:0;background:#14275e;color:#fff;border-radius:99px;padding:10px 16px;font:inherit;font-weight:700}
.tip{font-size:14px;color:var(--mut);text-align:center}
.social{color:var(--accent);font-weight:700;text-align:center}
footer{text-align:center;color:var(--mut);font-size:13px;display:flex;flex-direction:column;align-items:center;gap:6px;margin-top:6px}footer img{width:34px;height:34px;border-radius:9px}
</style></head><body><main>${body}</main>${script}</body></html>`;
}
function page(ev, clips, single, base) {
  const src = (f, dl) => f ? `${base}/f/${f.id}${dl ? '?dl=1' : ''}` : '';
  const data = clips.map(c => ({ main: src(c.main), plain: src(c.plain), mainDl: src(c.main, 1), plainDl: src(c.plain, 1), mainName: c.main && c.main.name, plainName: c.plain && c.plain.name, thumb: src(c.thumb) }));
  const name = ev.name ? `<p class="sub">${esc(ev.name)}</p>` : '';
  const head = `<div class="hero"><img class="logo" src="${SITE}logo.png" alt="Party Machines 360"><h1>${single ? 'Your <b>360°</b> video' : `<b>${clips.length}</b> videos from the 360° booth`}</h1>${name}${ev.msg && single ? `<p class="sub">${esc(ev.msg)}</p>` : ''}</div>`;
  const player = `<div class="card"><div class="tabs" id="tabs" hidden><button data-v="main" class="on">With design</button><button data-v="plain">Original</button></div>
    <video id="v" playsinline controls loop autoplay muted preload="auto"></video>
    <button class="btn primary" id="save">⤓ Save to my phone</button>
    <div class="row"><a class="btn" id="dl" download>Download</a><button class="btn" id="share">Share</button></div>
    <div class="tip" id="tip">Tap “Save to my phone”, then choose <b>Save Video</b>.</div></div>`;
  const social = ev.social ? `<div class="social">${esc(ev.social)}</div>` : '';
  const foot = `<footer><img src="${SITE}icon-180.png" alt=""><div>Made with the <b>Party Machines 360°</b> booth</div></footer>`;
  const body = single
    ? (data.length ? head + player + social + foot : notFoundBody())
    : head + `<div class="grid">${data.map((d, i) => `<button class="tile" data-i="${i}">${d.thumb ? `<img src="${d.thumb}" alt="" loading="lazy">` : ''}<i>▶</i><span>${i + 1}</span></button>`).join('')}</div>` + social + foot +
      `<div id="viewer"><div class="top"><b id="vt"></b><button class="x" id="close">Close</button></div>${player}</div>`;
  const script = `<script>
const D=${JSON.stringify(data).replace(/</g, '\\u003c')}, single=${single};
let cur=null,view='main',blobs={};
const $=s=>document.querySelector(s), v=$('#v');
async function prep(u,name){ if(blobs[u]) return blobs[u]; try{ const b=await (await fetch(u)).blob(); blobs[u]=new File([b],name||'party-machines-360.mp4',{type:b.type||'video/mp4'}); }catch(e){} return blobs[u]; }
function open(i){ cur=D[i]; view='main'; if(!cur.main){view='plain';}
  $('#tabs').hidden=!(cur.main&&cur.plain); [...document.querySelectorAll('#tabs button')].forEach(b=>b.classList.toggle('on',b.dataset.v===view)); load();
  if(!single){ $('#vt').textContent='Video '+(i+1); $('#viewer').classList.add('show'); } }
function load(){ const u=cur[view]; v.src=u; v.play().catch(()=>{}); $('#dl').href=cur[view+'Dl']; prep(u,cur[view+'Name']); }
document.querySelectorAll('#tabs button').forEach(b=>b.onclick=()=>{view=b.dataset.v;document.querySelectorAll('#tabs button').forEach(x=>x.classList.toggle('on',x===b));load();});
async function share(){ const f=blobs[cur[view]];
  if(f&&navigator.canShare&&navigator.canShare({files:[f]})){ try{ await navigator.share({files:[f]}); return; }catch(e){ if(e.name==='AbortError') return; } }
  if(!f){ $('#tip').textContent='Still loading the video — try again in a moment.'; prep(cur[view],cur[view+'Name']); return; }
  location.href=cur[view+'Dl']; }
$('#save').onclick=share; $('#share').onclick=async()=>{ try{ await navigator.share({title:'My 360° video',url:location.href}); }catch(e){ try{ await navigator.clipboard.writeText(location.href); $('#tip').textContent='Link copied.'; }catch(_){} } };
if(single){ if(D.length) open(0); } else { document.querySelectorAll('.tile').forEach(t=>t.onclick=()=>open(+t.dataset.i)); $('#close').onclick=()=>{ v.pause(); $('#viewer').classList.remove('show'); }; }
</script>`;
  return shell(single ? 'Your 360° video · Party Machines' : `${ev.name || 'Event'} · 360° videos`, body, script);
}
const notFoundBody = () => `<div class="hero"><img class="logo" src="${SITE}logo.png" alt=""><h1>Almost ready…</h1><p class="sub">Your video is still uploading. Refresh this page in a minute.</p></div>`;

/* ---------- video / photo stream (only videos and photos, never backups) ---------- */
async function stream(env, id, req, dl) {
  const meta = await drive(env, `files/${id}?fields=name,mimeType,size`);
  if (!/^(video|image)\//.test(meta.mimeType)) return new Response('Not found', { status: 404 });
  const t = await accessToken(env), h = { Authorization: 'Bearer ' + t.access_token }, range = req.headers.get('Range'); if (range) h.Range = range;
  const r = await fetch(`${DRIVE}files/${id}?alt=media`, { headers: h });
  const out = new Headers({ 'Content-Type': meta.mimeType, 'Accept-Ranges': 'bytes', 'Cache-Control': 'public, max-age=86400', 'Access-Control-Allow-Origin': '*' });
  for (const k of ['Content-Length', 'Content-Range']) if (r.headers.get(k)) out.set(k, r.headers.get(k));
  if (dl) out.set('Content-Disposition', `attachment; filename="${meta.name.replace(/[^\w.\-]+/g, '_')}"`);
  return new Response(r.body, { status: r.status, headers: out });
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url), origin = req.headers.get('Origin') || '';
    const okOrigin = ALLOWED.includes(origin) || /^http:\/\/localhost(:\d+)?$/.test(origin);
    const cors = { 'Access-Control-Allow-Origin': okOrigin ? origin : ALLOWED[0], 'Access-Control-Allow-Headers': 'X-Booth-Key', 'Vary': 'Origin' };
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
    const redirect = url.origin + '/callback';

    // connect Google: open  https://<this-worker>/auth?key=BOOTH_KEY  and approve (the app's "Reconnect Google" button does this)
    if (url.pathname === '/auth') {
      if (url.searchParams.get('key') !== env.BOOTH_KEY) return new Response('Wrong key', { status: 403 });
      const state = crypto.randomUUID(); await env.BOOTH.put('state:' + state, '1', { expirationTtl: 900 });
      const p = new URLSearchParams({ client_id: env.CLIENT_ID, redirect_uri: redirect, response_type: 'code', scope: SCOPE, access_type: 'offline', prompt: 'consent', state });
      return Response.redirect('https://accounts.google.com/o/oauth2/v2/auth?' + p, 302);
    }
    // Google sends you back here; the login is saved straight away (no copying)
    if (url.pathname === '/callback') {
      const code = url.searchParams.get('code'), state = url.searchParams.get('state') || '';
      if (!code) return html(shell('Not connected', `<div class="hero"><img class="logo" src="${SITE}logo.png" alt=""><h1>Not connected</h1><p class="sub">Google said: ${esc(url.searchParams.get('error') || 'no answer')}. Go back to the app and tap Reconnect Google again.</p></div>`), 400);
      if (!(await env.BOOTH.get('state:' + state))) return html(shell('Link expired', `<div class="hero"><h1>This link expired</h1><p class="sub">Go back to the app and tap Reconnect Google again.</p></div>`), 400);
      await env.BOOTH.delete('state:' + state);
      const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ code, client_id: env.CLIENT_ID, client_secret: env.CLIENT_SECRET, redirect_uri: redirect, grant_type: 'authorization_code' }) });
      const j = await r.json();
      if (!j.refresh_token) return html(shell('Not connected', `<div class="hero"><h1>Not connected</h1><p class="sub">Google did not give a login (${esc(j.error || 'unknown')}). Try Reconnect Google again.</p></div>`), 400);
      await env.BOOTH.put('refresh_token', j.refresh_token); await env.BOOTH.put('connected_at', String(Date.now()));
      cache = { token: j.access_token || '', exp: j.access_token ? Date.now() + j.expires_in * 1000 : 0 };
      return html(shell('Google connected', `<div class="hero"><img class="logo" src="${SITE}logo.png" alt=""><h1>Google <b>connected</b> ✓</h1><p class="sub">You can close this page and go back to the booth app.</p></div>`));
    }
    // the booth asks for a fresh upload key
    if (url.pathname === '/token') {
      if (req.headers.get('X-Booth-Key') !== env.BOOTH_KEY) return new Response('Wrong key', { status: 403, headers: cors });
      const t = await accessToken(env); return Response.json(t, { status: t.access_token ? 200 : 502, headers: cors });
    }
    // is Google still connected?
    if (url.pathname === '/health') {
      if (req.headers.get('X-Booth-Key') !== env.BOOTH_KEY) return new Response('Wrong key', { status: 403, headers: cors });
      const t = await accessToken(env), at = env.BOOTH ? +(await env.BOOTH.get('connected_at')) || 0 : 0;
      return Response.json({ ok: !!t.access_token, error: t.error || '', connectedAt: at, pages: true }, { headers: cors });
    }
    try {
      let m = url.pathname.match(/^\/v\/([\w-]{10,})\/?$/); if (m) return await videoPage(env, m[1], url.origin);
      m = url.pathname.match(/^\/f\/([\w-]{10,})$/); if (m) return await stream(env, m[1], req, url.searchParams.has('dl'));
    } catch (e) {
      if (e.status === 404 || e.status === 403) return notFound();
      return html(shell('Try again soon', `<div class="hero"><img class="logo" src="${SITE}logo.png" alt=""><h1>One moment…</h1><p class="sub">The video can't be loaded right now. Please try again in a few minutes.</p></div>`), 503);
    }
    return new Response('Party Machines helper is running.', { headers: cors });
  },
};

// Party Machines Booth — helper (Cloudflare Worker, free plan).
// 1. Keeps your Google "refresh token" so the booth never asks you to sign in again.
// 2. Shows guests a Party Machines page for their video (instead of a plain Google Drive folder), and streams the video from your Drive.
// Variables in Cloudflare: CLIENT_ID, CLIENT_SECRET, BOOTH_KEY. The Google login is kept in the BOOTH storage (KV);
// REFRESH_TOKEN is only the old fallback. To reconnect Google open  https://<this-worker>/auth?key=BOOTH_KEY  and approve.
// 3. "Party Machines Cloud": a booth only needs a booth code (stored in KV as code:<CODE>) to upload — no Google setup on the phone.
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

/* ---------- Party Machines Cloud: booths upload with just a booth code ---------- */
async function gjson(env, path, method = 'GET', body) {
  const t = await accessToken(env); if (!t.access_token) throw Object.assign(new Error('google'), { status: 503, google: true });
  const r = await fetch(DRIVE + path, { method, headers: { Authorization: 'Bearer ' + t.access_token, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) throw Object.assign(new Error('drive ' + r.status), { status: r.status });
  return r.json();
}
const folderOf = async (env, name, parent) => (await gjson(env, 'files?fields=id', 'POST', { name, mimeType: 'application/vnd.google-apps.folder', ...(parent ? { parents: [parent] } : {}) })).id;
const makePublic = (env, id) => gjson(env, `files/${id}/permissions`, 'POST', { role: 'reader', type: 'anyone' });
async function own(env, code, id) { if (id) await env.BOOTH.put('owner:' + id, code); return id; }
async function exists(env, id) { try { const f = await gjson(env, `files/${id}?fields=id,trashed`); return !f.trashed; } catch (e) { if (e.status === 404) return false; throw e; } }
async function clientFolder(env, code, c) {
  let root = await env.BOOTH.get('root');
  if (!root || !(await exists(env, root))) { root = await folderOf(env, 'Party Machines 360 Cloud'); await env.BOOTH.put('root', root); }
  if (!c.folder || !(await exists(env, c.folder))) { c.folder = await own(env, code, await folderOf(env, c.name || code, root)); await env.BOOTH.put('code:' + code, JSON.stringify(c)); }
  return c.folder;
}
async function cloudApi(env, path, req, base) {
  const body = req.method === 'POST' ? await req.json().catch(() => ({})) : Object.fromEntries(new URL(req.url).searchParams);
  const code = String(body.code || '').trim().toUpperCase(), raw = code && await env.BOOTH.get('code:' + code);
  if (!raw) return { status: 403, json: { error: 'bad_code', message: 'That booth code is not valid.' } };
  const c = JSON.parse(raw); if (c.active === false) return { status: 403, json: { error: 'inactive', message: 'This booth code is switched off. Contact Party Machines.' } };
  const mine = async id => id && (await env.BOOTH.get('owner:' + id)) === code;
  if (path === 'health') { const t = await accessToken(env); return { json: { ok: !!t.access_token, name: c.name || '', error: t.access_token ? '' : 'google' } }; }
  if (path === 'event') {                                  // one folder per event; its description feeds the guest page
    const key = `ev:${code}:${body.eventId}`, rec = JSON.parse((await env.BOOTH.get(key)) || '{}');
    if (!rec.folder || !(await exists(env, rec.folder))) { rec.folder = await own(env, code, await folderOf(env, String(body.folderName || body.name || 'Event').slice(0, 100), await clientFolder(env, code, c))); rec.desc = ''; }
    const desc = JSON.stringify({ name: body.name || '', social: body.social || '', msg: body.msg || '' });
    if (rec.desc !== desc) { await gjson(env, `files/${rec.folder}`, 'PATCH', { description: desc }); rec.desc = desc; }
    await env.BOOTH.put(key, JSON.stringify(rec));
    return { json: { folder: rec.folder, url: `${base}/v/${rec.folder}` } };
  }
  if (path === 'clip') {                                   // a shared folder for one guest's video(s)
    if (!(await mine(body.eventFolder))) return { status: 403, json: { error: 'not_yours' } };
    const folder = await own(env, code, await folderOf(env, String(body.label || 'Video').slice(0, 100), body.eventFolder));
    await makePublic(env, folder);
    return { json: { folder, url: `${base}/v/${folder}` } };
  }
  if (path === 'share') {                                  // the event gallery
    if (!(await mine(body.folder))) return { status: 403, json: { error: 'not_yours' } };
    await makePublic(env, body.folder); return { json: { url: `${base}/v/${body.folder}` } };
  }
  if (path === 'short') {                                 // a short, typeable link for the TV and the laptop
    if (!(await mine(body.folder))) return { status: 403, json: { error: 'not_yours' } };
    await makePublic(env, body.folder);
    let sh = await env.BOOTH.get('sf:' + body.folder);
    if (!sh) { const A = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; do { sh = Array.from(crypto.getRandomValues(new Uint8Array(6)), b => A[b % A.length]).join(''); } while (await env.BOOTH.get('s:' + sh)); await env.BOOTH.put('s:' + sh, body.folder); await env.BOOTH.put('sf:' + body.folder, sh); }
    return { json: { short: sh, tv: `${base}/tv/${sh}`, live: `${base}/live/${sh}`, gallery: `${base}/v/${body.folder}` } };
  }
  if (path === 'backups') {                                // private, never shared
    let id = await env.BOOTH.get('bk:' + code);
    if (!id || !(await exists(env, id))) { id = await own(env, code, await folderOf(env, 'Backups (private)', await clientFolder(env, code, c))); await env.BOOTH.put('bk:' + code, id); }
    return { json: { folder: id } };
  }
  if (path === 'upload') {                                 // start an upload; the phone sends the file straight to Google
    if (!(await mine(body.folder))) return { status: 403, json: { error: 'not_yours' } };
    const t = await accessToken(env); if (!t.access_token) throw Object.assign(new Error('google'), { status: 503, google: true });
    const r = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id', { method: 'POST',
      headers: { Authorization: 'Bearer ' + t.access_token, 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': body.type || 'video/mp4', ...(body.size ? { 'X-Upload-Content-Length': String(body.size) } : {}), Origin: req.headers.get('Origin') || ALLOWED[0] },
      body: JSON.stringify({ name: String(body.name || 'video.mp4').slice(0, 200), parents: [body.folder] }) });
    if (!r.ok) return { status: 502, json: { error: 'drive_' + r.status } };
    return { json: { url: r.headers.get('Location') } };
  }
  return { status: 404, json: { error: 'unknown' } };
}

/* ---------- every video of an event, newest first (for the TV and the laptop) ---------- */
async function resolveId(env, x) { return x.length < 12 ? await env.BOOTH.get('s:' + x.toUpperCase()) : x; }
async function eventList(env, id, base) {
  const f = await drive(env, `files/${id}?fields=id,name,mimeType,description`);
  if (f.mimeType !== 'application/vnd.google-apps.folder' || !(await isPublic(env, id))) return null;
  const subs = (await drive(env, `files?q=${encodeURIComponent(`'${id}' in parents and trashed=false and mimeType='application/vnd.google-apps.folder'`)}&fields=files(id,name,createdTime)&orderBy=createdTime desc&pageSize=1000`)).files;
  const clips = [];
  for (let i = 0; i < subs.length; i += 40) {
    const part = subs.slice(i, i + 40), q = '(' + part.map(s => `'${s.id}' in parents`).join(' or ') + ') and trashed=false';
    const files = (await drive(env, `files?q=${encodeURIComponent(q)}&fields=files(id,name,mimeType,parents)&pageSize=1000`)).files;
    for (const s of part) {
      const fs = files.filter(x => x.parents && x.parents[0] === s.id), vid = x => x.mimeType.startsWith('video');
      const main = fs.find(x => vid(x) && /template/.test(x.name)) || fs.find(x => vid(x) && !/_plain/.test(x.name)), plain = fs.find(x => vid(x) && /_plain/.test(x.name)), thumb = fs.find(x => x.mimeType.startsWith('image'));
      if (main || plain) clips.push({ id: s.id, when: s.createdTime, page: `${base}/v/${s.id}`, main: main && `${base}/f/${main.id}`, plain: plain && `${base}/f/${plain.id}`, thumb: thumb && `${base}/f/${thumb.id}`, dl: (main || plain) && `${base}/f/${(main || plain).id}?dl=1` });
    }
  }
  return { ...JSON.parse(f.description || '{}'), folder: id, gallery: `${base}/v/${id}`, clips };
}
const QRJS = `<script src="${SITE}qr.js"></script><script>function drawQR(cv,url,px){const q=qrcode(0,'M');q.addData(url);q.make();const n=q.getModuleCount(),z=4,s=(n+z*2)*px;cv.width=cv.height=s;const g=cv.getContext('2d');g.fillStyle='#fff';g.fillRect(0,0,s,s);g.fillStyle='#000';for(let r=0;r<n;r++)for(let c=0;c<n;c++)if(q.isDark(r,c))g.fillRect((c+z)*px,(r+z)*px,px,px);}</script>`;

/* TV: plays every video full screen, newest first; new videos jump the queue */
function tvPage(x) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Party Machines 360 · Live</title><link rel="icon" href="${SITE}icon-192.png">
<style>html,body{margin:0;height:100%;background:#000;color:#fff;font:16px -apple-system,Segoe UI,Roboto,sans-serif;overflow:hidden;cursor:none}
video{position:fixed;inset:0;width:100%;height:100%;object-fit:contain;background:#000;transition:opacity .5s}
#bg{position:fixed;inset:-40px;background-size:cover;background-position:center;filter:blur(40px) brightness(.45);transform:scale(1.1)}
#brand{position:fixed;left:3vmin;top:3vmin;display:flex;align-items:center;gap:1.6vmin;background:rgba(5,11,31,.55);padding:1.2vmin 2vmin 1.2vmin 1.2vmin;border-radius:99px;backdrop-filter:blur(8px)}
#brand img{width:7vmin;height:7vmin;border-radius:50%}#brand b{font-size:3vmin}#brand span{display:block;font-size:2vmin;color:#ffd21f}
#qr{position:fixed;right:3vmin;bottom:3vmin;background:rgba(5,11,31,.7);padding:1.6vmin;border-radius:2.4vmin;text-align:center;backdrop-filter:blur(8px)}
#qr canvas{width:17vmin;height:17vmin;border-radius:1.2vmin;display:block}#qr div{font-size:1.9vmin;margin-top:1vmin;font-weight:700}
#new{position:fixed;left:50%;top:4vmin;transform:translateX(-50%);background:#ffd21f;color:#1a1400;font-weight:900;font-size:3vmin;padding:1vmin 3vmin;border-radius:99px;display:none}
#wait{position:fixed;inset:0;display:grid;place-items:center;text-align:center;font-size:4vmin}#wait img{width:30vmin;border-radius:50%;margin-bottom:3vmin}
#tip{position:fixed;bottom:3vmin;left:3vmin;font-size:1.8vmin;color:#9fb0d8;transition:opacity 1s}</style></head><body>
<div id="bg"></div><video id="v" muted playsinline autoplay></video>
<div id="wait"><div><img src="${SITE}logo.png" alt=""><div id="wt">Waiting for the first video…</div></div></div>
<div id="brand"><img src="${SITE}icon-192.png" alt=""><div><b id="ev">Party Machines 360°</b><span id="so"></span></div></div>
<div id="new">NEW VIDEO</div>
<div id="qr"><canvas id="qc"></canvas><div>Scan for your video</div></div>
<div id="tip">Click anywhere for full screen</div>
${QRJS}<script>
const X=${JSON.stringify(x)};let list=[],seen=new Set(),queue=[],idx=0,first=true;const v=document.getElementById('v');
async function poll(){try{const j=await (await fetch('/api/live?id='+X,{cache:'no-store'})).json();if(j.error){document.getElementById('wt').textContent='This screen link is not active.';return;}
document.getElementById('ev').textContent=j.name||'Party Machines 360°';document.getElementById('so').textContent=j.social||'';if(first){drawQR(document.getElementById('qc'),j.gallery,6);}
for(const c of j.clips.slice().reverse()){if(!seen.has(c.id)){seen.add(c.id);if(!first)queue.push(c);}}list=j.clips;
if(first){first=false;if(list.length)play();}else if(v.paused&&queue.length)play();}catch(e){}}
function play(){const c=queue.length?queue.shift():list[idx++%Math.max(1,Math.min(list.length,40))];if(!c)return;
document.getElementById('wait').style.display='none';document.getElementById('new').style.display=Date.now()-new Date(c.when)<180000?'block':'none';
document.getElementById('bg').style.backgroundImage=c.thumb?'url('+c.thumb+')':'';v.src=c.main||c.plain;v.play().catch(()=>{});}
v.onended=()=>play();v.onerror=()=>setTimeout(play,1500);
document.body.onclick=()=>{(document.documentElement.requestFullscreen||document.documentElement.webkitRequestFullscreen||function(){}).call(document.documentElement);document.getElementById('tip').style.opacity=0;};
setTimeout(()=>document.getElementById('tip').style.opacity=0,9000);poll();setInterval(poll,8000);
</script></body></html>`;
}

/* laptop share station: every video as it arrives, with QR, WhatsApp, copy and download */
function livePage(x) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Party Machines 360 · Share station</title><link rel="icon" href="${SITE}icon-192.png">
<style>:root{--bg:#071233;--panel:#0f1f4d;--panel2:#14275e;--line:#22356f;--text:#f3f6ff;--mut:#9fb0d8;--accent:#ffd21f;--ink:#1a1400;--blue:#2f7bff}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.4 -apple-system,Segoe UI,Roboto,sans-serif}
header{position:sticky;top:0;z-index:2;display:flex;align-items:center;gap:14px;padding:14px 20px;background:rgba(7,18,51,.92);backdrop-filter:blur(10px);border-bottom:1px solid var(--line);flex-wrap:wrap}
header img{width:44px;height:44px;border-radius:50%}header h1{font-size:20px;margin:0}header .sub{color:var(--mut);font-size:13px}.grow{flex:1;min-width:160px}
.btn{border:1px solid var(--line);background:var(--panel2);color:var(--text);border-radius:12px;padding:10px 14px;font:inherit;font-weight:700;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;gap:6px;justify-content:center}
.btn.y{background:var(--accent);color:var(--ink);border-color:transparent}.btn.g{background:#25d366;color:#05210f;border-color:transparent}
main{display:grid;grid-template-columns:1fr minmax(320px,420px);gap:20px;padding:20px}@media(max-width:860px){main{grid-template-columns:1fr}}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:12px;align-content:start}
.tile{position:relative;aspect-ratio:3/4;border-radius:14px;overflow:hidden;background:var(--panel);border:2px solid var(--line);cursor:pointer;padding:0}
.tile.on{border-color:var(--accent)}.tile img{width:100%;height:100%;object-fit:cover;display:block}
.tile span{position:absolute;left:6px;bottom:6px;background:rgba(0,0,0,.65);color:#fff;border-radius:99px;padding:2px 9px;font-size:12px}
.tile em{position:absolute;right:6px;top:6px;background:var(--accent);color:var(--ink);font-style:normal;font-weight:900;font-size:11px;border-radius:99px;padding:2px 8px}
.tile.sent::after{content:'✓ shared';position:absolute;left:6px;top:6px;background:#25d366;color:#05210f;font-weight:800;font-size:11px;border-radius:99px;padding:2px 8px}
aside{background:var(--panel);border:1px solid var(--line);border-radius:20px;padding:16px;display:flex;flex-direction:column;gap:12px;position:sticky;top:90px;align-self:start}
aside video{width:100%;max-height:46vh;border-radius:12px;background:#000}
.qrrow{display:flex;gap:14px;align-items:center}.qrrow canvas{width:150px;height:150px;border-radius:10px;flex:0 0 auto}
input{width:100%;padding:12px;border-radius:12px;border:1px solid var(--line);background:var(--panel2);color:var(--text);font:inherit;font-size:18px}
.row{display:flex;gap:8px;flex-wrap:wrap}.row>*{flex:1}.mut{color:var(--mut);font-size:13px}.empty{color:var(--mut);padding:40px;text-align:center}
#toast{position:fixed;left:50%;bottom:20px;transform:translateX(-50%);background:var(--accent);color:var(--ink);font-weight:800;padding:10px 18px;border-radius:99px;display:none}
.tabs{display:flex;gap:6px}.tabs button{flex:1}.tabs button.on{background:var(--blue);border-color:var(--blue)}</style></head><body>
<header><img src="${SITE}icon-192.png" alt=""><div class="grow"><h1 id="ev">Share station</h1><div class="sub" id="cnt">Loading…</div></div>
<a class="btn" id="tvlink" target="_blank">📺 Open TV screen</a><button class="btn y" id="galbtn">Gallery QR (all videos)</button></header>
<main><div class="grid" id="grid"><div class="empty">Waiting for the first video… New videos appear here by themselves.</div></div>
<aside id="side"><div class="mut">Click a video to share it.</div></aside></main><div id="toast"></div>
${QRJS}<script>
const X=${JSON.stringify(x)};let D=null,sel=null,seen=new Set(),first=true;const sent=new Set(JSON.parse(localStorage.getItem('sent:'+X)||'[]'));
const $=s=>document.querySelector(s),toast=t=>{const e=$('#toast');e.textContent=t;e.style.display='block';clearTimeout(toast.t);toast.t=setTimeout(()=>e.style.display='none',2600);};
const tm=w=>new Date(w).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
$('#tvlink').href='/tv/'+X;
async function poll(){try{const j=await (await fetch('/api/live?id='+X,{cache:'no-store'})).json();if(j.error){$('#cnt').textContent='This link is not active.';return;}D=j;
$('#ev').textContent=j.name||'Share station';document.title=(j.name||'Event')+' · Share station';$('#cnt').textContent=j.clips.length+' video'+(j.clips.length===1?'':'s')+' · updates by itself';
let fresh=0;for(const c of j.clips)if(!seen.has(c.id)){seen.add(c.id);if(!first)fresh++;}if(fresh)toast(fresh+' new video'+(fresh>1?'s':''));first=false;draw();if(!sel&&j.clips[0])pick(j.clips[0].id);}catch(e){$('#cnt').textContent='Reconnecting…';}}
function draw(){if(!D.clips.length)return;$('#grid').innerHTML=D.clips.map((c,i)=>'<button class="tile'+(c.id===sel?' on':'')+(sent.has(c.id)?' sent':'')+'" data-id="'+c.id+'">'+(c.thumb?'<img src="'+c.thumb+'" loading="lazy" alt="">':'')+(Date.now()-new Date(c.when)<300000?'<em>NEW</em>':'')+'<span>#'+(D.clips.length-i)+' · '+tm(c.when)+'</span></button>').join('');
document.querySelectorAll('.tile').forEach(t=>t.onclick=()=>pick(t.dataset.id));}
function pick(id){sel=id;const c=D.clips.find(x=>x.id===id);if(!c)return;draw();const n=D.clips.length-D.clips.indexOf(c);
$('#side').innerHTML='<b>Video #'+n+' · '+tm(c.when)+'</b>'+(c.main&&c.plain?'<div class="tabs"><button class="btn on" data-v="main">With design</button><button class="btn" data-v="plain">Original</button></div>':'')+
'<video id="sv" controls autoplay muted loop playsinline src="'+(c.main||c.plain)+'"></video><div class="qrrow"><canvas id="sq"></canvas><div class="mut">Guest scans this with their phone camera to get the video.</div></div>'+
'<input id="wn" type="tel" placeholder="WhatsApp number, e.g. 082 123 4567"><div class="row"><button class="btn g" id="ws">Send on WhatsApp</button></div>'+
'<div class="row"><button class="btn" id="cp">Copy link</button><a class="btn" href="'+c.dl+'">Download</a><a class="btn" href="'+c.page+'" target="_blank">Open page</a></div>';
drawQR($('#sq'),c.page,5);document.querySelectorAll('.tabs button').forEach(b=>b.onclick=()=>{document.querySelectorAll('.tabs button').forEach(x=>x.classList.toggle('on',x===b));$('#sv').src=c[b.dataset.v];});
$('#cp').onclick=async()=>{try{await navigator.clipboard.writeText(c.page);toast('Link copied');mark(c.id);}catch(e){prompt('Copy the link',c.page);}};
$('#ws').onclick=()=>{let d=$('#wn').value.replace(/\\D/g,'');if(d.startsWith('00'))d=d.slice(2);if(/^0\\d{9}$/.test(d))d='27'+d.slice(1);
const txt='Here is your 360° video'+(D.name?' from '+D.name:'')+'! 🎉\\n'+c.page+(D.social?'\\n'+D.social:'');window.open('https://wa.me/'+(d.length>=10?d:'')+'?text='+encodeURIComponent(txt),'_blank');mark(c.id);$('#wn').value='';};
$('#wn').onkeydown=e=>{if(e.key==='Enter')$('#ws').click();};}
function mark(id){sent.add(id);localStorage.setItem('sent:'+X,JSON.stringify([...sent]));draw();}
$('#galbtn').onclick=()=>{if(!D)return;$('#side').innerHTML='<b>Gallery — all videos</b><canvas id="gq" style="width:100%;max-width:340px;align-self:center;border-radius:12px"></canvas><div class="mut" style="text-align:center">Put this on a table or the TV. It opens every video of the event.</div><a class="btn" href="'+D.gallery+'" target="_blank">Open gallery</a>';drawQR($('#gq'),D.gallery,8);sel=null;draw();};
poll();setInterval(poll,6000);
</script></body></html>`;
}

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
  const head = `<div class="hero"><img class="logo" src="${SITE}logo.png" alt="Party Machines 360"><h1>${single ? 'Your <b>360°</b> video' : `<b>${clips.length}</b> video${clips.length === 1 ? '' : 's'} from the 360° booth`}</h1>${name}${ev.msg && single ? `<p class="sub">${esc(ev.msg)}</p>` : ''}</div>`;
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
    const cors = { 'Access-Control-Allow-Origin': okOrigin ? origin : ALLOWED[0], 'Access-Control-Allow-Headers': 'X-Booth-Key, Content-Type', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Vary': 'Origin' };
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
    const api = url.pathname.match(/^\/api\/(\w+)$/);
    if (api && api[1] !== 'live') {
      try { const r = await cloudApi(env, api[1], req, url.origin); return Response.json(r.json, { status: r.status || 200, headers: cors }); }
      catch (e) { return Response.json({ error: e.google ? 'google' : 'drive', message: e.google ? 'Party Machines Cloud is reconnecting to Google. Try again in a few minutes.' : 'Google Drive had a problem (' + (e.status || e.message) + '). Try again.' }, { status: 503, headers: cors }); }
    }
    if (url.pathname === '/api/live') {                    // public list for the TV and laptop pages (only shared event folders)
      try { const id = await resolveId(env, url.searchParams.get('id') || ''); const j = id && await eventList(env, id, url.origin); return Response.json(j || { error: 'not_found' }, { status: j ? 200 : 404, headers: { 'Cache-Control': 'no-store' } }); }
      catch (e) { return Response.json({ error: 'busy' }, { status: 503 }); }
    }
    let lv = url.pathname.match(/^\/(tv|live)\/([\w-]{6,})\/?$/);
    if (lv) return html(lv[1] === 'tv' ? tvPage(lv[2]) : livePage(lv[2]));
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

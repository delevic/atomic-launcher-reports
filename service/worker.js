// Atomic Reports service v1. Paste this entire file into Cloudflare worker.js.
// D1 binding: DB. Secrets: GITHUB_CLIENT_SECRET, GITHUB_REPORT_TOKEN.
// Variable: GITHUB_CLIENT_ID. Optional: ALLOWED_GITHUB_USERS (default delevic).
// All credentials belong in Cloudflare settings, never in this source or APK.
const ORIGIN = 'https://atomic-reports.djdelevic.workers.dev';
const REPO = 'delevic/atomic-launcher-reports';
const API = 'https://api.github.com';
const REPO_API = `${API}/repos/${REPO}`;
const MAX_ZIP = 50 * 1024 * 1024;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const REPORT_ID = /^[a-f0-9]{32}$/;
const initialized = new WeakSet();
const enc = new TextEncoder();
const now = () => Math.floor(Date.now() / 1000);
const base64url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const random = () => base64url(crypto.getRandomValues(new Uint8Array(32)));
const sha = async value => base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(value))));
const query = (db, sql, ...args) => db.prepare(sql).bind(...args);
const one = (db, sql, ...args) => query(db, sql, ...args).first();
const run = (db, sql, ...args) => query(db, sql, ...args).run();

class Failure extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}
function requireThat(condition, status, code) { if (!condition) throw new Failure(status, code); }
function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: {
    'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
    ...(status === 429 ? {'Retry-After': '60'} : {})
  }});
}
function page(text, cookie) {
  return new Response(`<!doctype html><html lang="sr"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Atomic Reports</title><body><h1>Atomic Reports</h1><p>${text}</p></body></html>`, {
    headers: {'Content-Type':'text/html; charset=utf-8', 'Cache-Control':'no-store',
      'Content-Security-Policy':"default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
      'Referrer-Policy':'no-referrer', 'X-Content-Type-Options':'nosniff',
      ...(cookie ? {'Set-Cookie':cookie} : {})}
  });
}
async function readJSON(request) {
  requireThat(request.headers.get('Content-Type')?.split(';')[0] === 'application/json', 415, 'json_required');
  requireThat(!request.headers.get('Content-Encoding'), 415, 'encoding_not_supported');
  const reader = request.body?.getReader();
  requireThat(reader, 400, 'body_required');
  const chunks = []; let size = 0;
  while (true) {
    const {done, value} = await reader.read(); if (done) break;
    size += value.length;
    if (size > 16384) { await reader.cancel(); throw new Failure(413, 'metadata_too_large'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const part of chunks) { bytes.set(part, offset); offset += part.length; }
  try { const data = JSON.parse(new TextDecoder('utf-8', {fatal:true}).decode(bytes));
    requireThat(data && typeof data === 'object' && !Array.isArray(data), 400, 'invalid_json'); return data;
  } catch { throw new Failure(400, 'invalid_json'); }
}
async function init(db) {
  if (!initialized.has(db)) {
    const statements = [
      `CREATE TABLE IF NOT EXISTS ar_auth (id TEXT PRIMARY KEY, challenge TEXT NOT NULL, status TEXT NOT NULL, cookie_hash TEXT, code TEXT, session_hash TEXT, expires INTEGER NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS ar_sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL, login TEXT NOT NULL, expires INTEGER NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS ar_rates (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires INTEGER NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS ar_reports (id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, login TEXT NOT NULL, client_id TEXT NOT NULL, metadata TEXT NOT NULL, meta_hash TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL, status TEXT NOT NULL, created INTEGER NOT NULL, release_id INTEGER, asset_id INTEGER, asset_url TEXT, issue_number INTEGER, issue_url TEXT, lease TEXT, lease_until INTEGER NOT NULL DEFAULT 0, UNIQUE(user_id, client_id))`,
      `CREATE INDEX IF NOT EXISTS ar_auth_expiry ON ar_auth(expires)`,
      `CREATE INDEX IF NOT EXISTS ar_sessions_expiry ON ar_sessions(expires)`,
      `CREATE INDEX IF NOT EXISTS ar_rates_expiry ON ar_rates(expires)`
    ];
    // Do not share pending I/O promises between Cloudflare request contexts.
    await db.batch(statements.map(sql => db.prepare(sql)));
    initialized.add(db);
  }
}
async function limit(db, key, maximum, seconds) {
  const bucket = Math.floor(now() / seconds);
  const row = await one(db, `INSERT INTO ar_rates(key,count,expires) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1 WHERE count<? RETURNING count`, `${key}:${bucket}`, (bucket+2)*seconds, maximum);
  requireThat(row, 429, 'rate_limited');
}
function allowed(env, login) {
  const users = (env.ALLOWED_GITHUB_USERS || 'delevic').toLowerCase().split(',').map(x => x.trim());
  return users.includes('*') || users.includes(login.toLowerCase());
}
function ghHeaders(token) { return {'Authorization':`Bearer ${token}`, 'Accept':'application/vnd.github+json', 'X-GitHub-Api-Version':'2022-11-28', 'User-Agent':'Atomic-Reports/1'}; }
async function github(env, path, method = 'GET', body) {
  const response = await fetch(REPO_API + path, {method, redirect:'error',
    headers:{...ghHeaders(env.GITHUB_REPORT_TOKEN), ...(body === undefined ? {} : {'Content-Type':'application/json'})},
    body:body === undefined ? undefined : JSON.stringify(body), signal:AbortSignal.timeout(30000)});
  const text = await response.text();
  let data; try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  return {status:response.status, data};
}
function ghOK(result) { requireThat(result.status >= 200 && result.status < 300 && result.data, 502, 'github_unavailable'); return result.data; }
async function session(request, env) {
  const token = request.headers.get('Authorization')?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
  requireThat(token, 401, 'sign_in_required');
  const tokenHash = await sha(token);
  const row = await one(env.DB, 'SELECT * FROM ar_sessions WHERE token_hash=? AND expires>?', tokenHash, now());
  requireThat(row, 401, 'sign_in_required');
  requireThat(allowed(env, row.login), 403, 'tester_not_enabled');
  await limit(env.DB, `api:${row.user_id}`, 120, 60);
  return {...row, tokenHash};
}
async function authStart(request, env) {
  const data = await readJSON(request);
  requireThat(TOKEN.test(data.challenge || ''), 400, 'invalid_challenge');
  const ip = await sha(request.headers.get('CF-Connecting-IP') || 'unknown');
  await limit(env.DB, `login:${ip}`, 10, 600);
  await limit(env.DB, 'logins', 200, 3600);
  await env.DB.batch(['ar_auth', 'ar_sessions', 'ar_rates'].map(table => query(env.DB, `DELETE FROM ${table} WHERE expires<?`, now())));
  const id = random();
  await run(env.DB, 'INSERT INTO ar_auth(id,challenge,status,expires) VALUES(?,?,?,?)', await sha(id), data.challenge, 'new', now()+600);
  return json({login_id:id, authorization_url:`${ORIGIN}/auth/github?id=${id}`, expires_in:600, interval:5});
}
async function authOpen(url, env) {
  const id = url.searchParams.get('id'); requireThat(TOKEN.test(id || ''), 400, 'invalid_login');
  const cookie = random();
  const row = await one(env.DB, `UPDATE ar_auth SET status='authorizing',cookie_hash=? WHERE id=? AND status='new' AND expires>? RETURNING challenge`, await sha(cookie), await sha(id), now());
  requireThat(row, 410, 'restart_sign_in');
  const target = new URL('https://github.com/login/oauth/authorize');
  target.search = new URLSearchParams({client_id:env.GITHUB_CLIENT_ID, redirect_uri:`${ORIGIN}/auth/callback`, state:id,
    scope:'', code_challenge:row.challenge, code_challenge_method:'S256'}).toString();
  return new Response(null, {status:302, headers:{Location:target.toString(), 'Cache-Control':'no-store', 'Referrer-Policy':'no-referrer',
    'Set-Cookie':`__Host-atomic-login=${cookie}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=600`}});
}
async function authCallback(request, url, env) {
  const id = url.searchParams.get('state'); const code = url.searchParams.get('code');
  const cookie = request.headers.get('Cookie')?.split(';').map(x => x.trim()).find(x => x.startsWith('__Host-atomic-login='))?.split('=')[1];
  requireThat(TOKEN.test(id || '') && TOKEN.test(cookie || ''), 400, 'invalid_login_state');
  const denied = !!url.searchParams.get('error');
  requireThat(denied || /^[A-Za-z0-9_-]{1,200}$/.test(code || ''), 400, 'invalid_oauth_code');
  const row = await one(env.DB, `UPDATE ar_auth SET status=?,code=?,cookie_hash=NULL WHERE id=? AND cookie_hash=? AND status='authorizing' AND expires>? RETURNING id`,
    denied ? 'denied' : 'authorized', denied ? null : code, await sha(id), await sha(cookie), now());
  requireThat(row, 400, 'invalid_login_state');
  return page(denied ? 'Prijava je otkazana. Vratite se u Atomic Launcher.' : 'GitHub autorizacija je završena. Vratite se u Atomic Launcher da se prijava dovrši i report pošalje.',
    '__Host-atomic-login=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0');
}
async function authToken(request, env) {
  const data = await readJSON(request);
  requireThat(TOKEN.test(data.login_id || '') && /^[A-Za-z0-9._~-]{43,128}$/.test(data.verifier || '') && TOKEN.test(data.session_token || ''), 400, 'invalid_login');
  const id = await sha(data.login_id); const tokenHash = await sha(data.session_token);
  let row = await one(env.DB, 'SELECT * FROM ar_auth WHERE id=? AND expires>?', id, now());
  requireThat(row && row.challenge === await sha(data.verifier), 400, 'invalid_login');
  await limit(env.DB, `poll:${id}`, 15, 60);
  if (row.status === 'done') {
    requireThat(row.session_hash === tokenHash, 409, 'session_mismatch');
    const existing = await one(env.DB, 'SELECT login,expires FROM ar_sessions WHERE token_hash=? AND expires>?', tokenHash, now());
    requireThat(existing, 410, 'restart_sign_in');
    return json({status:'authorized', ...existing});
  }
  requireThat(!['denied','failed'].includes(row.status), 403, 'restart_sign_in');
  if (row.status !== 'authorized') return json({status:'pending', interval:5}, 202);
  row = await one(env.DB, `UPDATE ar_auth SET status='exchanging' WHERE id=? AND status='authorized' RETURNING code`, id);
  if (!row) return json({status:'pending', interval:5}, 202);
  try {
    const response = await fetch('https://github.com/login/oauth/access_token', {method:'POST', redirect:'error', signal:AbortSignal.timeout(30000),
      headers:{'Accept':'application/json','Content-Type':'application/x-www-form-urlencoded','User-Agent':'Atomic-Reports/1'},
      body:new URLSearchParams({client_id:env.GITHUB_CLIENT_ID, client_secret:env.GITHUB_CLIENT_SECRET, code:row.code, redirect_uri:`${ORIGIN}/auth/callback`, code_verifier:data.verifier})});
    const access = await response.json();
    requireThat(response.ok && typeof access.access_token === 'string' && !access.error, 502, 'github_sign_in_failed');
    const userResponse = await fetch(`${API}/user`, {headers:ghHeaders(access.access_token), redirect:'error', signal:AbortSignal.timeout(30000)});
    const user = await userResponse.json();
    requireThat(userResponse.ok && Number.isSafeInteger(user.id) && user.id > 0 && /^[A-Za-z0-9-]{1,39}$/.test(user.login), 502, 'github_sign_in_failed');
    requireThat(allowed(env, user.login), 403, 'tester_not_enabled');
    const expires = now()+30*86400;
    await env.DB.batch([
      query(env.DB, 'INSERT INTO ar_sessions(token_hash,user_id,login,expires) VALUES(?,?,?,?)', tokenHash, user.id, user.login, expires),
      query(env.DB, `UPDATE ar_auth SET status='done',code=NULL,session_hash=? WHERE id=?`, tokenHash, id)
    ]);
    return json({status:'authorized', login:user.login, expires});
  } catch (error) {
    await run(env.DB, `UPDATE ar_auth SET status='failed',code=NULL WHERE id=? AND status='exchanging'`, id);
    throw error;
  }
}
function clean(value, max, required = true) {
  requireThat(typeof value === 'string' && value.length <= max && (!required || value.trim().length > 0), 400, 'invalid_metadata');
  return value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
}
function metadata(data) {
  requireThat(REPORT_ID.test(data.client_report_id || '') && data.public_upload_consent === true, 400, 'report_id_and_consent_required');
  requireThat(Number.isSafeInteger(data.size) && data.size >= 22 && data.size <= MAX_ZIP, 413, 'invalid_zip_size');
  requireThat(/^[a-f0-9]{64}$/.test(data.sha256 || ''), 400, 'zip_sha256_required');
  return {client_report_id:data.client_report_id, name:clean(data.name,200), description:clean(data.description,8000,false),
    build:clean(data.build,80), device:clean(data.device,240), size:data.size, sha256:data.sha256, public_upload_consent:true};
}
function result(row) {
  return {report_id:row.id, status:row.status, ...(row.asset_url ? {attachment_url:row.asset_url} : {}),
    ...(row.status === 'sent' ? {issue_number:row.issue_number, issue_url:row.issue_url} : {})};
}
async function prepareReport(request, env, user) {
  const meta = metadata(await readJSON(request)); const raw = JSON.stringify(meta); const hash = await sha(raw);
  let row = await one(env.DB, 'SELECT * FROM ar_reports WHERE user_id=? AND client_id=?', user.user_id, meta.client_report_id);
  if (row) { requireThat(row.meta_hash === hash, 409, 'report_changed_use_new_id'); return json(result(row)); }
  await limit(env.DB, `new:${user.user_id}`, 3, 60);
  await limit(env.DB, `daily:${user.user_id}`, 20, 86400);
  await limit(env.DB, 'daily_reports', 100, 86400);
  const id = crypto.randomUUID().replace(/-/g, '');
  await run(env.DB, `INSERT OR IGNORE INTO ar_reports(id,user_id,login,client_id,metadata,meta_hash,size,sha256,status,created) VALUES(?,?,?,?,?,?,?,?,?,?)`,
    id, user.user_id, user.login, meta.client_report_id, raw, hash, meta.size, meta.sha256, 'prepared', now());
  row = await one(env.DB, 'SELECT * FROM ar_reports WHERE user_id=? AND client_id=?', user.user_id, meta.client_report_id);
  requireThat(row?.meta_hash === hash, 409, 'report_changed_use_new_id');
  return json(result(row));
}
async function getReport(env, user, id) {
  const row = await one(env.DB, 'SELECT * FROM ar_reports WHERE id=? AND user_id=?', id, user.user_id);
  requireThat(row, 404, 'report_not_found'); return row;
}
async function getRelease(env, row) {
  if (row.release_id) return row.release_id;
  const day = new Date(row.created*1000).toISOString().slice(0,10); const tag = `reports-${day}`;
  let response = await github(env, `/releases/tags/${tag}`);
  if (response.status === 404) {
    response = await github(env, '/releases', 'POST', {tag_name:tag, target_commitish:'main', name:`Diagnostic attachments ${day}`,
      body:'Public diagnostic ZIP files submitted with consent through Atomic Reports. These are report attachments, not an application release.',
      draft:false, prerelease:true, make_latest:'false'});
    if (response.status === 422) response = await github(env, `/releases/tags/${tag}`);
  }
  const release = ghOK(response);
  requireThat(Number.isSafeInteger(release.id) && !release.draft, 502, 'invalid_release');
  await run(env.DB, 'UPDATE ar_reports SET release_id=? WHERE id=?', release.id, row.id);
  return release.id;
}
function assetOK(asset, row) {
  return asset?.state === 'uploaded' && asset.name === `report-${row.id}.zip` && asset.size === row.size && asset.digest === `sha256:${row.sha256}`;
}
async function recordAsset(env, row, asset, lease) {
  requireThat(assetOK(asset,row) && Number.isSafeInteger(asset.id) && typeof asset.browser_download_url === 'string' && asset.browser_download_url.startsWith(`https://github.com/${REPO}/releases/download/`), 502, 'zip_verification_failed');
  await run(env.DB, `UPDATE ar_reports SET status='uploaded',asset_id=?,asset_url=?,lease=NULL,lease_until=0 WHERE id=? AND lease=?`, asset.id, asset.browser_download_url, row.id, lease);
}
async function upload(request, env, user, id) {
  let row = await getReport(env,user,id);
  if (['uploaded','publishing','uncertain','sent'].includes(row.status)) return json(result(row));
  requireThat(request.headers.get('Content-Type')?.split(';')[0] === 'application/zip' && !request.headers.get('Content-Encoding'), 415, 'zip_required');
  requireThat(request.body && request.headers.get('Content-Length') === String(row.size), 400, 'zip_length_mismatch');
  await limit(env.DB, `uploads:${user.user_id}`, 6, 60);
  const lease = random();
  row = await one(env.DB, `UPDATE ar_reports SET status='uploading',lease=?,lease_until=? WHERE id=? AND status IN ('prepared','uploading') AND lease_until<? RETURNING *`, lease, now()+900, id, now());
  requireThat(row, 409, 'upload_in_progress');
  try {
    const release = await getRelease(env,row);
    const assets = ghOK(await github(env, `/releases/${release}/assets?per_page=100`));
    requireThat(Array.isArray(assets),502,'invalid_assets');
    const old = assets.find(asset => asset.name === `report-${row.id}.zip`);
    if (old && assetOK(old,row)) {
      await request.body.cancel(); await recordAsset(env,row,old,lease); return json(result(await getReport(env,user,id)));
    }
    if (old) {
      requireThat(old.state === 'starter' && Number.isSafeInteger(old.id), 409, 'existing_zip_mismatch');
      const deleted = await github(env, `/releases/assets/${old.id}`, 'DELETE');
      requireThat(deleted.status === 204,502,'github_unavailable');
    }
    // A bounded stream avoids buffering a potentially 50 MiB video archive.
    let seen = 0; const magic = [];
    const check = new TransformStream({transform(chunk,controller) {
      seen += chunk.length;
      requireThat(seen <= row.size,400,'zip_length_mismatch');
      for (let i=0; i<chunk.length && magic.length<4; i++) magic.push(chunk[i]);
      if (magic.length === 4) requireThat(magic[0]===80 && magic[1]===75 && ((magic[2]===3 && magic[3]===4)||(magic[2]===5 && magic[3]===6)),400,'invalid_zip');
      controller.enqueue(chunk);
    }, flush() { requireThat(seen===row.size,400,'zip_length_mismatch'); }});
    const fixed = new FixedLengthStream(row.size);
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), 300000);
    const pump = request.body.pipeThrough(check).pipeTo(fixed.writable, {signal:abort.signal});
    // Attach an error handler immediately; never leave a rejected pipe unhandled.
    let pumpError; const pumped = pump.catch(error => {pumpError=error; abort.abort();});
    try {
      const response = await fetch(`https://uploads.github.com/repos/${REPO}/releases/${release}/assets?name=report-${id}.zip`, {
        method:'POST', redirect:'error', headers:{...ghHeaders(env.GITHUB_REPORT_TOKEN),'Content-Type':'application/zip'},
        body:fixed.readable, duplex:'half', signal:abort.signal});
      if (!response.ok) { abort.abort(); await pumped; throw new Failure(502,'zip_upload_failed'); }
      const asset = await response.json(); await pumped; if (pumpError) throw pumpError;
      await recordAsset(env,row,asset,lease);
    } finally { clearTimeout(timeout); abort.abort(); await pumped; }
    return json(result(await getReport(env,user,id)));
  } catch (error) {
    // Keep the lease after failure: a disconnected upstream upload may still finish.
    // A retry after 15 minutes reconciles the unique asset name and SHA-256 first.
    throw error;
  }
}
const marker = id => `<!-- atomic-report:${id} -->`;
function safeText(text) { return text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/@/g,'&#64;'); }
function issueBody(row) {
  const meta = JSON.parse(row.metadata);
  return `${marker(row.id)}\n\nReported by GitHub user **${safeText(row.login)}** (ID ${row.user_id}).\n\nBuild: ${safeText(meta.build)}\n\nDevice: ${safeText(meta.device)}\n\nReport: ${safeText(meta.name)}\n\n${safeText(meta.description)}\n\n[Download diagnostic ZIP](${row.asset_url})\n\nSize: ${row.size} bytes\n\nSHA-256: \`${row.sha256}\`\n\nPublic upload consent was confirmed in the app.`;
}
async function confirmIssue(env, row, issue) {
  requireThat(Number.isSafeInteger(issue?.number) && issue.number>0 && issue.html_url === `https://github.com/${REPO}/issues/${issue.number}` && issue.body?.startsWith(marker(row.id)), 502, 'invalid_issue_confirmation');
  await run(env.DB, `UPDATE ar_reports SET status='sent',issue_number=?,issue_url=?,lease=NULL,lease_until=0 WHERE id=?`, issue.number, issue.html_url, row.id);
}
async function reconcileIssue(env, row) {
  const since = new Date((row.created-60)*1000).toISOString();
  // REST listing, not the eventually indexed GitHub search API.
  for (let p=1; p<=10; p++) {
    const list = ghOK(await github(env, `/issues?state=all&sort=created&direction=desc&since=${encodeURIComponent(since)}&per_page=100&page=${p}`));
    requireThat(Array.isArray(list),502,'github_unavailable');
    const found = list.find(issue => !issue.pull_request && issue.body?.startsWith(marker(row.id)));
    if (found) { await confirmIssue(env,row,found); return true; }
    if (list.length<100) break;
  }
  return false;
}
async function submit(env, user, id) {
  let row = await getReport(env,user,id);
  if (row.status === 'sent') return json(result(row));
  await limit(env.DB, `submit:${id}`, 6, 60);
  if (['publishing','uncertain'].includes(row.status)) {
    if (row.status === 'publishing' && row.lease_until > now()) return json({report_id:id,status:'publishing'},202);
    if (!await reconcileIssue(env,row)) {
      await run(env.DB, `UPDATE ar_reports SET status='uncertain' WHERE id=? AND status!='sent'`, id);
      return json({report_id:id,status:'uncertain',code:'confirmation_pending_do_not_resend'},202);
    }
    return json(result(await getReport(env,user,id)));
  }
  requireThat(row.status === 'uploaded',409,'upload_required');
  // Check the remote file again before creating any issue.
  const asset = ghOK(await github(env, `/releases/assets/${row.asset_id}`));
  requireThat(assetOK(asset,row),502,'zip_verification_failed');
  const lease = random();
  row = await one(env.DB, `UPDATE ar_reports SET status='publishing',lease=?,lease_until=? WHERE id=? AND status='uploaded' RETURNING *`, lease, now()+120, id);
  if (!row) return json({report_id:id,status:'publishing'},202);
  try {
    const meta = JSON.parse(row.metadata);
    const response = await github(env, '/issues', 'POST', {title:`[Bug] ${meta.name.replace(/[\r\n]/g,' ').slice(0,180)}`, body:issueBody(row)});
    if ([400,401,403,404,410,422,429].includes(response.status)) {
      await run(env.DB, `UPDATE ar_reports SET status='uploaded',lease=NULL,lease_until=0 WHERE id=? AND lease=?`, id, lease);
      throw new Failure(502,'github_issue_rejected');
    }
    const issue = ghOK(response); await confirmIssue(env,row,issue);
    return json(result(await getReport(env,user,id)));
  } catch (error) {
    // A timeout/5xx might occur AFTER GitHub creates an issue. Never blindly POST again.
    await run(env.DB, `UPDATE ar_reports SET status='uncertain' WHERE id=? AND status='publishing' AND lease=?`, id, lease);
    throw error;
  }
}
async function route(request,env) {
  const url = new URL(request.url);
  requireThat(url.origin === ORIGIN,400,'invalid_service_origin');
  const missing = ['DB','GITHUB_CLIENT_ID','GITHUB_CLIENT_SECRET','GITHUB_REPORT_TOKEN'].filter(key => !env[key]);
  if (request.method === 'GET' && ['/', '/health'].includes(url.pathname)) return json({service:'Atomic Reports',version:1,configured:missing.length===0,missing,max_zip_bytes:MAX_ZIP,public_repository:`https://github.com/${REPO}`});
  requireThat(missing.length===0,503,'setup_required');
  const origin = request.headers.get('Origin');
  requireThat(!origin || origin === ORIGIN,403,'cross_origin_denied');
  await init(env.DB);
  if (request.method==='POST' && url.pathname==='/v1/auth/start') return authStart(request,env);
  if (request.method==='GET' && url.pathname==='/auth/github') return authOpen(url,env);
  if (request.method==='GET' && url.pathname==='/auth/callback') return authCallback(request,url,env);
  if (request.method==='POST' && url.pathname==='/v1/auth/token') return authToken(request,env);
  const user = await session(request,env);
  if (request.method==='GET' && url.pathname==='/v1/me') return json({login:user.login,expires:user.expires});
  if (request.method==='POST' && url.pathname==='/v1/logout') {
    await run(env.DB,'DELETE FROM ar_sessions WHERE token_hash=?',user.tokenHash); return json({status:'signed_out'});
  }
  if (request.method==='POST' && url.pathname==='/v1/reports') return prepareReport(request,env,user);
  const match = url.pathname.match(/^\/v1\/reports\/([a-f0-9]{32})(?:\/(zip|submit))?$/);
  if (match) {
    if (request.method==='GET' && !match[2]) return json(result(await getReport(env,user,match[1])));
    if (request.method==='PUT' && match[2]==='zip') return upload(request,env,user,match[1]);
    if (request.method==='POST' && match[2]==='submit') return submit(env,user,match[1]);
  }
  throw new Failure(404,'not_found');
}
export default {
  async fetch(request,env) {
    try { return await route(request,env); }
    catch(error) { return json({error:error instanceof Failure ? error.code : 'service_unavailable'},error instanceof Failure ? error.status : 503); }
  }
};

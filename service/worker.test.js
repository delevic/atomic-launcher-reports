import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createHash, randomBytes} from 'node:crypto';
import worker from './worker.js';

// Real SQLite executes the Worker's actual SQL; fetch replaces only GitHub I/O.
// FixedLengthStream below emulates its length contract, not the Cloudflare runtime.
class D1 {
  constructor() { this.db = new DatabaseSync(':memory:'); }
  prepare(sql) {
    const db=this.db; let values=[];
    return {bind(...args) {values=args; return this;},
      async first() {return db.prepare(sql).get(...values) || null;},
      async run() {const result=db.prepare(sql).run(...values); return {success:true,meta:{changes:Number(result.changes)}};}};
  }
  async batch(statements) {
    this.db.exec('BEGIN');
    try {const rows=[]; for (const statement of statements) rows.push(await statement.run()); this.db.exec('COMMIT'); return rows;}
    catch(error) {this.db.exec('ROLLBACK'); throw error;}
  }
}
globalThis.FixedLengthStream = class extends TransformStream {
  constructor(size) {let written=0; super({transform(chunk,c) {written+=chunk.length; if(written>size) throw Error('long'); c.enqueue(chunk);}, flush() {if(written!==size) throw Error('short');}});}
};
const ROOT='https://atomic-reports.djdelevic.workers.dev';
const REPO='https://api.github.com/repos/delevic/atomic-launcher-reports';
const token=()=>randomBytes(32).toString('base64url');
const hash=value=>createHash('sha256').update(value).digest('base64url');
const zip=Buffer.from('504b0304'+'00'.repeat(30),'hex');
const digest=createHash('sha256').update(zip).digest('hex');
const response=(data,status=200)=>new Response(status===204?null:JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});
function fixture() {
  const env={DB:new D1(),GITHUB_CLIENT_ID:'test-client',GITHUB_CLIENT_SECRET:'test-secret',GITHUB_REPORT_TOKEN:'test-repo-token',ALLOWED_GITHUB_USERS:'delevic,tester'};
  const state={assets:[],issues:[],uploads:0,posts:0,releases:0,issueMode:'ok',login:'delevic',userId:12,wrongDigest:false};
  globalThis.fetch=async(url,options={})=>{
    const target=String(url); const method=options.method || 'GET';
    if(target==='https://github.com/login/oauth/access_token') {
      assert.equal(options.body.get('client_secret'),'test-secret');
      assert.equal(options.body.get('redirect_uri'),ROOT+'/auth/callback');
      return response({access_token:'user-access-token'});
    }
    if(target==='https://api.github.com/user') {
      assert.equal(options.headers.Authorization,'Bearer user-access-token');
      return response({id:state.userId,login:state.login});
    }
    assert.equal(options.headers.Authorization,'Bearer test-repo-token');
    assert.equal(options.redirect,'error');
    if(target.includes('/releases/tags/')) return state.releases ? response({id:1,draft:false}) : response({},404);
    if(target===REPO+'/releases' && method==='POST') {state.releases++; return response({id:1,draft:false},201);}
    if(target===REPO+'/releases/1/assets?per_page=100') return response(state.assets);
    if(target.startsWith('https://uploads.github.com/')) {
      state.uploads++;
      const data=Buffer.from(await new Response(options.body).arrayBuffer());
      assert.deepEqual(data,zip);
      const name=new URL(target).searchParams.get('name');
      const asset={id:state.assets.length+1,name,size:data.length,state:'uploaded',digest:'sha256:'+(state.wrongDigest?'0'.repeat(64):digest),
        browser_download_url:`https://github.com/delevic/atomic-launcher-reports/releases/download/reports-2026-09-26/${name}`};
      state.assets.push(asset); return response(asset,201);
    }
    if(target.startsWith(REPO+'/releases/assets/')) return response(state.assets.find(x=>x.id===Number(target.split('/').at(-1))));
    if(target===REPO+'/issues' && method==='POST') {
      state.posts++;
      if(state.issueMode==='reject') return response({},403);
      if(state.issueMode==='missing') throw Error('connection failed');
      const issue={...JSON.parse(options.body),number:state.issues.length+1};
      issue.html_url=`https://github.com/delevic/atomic-launcher-reports/issues/${issue.number}`; state.issues.push(issue);
      if(state.issueMode==='lost') throw Error('reply lost after commit');
      return response(issue,201);
    }
    if(target.startsWith(REPO+'/issues?')) return response(state.issues);
    throw Error('Unexpected fetch: '+method+' '+target);
  };
  async function call(path,{method='GET',body,auth,headers={}}={}) {
    const options={method,headers:{...headers,...(auth?{Authorization:`Bearer ${auth}`}:{})}};
    if(body!==undefined) {options.body=JSON.stringify(body); options.headers['Content-Type']='application/json';}
    const out=await worker.fetch(new Request(ROOT+path,options),env);
    return {response:out,status:out.status,data:out.headers.get('Content-Type')?.startsWith('application/json')?await out.json():await out.text()};
  }
  async function startLogin() {
    const verifier=token(); const session_token=token();
    const out=await call('/v1/auth/start',{method:'POST',body:{challenge:hash(verifier)}});
    assert.equal(out.status,200);
    return {login_id:out.data.login_id,verifier,session_token};
  }
  async function authorize(login) {
    const opened=await call('/auth/github?id='+login.login_id); assert.equal(opened.status,302);
    const url=new URL(opened.response.headers.get('Location'));
    assert.equal(url.origin,'https://github.com'); assert.equal(url.searchParams.get('code_challenge'),hash(login.verifier));
    assert.equal(url.searchParams.get('scope'),''); assert.equal(url.searchParams.get('state'),login.login_id);
    const cookie=opened.response.headers.get('Set-Cookie').split(';')[0];
    const callback=await call('/auth/callback?state='+login.login_id+'&code=synthetic-code',{headers:{Cookie:cookie}});
    assert.equal(callback.status,200); return cookie;
  }
  async function signIn() {
    const login=await startLogin(); await authorize(login);
    const out=await call('/v1/auth/token',{method:'POST',body:login}); assert.equal(out.status,200);
    return {auth:login.session_token,login,out};
  }
  function meta() {return {client_report_id:randomBytes(16).toString('hex'),name:'Synthetic report',description:'Touch / snap test',build:'TEST',device:'Synthetic',size:zip.length,sha256:digest,public_upload_consent:true};}
  async function prepare(auth,body=meta()) {return call('/v1/reports',{method:'POST',auth,body});}
  async function upload(auth,id,data=zip,length=zip.length) {
    const out=await worker.fetch(new Request(ROOT+`/v1/reports/${id}/zip`,{method:'PUT',headers:{Authorization:`Bearer ${auth}`,'Content-Type':'application/zip','Content-Length':String(length)},body:data}),env);
    return {status:out.status,data:await out.json()};
  }
  async function uploaded(auth) {const prepared=await prepare(auth); assert.equal(prepared.status,200); const id=prepared.data.report_id; const out=await upload(auth,id); assert.equal(out.status,200); assert.equal(out.data.status,'uploaded'); return id;}
  return {env,state,call,startLogin,authorize,signIn,meta,prepare,upload,uploaded};
}

test('unconfigured service is readable but refuses all sends; keys are never exposed',async()=>{
  const result=await worker.fetch(new Request(ROOT+'/health'),{}); const data=await result.json();
  assert.equal(data.configured,false); assert.deepEqual(data.missing,['DB','GITHUB_CLIENT_ID','GITHUB_CLIENT_SECRET','GITHUB_REPORT_TOKEN']);
  assert.equal((await worker.fetch(new Request(ROOT+'/v1/reports',{method:'POST'}),{})).status,503);
});
test('PKCE login, callback cookie, replay protection, retry after lost login response, logout',async()=>{
  const f=fixture(); const login=await f.startLogin();
  assert.equal((await f.call('/v1/auth/token',{method:'POST',body:login})).status,202);
  assert.equal((await f.call('/v1/auth/token',{method:'POST',body:{...login,verifier:token()}})).status,400);
  assert.equal((await f.call('/auth/callback?state='+login.login_id+'&code=x')).status,400);
  const cookie=await f.authorize(login);
  assert.equal((await f.call('/auth/callback?state='+login.login_id+'&code=x',{headers:{Cookie:cookie}})).status,400);
  assert.equal((await f.call('/v1/auth/token',{method:'POST',body:login})).data.status,'authorized');
  assert.equal((await f.call('/v1/auth/token',{method:'POST',body:login})).data.login,'delevic');
  assert.equal((await f.call('/v1/auth/token',{method:'POST',body:{...login,session_token:token()}})).status,409);
  assert.equal((await f.call('/v1/me',{auth:login.session_token})).data.login,'delevic');
  const stored=f.env.DB.db.prepare('SELECT * FROM ar_sessions').get(); assert.equal(stored.token_hash,hash(login.session_token));
  assert.equal(JSON.stringify(stored).includes(login.session_token),false);
  await f.call('/v1/logout',{method:'POST',auth:login.session_token});
  assert.equal((await f.call('/v1/me',{auth:login.session_token})).status,401);
});
test('denied, expired and unapproved accounts cannot sign in',async()=>{
  const f=fixture(); f.state.login='outsider';
  const login=await f.startLogin(); await f.authorize(login);
  assert.equal((await f.call('/v1/auth/token',{method:'POST',body:login})).status,403);
  const another=await f.startLogin(); f.env.DB.db.prepare('UPDATE ar_auth SET expires=0 WHERE id=?').run(hash(another.login_id));
  assert.equal((await f.call('/auth/github?id='+another.login_id)).status,410);
});
test('no credentials, cross-origin and missing public consent refuse writes',async()=>{
  const f=fixture(); const {auth}=await f.signIn();
  assert.equal((await f.prepare(undefined)).status,401);
  assert.equal((await f.call('/v1/reports',{method:'POST',auth,body:f.meta(),headers:{Origin:'https://attacker.invalid'}})).status,403);
  assert.equal((await f.prepare(auth,{...f.meta(),public_upload_consent:false})).status,400);
  assert.equal((await f.prepare(auth,{...f.meta(),size:50*1024*1024+1})).status,413);
  assert.equal((await f.prepare(auth,{...f.meta(),description:'x'.repeat(17000)})).status,413);
});
test('complete flow, identical prepare/upload/submit retries create one asset and one issue',async()=>{
  const f=fixture(); const {auth}=await f.signIn(); const meta=f.meta();
  const first=await f.prepare(auth,meta); const id=first.data.report_id;
  assert.equal((await f.prepare(auth,meta)).data.report_id,id);
  assert.equal((await f.prepare(auth,{...meta,name:'changed'})).status,409);
  assert.equal((await f.call(`/v1/reports/${id}/submit`,{method:'POST',auth})).status,409);
  assert.equal((await f.upload(auth,id)).data.status,'uploaded');
  assert.equal((await f.upload(auth,id)).data.status,'uploaded');
  assert.equal((await f.call(`/v1/reports/${id}/submit`,{method:'POST',auth})).data.status,'sent');
  assert.equal((await f.call(`/v1/reports/${id}/submit`,{method:'POST',auth})).data.issue_number,1);
  assert.equal(f.state.uploads,1); assert.equal(f.state.posts,1);
  assert.match(f.state.issues[0].body,/Download diagnostic ZIP/);
  assert.match(f.state.issues[0].body,new RegExp(digest));
});
test('another signed-in tester cannot access, upload or submit another user report',async()=>{
  const f=fixture(); const owner=await f.signIn(); const report=await f.prepare(owner.auth); const id=report.data.report_id;
  f.state.userId=13; f.state.login='tester'; const other=await f.signIn();
  assert.equal((await f.call(`/v1/reports/${id}`,{auth:other.auth})).status,404);
  assert.equal((await f.upload(other.auth,id)).status,404);
  assert.equal((await f.call(`/v1/reports/${id}/submit`,{method:'POST',auth:other.auth})).status,404);
});
test('wrong content length and mismatched GitHub digest never claim an uploaded file',async()=>{
  const f=fixture(); const {auth}=await f.signIn(); const p=await f.prepare(auth); const id=p.data.report_id;
  assert.equal((await f.upload(auth,id,zip,zip.length+1)).status,400);
  f.state.wrongDigest=true;
  assert.equal((await f.upload(auth,id)).status,502);
  assert.equal((await f.call(`/v1/reports/${id}/submit`,{method:'POST',auth})).status,409);
  assert.equal(f.state.posts,0);
});
test('recovery adopts a verified ZIP after a lost upload response without uploading again',async()=>{
  const f=fixture(); const {auth}=await f.signIn(); const id=await f.uploaded(auth);
  f.env.DB.db.prepare("UPDATE ar_reports SET status='uploading',asset_id=NULL,asset_url=NULL,lease_until=0 WHERE id=?").run(id);
  assert.equal((await f.upload(auth,id)).data.status,'uploaded'); assert.equal(f.state.uploads,1);
});
test('concurrent submit requests produce a single GitHub issue',async()=>{
  const f=fixture(); const {auth}=await f.signIn(); const id=await f.uploaded(auth);
  const out=await Promise.all([f.call(`/v1/reports/${id}/submit`,{method:'POST',auth}),f.call(`/v1/reports/${id}/submit`,{method:'POST',auth})]);
  assert.equal(f.state.posts,1); assert.ok(out.some(x=>x.data.status==='sent'));
});
test('lost issue response reconciles an existing issue; does not post twice',async()=>{
  const f=fixture(); const {auth}=await f.signIn(); const id=await f.uploaded(auth); f.state.issueMode='lost';
  assert.equal((await f.call(`/v1/reports/${id}/submit`,{method:'POST',auth})).status,503);
  const retried=await f.call(`/v1/reports/${id}/submit`,{method:'POST',auth});
  assert.equal(retried.data.status,'sent'); assert.equal(f.state.posts,1);
});
test('ambiguous issue failure remains pending when no confirmed issue is found',async()=>{
  const f=fixture(); const {auth}=await f.signIn(); const id=await f.uploaded(auth); f.state.issueMode='missing';
  await f.call(`/v1/reports/${id}/submit`,{method:'POST',auth});
  const retried=await f.call(`/v1/reports/${id}/submit`,{method:'POST',auth});
  assert.equal(retried.status,202); assert.equal(retried.data.status,'uncertain'); assert.equal(f.state.posts,1);
});
test('a definite GitHub refusal can retry safely after credentials are fixed',async()=>{
  const f=fixture(); const {auth}=await f.signIn(); const id=await f.uploaded(auth); f.state.issueMode='reject';
  assert.equal((await f.call(`/v1/reports/${id}/submit`,{method:'POST',auth})).status,502);
  f.state.issueMode='ok';
  assert.equal((await f.call(`/v1/reports/${id}/submit`,{method:'POST',auth})).data.status,'sent');
  assert.equal(f.state.issues.length,1);
});
test('per-user report rate is bounded',async()=>{
  const f=fixture(); const {auth}=await f.signIn();
  for(let i=0;i<3;i++) assert.equal((await f.prepare(auth)).status,200);
  assert.equal((await f.prepare(auth)).status,429);
});
test('invented login IDs do not allocate rate-limit records',async()=>{
  const f=fixture(); const {auth}=await f.signIn();
  const before=f.env.DB.db.prepare('SELECT count(*) AS n FROM ar_rates').get().n;
  const out=await f.call('/v1/auth/token',{method:'POST',body:{login_id:token(),verifier:token(),session_token:token()}});
  assert.equal(out.status,400); assert.equal(f.env.DB.db.prepare('SELECT count(*) AS n FROM ar_rates').get().n,before);
  f.env.DB.db.prepare('UPDATE ar_sessions SET expires=0').run();
  assert.equal((await f.call('/v1/me',{auth})).status,401);
});
test('an active upload lease blocks another upload and never posts an issue',async()=>{
  const f=fixture(); const {auth}=await f.signIn(); const prepared=await f.prepare(auth); const id=prepared.data.report_id;
  f.env.DB.db.prepare("UPDATE ar_reports SET status='uploading',lease_until=? WHERE id=?").run(Math.floor(Date.now()/1000)+900,id);
  assert.equal((await f.upload(auth,id)).status,409); assert.equal(f.state.uploads,0); assert.equal(f.state.posts,0);
});

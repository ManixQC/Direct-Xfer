'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const net=require('node:net');
const {spawn}=require('node:child_process');

async function freePort(){return await new Promise((resolve,reject)=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});s.on('error',reject);});}
async function waitFor(url,timeout=5000){const start=Date.now();while(Date.now()-start<timeout){try{const r=await fetch(url);if(r.ok)return await r.json();}catch(_){}await new Promise(r=>setTimeout(r,80));}throw new Error('broker did not start');}

test('central OAuth broker keeps Google refresh token server-side and serves OAuth-compatible refreshes',async(t)=>{
  const port=await freePort();
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'dx-oauth-broker-'));
  const preload=path.join(tmp,'preload.js');
  fs.writeFileSync(preload,`
const realFetch=global.fetch;
global.fetch=async function(url,options){
  if(String(url)==='https://oauth2.googleapis.com/token'){
    const body=options&&options.body; const form=body instanceof URLSearchParams?body:new URLSearchParams(String(body||''));
    if(form.get('grant_type')==='authorization_code') return new Response(JSON.stringify({access_token:'initial-access',refresh_token:'google-refresh-SUPERSECRET',token_type:'Bearer',expires_in:3600,scope:'https://www.googleapis.com/auth/drive.file'}),{status:200,headers:{'content-type':'application/json'}});
    if(form.get('grant_type')==='refresh_token'&&form.get('refresh_token')==='google-refresh-SUPERSECRET') return new Response(JSON.stringify({access_token:'refreshed-access',token_type:'Bearer',expires_in:3600,scope:'https://www.googleapis.com/auth/drive.file'}),{status:200,headers:{'content-type':'application/json'}});
    return new Response(JSON.stringify({error:'invalid_grant'}),{status:400,headers:{'content-type':'application/json'}});
  }
  return realFetch(url,options);
};
`);
  const broker=spawn(process.execPath,['oauth-broker/server.js'],{
    cwd:path.resolve(__dirname,'..'),
    env:{...process.env,NODE_OPTIONS:`--require=${preload}`,HOST:'127.0.0.1',PORT:String(port),DIRECT_XFER_OAUTH_BROKER_PUBLIC_URL:`http://127.0.0.1:${port}`,DIRECT_XFER_GOOGLE_WEB_CLIENT_ID:'123-broker.apps.googleusercontent.com',DIRECT_XFER_GOOGLE_WEB_CLIENT_SECRET:'broker-google-secret',DIRECT_XFER_OAUTH_BROKER_DATA_DIR:tmp,DIRECT_XFER_OAUTH_BROKER_DATA_KEY:'test-broker-data-key-abcdefghijklmnopqrstuvwxyz'},
    stdio:['ignore','pipe','pipe'],
  });
  t.after(()=>{try{broker.kill('SIGTERM');}catch(_){};});
  await waitFor(`http://127.0.0.1:${port}/healthz`);
  const createdRes=await fetch(`http://127.0.0.1:${port}/v1/google/sessions`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({version:'1.67.26'})});
  assert.equal(createdRes.status,201); const created=await createdRes.json();
  assert.ok(created.id); assert.ok(created.pollToken); const auth=new URL(created.authUrl); const state=auth.searchParams.get('state'); assert.ok(state);
  assert.equal(auth.searchParams.get('redirect_uri'),`http://127.0.0.1:${port}/v1/google/callback`);
  const callback=await fetch(`http://127.0.0.1:${port}/v1/google/callback?state=${encodeURIComponent(state)}&code=code-123`);
  assert.equal(callback.status,200);
  const polledRes=await fetch(`http://127.0.0.1:${port}/v1/google/sessions/${created.id}`,{headers:{authorization:`Bearer ${created.pollToken}`}});
  assert.equal(polledRes.status,200); const polled=await polledRes.json();
  assert.equal(polled.status,'completed'); assert.ok(polled.credential);
  assert.match(polled.credential.clientId,/^dxc_/); assert.match(polled.credential.token.refresh_token,/^dxr_/);
  assert.equal(polled.credential.token.access_token,'initial-access');
  assert.equal(polled.credential.tokenUrl,`http://127.0.0.1:${port}/v1/google/token`);
  const storeText=fs.readFileSync(path.join(tmp,'google-credentials.enc.json'),'utf8');
  assert.doesNotMatch(storeText,/google-refresh-SUPERSECRET|broker-google-secret|initial-access/);
  const basic=Buffer.from(`${polled.credential.clientId}:${polled.credential.clientSecret}`).toString('base64');
  const refreshRes=await fetch(polled.credential.tokenUrl,{method:'POST',headers:{authorization:`Basic ${basic}`,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'refresh_token',refresh_token:polled.credential.token.refresh_token})});
  assert.equal(refreshRes.status,200); const refreshed=await refreshRes.json();
  assert.equal(refreshed.access_token,'refreshed-access');
  assert.equal(refreshed.refresh_token,polled.credential.token.refresh_token);
});

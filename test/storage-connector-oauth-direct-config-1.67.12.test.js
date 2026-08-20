'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { StorageConnectorService, connectorBackendType, OAUTH_CONNECTOR_TYPES, CONNECTOR_TYPES } = require('../lib/storage-connectors');
const { createStorageConnectorConfigRoutes } = require('../lib/server/storage-connector-config');

function fakeDirectOAuthRclone(dir) {
  const file = path.join(dir, 'fake-direct-oauth-rclone.js');
  fs.writeFileSync(file, String.raw`
const fs=require('fs'),path=require('path'),http=require('http');
const a=process.argv.slice(2), conf=process.env.RCLONE_CONFIG, db=conf+'.json';
function read(){try{return JSON.parse(fs.readFileSync(db,'utf8'))}catch{return {}}}
function save(x){fs.mkdirSync(path.dirname(conf),{recursive:true});fs.writeFileSync(db,JSON.stringify(x));}
if(a[0]==='version'){console.log('rclone v1.75.0');process.exit(0)}
if(a[0]==='listremotes'){for(const k of Object.keys(read()))console.log(k+':');process.exit(0)}
if(a[0]==='config'&&a[1]==='create'){
  if(a[a.indexOf('client_id')+1]!=='123456-test.apps.googleusercontent.com'||a[a.indexOf('client_secret')+1]!=='GOCSPX-test-secret'){console.error('missing google oauth defaults on create');process.exit(11)}
  const x=read();x[a[2]]={type:a[3],client_id:'dx-client',client_secret:'dx-secret'};save(x);
  console.log(JSON.stringify({State:'*oauth-islocal,,,',Option:{Name:'config_is_local',Help:'Use web browser?',Default:true,Examples:[],Required:false,IsPassword:false,Type:'bool',Exclusive:true},Error:''}));process.exit(0)
}
if(a[0]==='config'&&a[1]==='update'){
  if(a[a.indexOf('client_id')+1]!=='123456-test.apps.googleusercontent.com'||a[a.indexOf('client_secret')+1]!=='GOCSPX-test-secret'){console.error('missing google oauth defaults on continue');process.exit(12)}
  const st=a[a.indexOf('--state')+1], result=a[a.indexOf('--result')+1];
  if(st==='*oauth-islocal,,,'&&result==='true'){
    const srv=http.createServer((req,res)=>{
      if(req.url.startsWith('/auth?')){res.statusCode=302;res.setHeader('Location','https://accounts.example.test/oauth?state=directstate&redirect_uri='+encodeURIComponent('http://'+req.headers.host+'/'));res.end();return}
      if(req.url.startsWith('/?')){res.statusCode=200;res.end('ok');setTimeout(()=>{console.log(JSON.stringify({State:'',Option:null,Error:''}));srv.close(()=>process.exit(0));},15);return}
      res.statusCode=404;res.end();
    });
    srv.listen(0,'127.0.0.1',()=>console.error('NOTICE: http://127.0.0.1:'+srv.address().port+'/auth?state=directstate'));
    setTimeout(()=>{srv.close(()=>process.exit(4));},4000).unref();return;
  }
  console.log(JSON.stringify({State:'*oauth-token,,,',Option:{Name:'config_token',Help:'headless fallback',Default:'',Examples:[],Required:true,IsPassword:true,Type:'string',Exclusive:false},Error:''}));process.exit(0)
}
if(a[0]==='config'&&a[1]==='delete'){const x=read();delete x[a[2]];save(x);process.exit(0)}
process.exit(3);
`);
  return file;
}

const waitFor = async (fn, timeoutMs=2000) => {
  const end=Date.now()+timeoutMs;
  while(Date.now()<end){ const value=fn(); if(value) return value; await new Promise(r=>setTimeout(r,10)); }
  throw new Error('timeout');
};

test('1.67.26 OAuth can continue the same rclone config state directly instead of parsing rclone authorize help', async () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dx-oauth-direct-'));
  const service=new StorageConnectorService({bin:fakeDirectOAuthRclone(dir),configPath:path.join(dir,'rclone.conf')});
  const googleParameters={client_id:'123456-test.apps.googleusercontent.com',client_secret:'GOCSPX-test-secret'};
  const first=await service.configCreateStart('mydrive','google-drive',{parameters:googleParameters});
  assert.equal(first.option.Name,'config_is_local');
  let providerUrl='';
  const handle=service.startOAuthConfigAuthorization('mydrive',first.state,{connectorType:'google-drive',parameters:googleParameters,timeoutMs:5000,onUrl:url=>{providerUrl=url;}});
  await waitFor(()=>providerUrl);
  assert.match(providerUrl,/^https:\/\/accounts\.example\.test\/oauth\?/);
  const callbackBase=new URL(providerUrl).searchParams.get('redirect_uri');
  const wrongCallback=new URL(callbackBase); wrongCallback.search='?state=wrong&code=x';
  await assert.rejects(()=>handle.acceptCallback(wrongCallback.toString()),/oauth-callback-state/);
  const goodCallback=new URL(callbackBase); goodCallback.hostname='localhost'; goodCallback.search='?state=directstate&code=ok';
  await handle.acceptCallback(goodCallback.toString());
  const result=await handle.promise;
  assert.equal(result.question.done,true);
  assert.deepEqual(await service.configuredRemotes(),['mydrive']);
});

function deferred(){let resolve,reject;const promise=new Promise((res,rej)=>{resolve=res;reject=rej});return {promise,resolve,reject};}

test('1.67.26 OAuth route prefers the direct same-config transaction and completes that session', async () => {
  const routes=new Map();
  const router={post:(r,...h)=>routes.set(`POST ${r}`,h.at(-1)),get:(r,...h)=>routes.set(`GET ${r}`,h.at(-1)),delete:(r,...h)=>routes.set(`DELETE ${r}`,h.at(-1))};
  const attempt=deferred(); let startedArgs=null;
  const service={
    async capabilities(){return {available:true,version:'rclone v1.75.0'}},
    async configuredRemotes(){return []},
    async configCreateStart(){return {done:false,state:'*oauth-islocal,,,',option:{Name:'config_is_local',Default:true,Examples:[],Type:'bool'},error:''}},
    async deleteRemote(){return true},
    startOAuthConfigAuthorization(remote,state,options){startedArgs={remote,state};options.onUrl('https://accounts.example.test/oauth?state=x');return {promise:attempt.promise,cancel(){},acceptCallback:async()=>({ok:true})}},
  };
  createStorageConnectorConfigRoutes({
    adminRouter:router,requireFullAdmin(_q,_s,n){if(n)n()},storageConnectorService:service,CONNECTOR_TYPES,OAUTH_CONNECTOR_TYPES,connectorBackendType,crypto,
    isLoopback:()=>false,clientIp:()=> '192.0.2.1',auditReq:()=>{},logAudit:()=>{},getAccountById:()=>null,invalidateConnectorProbe:()=>{},
  });
  const mkReq=(body={},params={})=>({body,params,session:{accountId:'owner',username:'admin'}});
  const call=async(method,route,req)=>{let code=200,payload;const res={status(c){code=c;return this},json(v){payload=v;return this}};await routes.get(`${method} ${route}`)(req,res);return {code,payload}};
  const start=await call('POST','/storage/remotes/config/start',mkReq({type:'google-drive',remote:'mydrive',oauthConfig:{clientId:'123456-test.apps.googleusercontent.com',clientSecret:'GOCSPX-test-secret'}}));
  assert.equal(start.payload.parameters,undefined);
  const id=start.payload.id;
  const oauth=await call('POST','/storage/remotes/config/:id/oauth',mkReq({}, {id}));
  assert.equal(oauth.code,202);
  assert.equal(oauth.payload.parameters,undefined);
  assert.deepEqual(startedArgs,{remote:'mydrive',state:'*oauth-islocal,,,'});
  assert.equal(oauth.payload.status,'oauth-waiting');
  assert.match(oauth.payload.authUrl,/accounts\.example\.test/);
  attempt.resolve({question:{done:true,state:'',option:null,error:''}});
  await new Promise(r=>setImmediate(r)); await new Promise(r=>setImmediate(r));
  const done=await call('GET','/storage/remotes/config/:id',mkReq({}, {id}));
  assert.equal(done.payload.status,'completed');
});

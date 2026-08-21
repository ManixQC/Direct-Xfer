'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const fs=require('node:fs');
const path=require('node:path');
const {createStorageConnectorConfigRoutes}=require('../lib/server/storage-connector-config');
const {CONNECTOR_TYPES,OAUTH_CONNECTOR_TYPES,connectorBackendType}=require('../lib/storage-connectors');

const ROOT=path.resolve(__dirname,'..');
const LIMITED='https://www.googleapis.com/auth/drive.file';

function harness({mismatch=false}={}){
  const routes=new Map();
  const adminRouter={
    get(route,...handlers){routes.set(`GET ${route}`,handlers.at(-1));},
    post(route,...handlers){routes.set(`POST ${route}`,handlers.at(-1));},
    delete(route,...handlers){routes.set(`DELETE ${route}`,handlers.at(-1));},
  };
  let polls=0;
  const broker={
    configured(){return true;},
    async createSession({scope}){
      assert.equal(scope,LIMITED);
      const auth=new URL('https://accounts.google.com/o/oauth2/v2/auth');
      auth.searchParams.set('scope',scope);
      return {id:'scope-session',pollToken:'p'.repeat(32),authUrl:auth.toString(),scope,expiresAt:Date.now()+600000};
    },
    async poll(){
      polls++;
      if(polls===1)return {status:'waiting',credential:null};
      return {status:'completed',credential:{clientId:'dxc_scope123',clientSecret:'s'.repeat(32),tokenUrl:'https://oauth.example.test/v1/google/token',token:{access_token:'a',refresh_token:'dxr_scope123',scope:mismatch?`${LIMITED} https://www.googleapis.com/auth/drive`:LIMITED,expiry:new Date(Date.now()+3600000).toISOString()}}};
    },
    validateCredential(value){
      if(mismatch)throw Object.assign(new Error('scope mismatch'),{code:'oauth-broker-scope-mismatch'});
      return value;
    },
    async consume(){},
  };
  const service={
    async capabilities(){return {available:true};},
    async configuredRemotes(){return [];},
    async createGoogleBrokerRemote(){return {verified:true};},
  };
  createStorageConnectorConfigRoutes({
    adminRouter,requireFullAdmin(_req,_res,next){if(next)next();},storageConnectorService:service,
    googleOAuthProfileStore:null,googleOAuthBrokerClient:broker,CONNECTOR_TYPES,OAUTH_CONNECTOR_TYPES,connectorBackendType,
    crypto,isLoopback:()=>false,clientIp:()=> '192.0.2.44',auditReq:()=>{},logAudit:()=>{},getAccountById:()=>null,
    invalidateConnectorProbe:()=>{},googleOAuthPublicOrigin:()=>'',
  });
  const req=({body={},params={}}={})=>({body,params,query:{},protocol:'https',session:{accountId:'owner',username:'admin'},get(){return 'dx.example.test';}});
  async function call(method,route,request){
    const handler=routes.get(`${method} ${route}`);assert.equal(typeof handler,'function');
    let statusCode=200,payload;
    const res={status(c){statusCode=c;return this;},json(v){payload=v;return this;},send(v){payload=v;return this;},setHeader(){}};
    await handler(request,res);return {statusCode,payload};
  }
  return {call,req};
}

test('1.69.0 Google OAuth session reports requested and broker-returned scopes to the admin UI',async()=>{
  const h=harness();
  const start=await h.call('POST','/storage/remotes/google-oauth/start',h.req({body:{remote:'gdrive',scope:'limited'}}));
  assert.equal(start.statusCode,201);
  assert.equal(start.payload.requestedScope,LIMITED);
  assert.equal(start.payload.grantedScope,null);
  const waiting=await h.call('GET','/storage/oauth/google-session/:id',h.req({params:{id:start.payload.id}}));
  assert.equal(waiting.payload.requestedScope,LIMITED);
  assert.equal(waiting.payload.grantedScope,null);
  const done=await h.call('GET','/storage/oauth/google-session/:id',h.req({params:{id:start.payload.id}}));
  assert.equal(done.payload.status,'completed');
  assert.equal(done.payload.requestedScope,LIMITED);
  assert.equal(done.payload.grantedScope,LIMITED);
  assert.equal(done.payload.broker,true);
});

test('1.69.0 preserves the actual broker scope even when least-privilege validation rejects it',async()=>{
  const h=harness({mismatch:true});
  const start=await h.call('POST','/storage/remotes/google-oauth/start',h.req({body:{remote:'gdrive',scope:'limited'}}));
  await h.call('GET','/storage/oauth/google-session/:id',h.req({params:{id:start.payload.id}}));
  const failed=await h.call('GET','/storage/oauth/google-session/:id',h.req({params:{id:start.payload.id}}));
  assert.equal(failed.payload.status,'error');
  assert.equal(failed.payload.error,'oauth-broker-scope-mismatch');
  assert.match(failed.payload.grantedScope,/drive\.file/);
  assert.match(failed.payload.grantedScope,/\/drive$/);
});

test('1.69.0 connection modal displays requested scope, broker-returned scope and sensitivity',()=>{
  const html=fs.readFileSync(path.join(ROOT,'public/index.html'),'utf8');
  const app=fs.readFileSync(path.join(ROOT,'public/app.js'),'utf8');
  assert.match(html,/id="connector-config-google-scope-info"/);
  assert.match(html,/id="connector-config-google-scope-requested"/);
  assert.match(html,/id="connector-config-google-scope-returned"/);
  assert.match(app,/connector\.googleRequestedScope/);
  assert.match(app,/connector\.googleBrokerReturnedScope/);
  assert.match(app,/connector\.googleScopeNonSensitive/);
  assert.match(app,/googleDriveScopeSummary/);
  assert.match(app,/grantedScope/);
  assert.match(app,/requestedScope/);
});

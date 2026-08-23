'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createStorageConnectorConfigRoutes } = require('../lib/server/storage-connector-config');
const { GoogleOAuthBrokerClient } = require('../lib/google-oauth-broker-client');
const { CONNECTOR_TYPES, OAUTH_CONNECTOR_TYPES, connectorBackendType } = require('../lib/storage-connectors');

function routerHarness({ broker, brokerUrl }) {
  const routes = new Map();
  const adminRouter = {
    get(r,...h){routes.set(`GET ${r}`,h.at(-1));},
    post(r,...h){routes.set(`POST ${r}`,h.at(-1));},
    delete(r,...h){routes.set(`DELETE ${r}`,h.at(-1));},
  };
  const service={
    async capabilities(){return {available:true,version:'rclone v1.75.0'};},
    async configuredRemotes(){return [];},
  };
  createStorageConnectorConfigRoutes({
    adminRouter, requireFullAdmin(_q,_s,next){if(next)next();}, storageConnectorService:service,
    googleOAuthProfileStore:null, googleOAuthBrokerClient:broker, googleOAuthBrokerUrl:brokerUrl, googleOAuthBrokerManaged:()=>false,
    CONNECTOR_TYPES,OAUTH_CONNECTOR_TYPES,connectorBackendType,crypto,isLoopback:()=>false,clientIp:()=> '192.0.2.50',
    auditReq:()=>{},logAudit:()=>{},getAccountById:()=>null,invalidateConnectorProbe:()=>{},googleOAuthPublicOrigin:()=>'',
  });
  const req=(body={})=>({body,protocol:'http',session:{accountId:'owner',username:'admin'},get(name){return name==='host'?'192.168.1.20:55750':'';}});
  async function call(method,route,request){let statusCode=200,payload;const res={status(c){statusCode=c;return this;},json(v){payload=v;return this;},setHeader(){}};await routes.get(`${method} ${route}`)(request,res);return {statusCode,payload};}
  return {call,req};
}

test('1.67.26 a broker URL stored in Direct-Xfer settings is used even when the process started without the env variable', async()=>{
  const origin='https://oauth.example.test';
  const broker = new GoogleOAuthBrokerClient({
    baseUrl:'', version:'1.67.26',
    fetch:async(url,options)=>{
      assert.equal(String(url),origin+'/v1/google/sessions');
      assert.equal(options.method,'POST');
      const auth=new URL('https://accounts.google.com/o/oauth2/v2/auth');
      auth.searchParams.set('redirect_uri',origin+'/v1/google/callback');
      auth.searchParams.set('response_type','code');
      auth.searchParams.set('scope','https://www.googleapis.com/auth/drive.file');
      auth.searchParams.set('state','s'.repeat(24));
      auth.searchParams.set('code_challenge','c'.repeat(32));
      auth.searchParams.set('code_challenge_method','S256');
      return new Response(JSON.stringify({id:'session_12345678',pollToken:'p'.repeat(32),authUrl:auth.toString(),expiresAt:Date.now()+600000}),{status:201,headers:{'content-type':'application/json'}});
    },
  });
  const h=routerHarness({broker,brokerUrl:()=>origin});
  const out=await h.call('POST','/storage/remotes/google-oauth/start',h.req({remote:'gdrive'}));
  assert.equal(out.statusCode,201);
  assert.equal(out.payload.broker,true);
  assert.match(out.payload.authUrl,/^https:\/\/accounts\.google\.com\//);
});

test('1.67.26 a remote browser with no broker gets a precise setup-required error', async()=>{
  const broker=new GoogleOAuthBrokerClient({baseUrl:'',version:'1.67.26'});
  const h=routerHarness({broker,brokerUrl:()=>''});
  const out=await h.call('POST','/storage/remotes/google-oauth/start',h.req({remote:'gdrive'}));
  assert.equal(out.statusCode,428);
  assert.equal(out.payload.error,'oauth-broker-not-configured');
  assert.equal(out.payload.setupRequired,true);
  assert.equal(out.payload.retryable,false);
});

test('1.67.26 standard UI exposes persistent broker configuration and preserves detailed broker errors',()=>{
  const html=fs.readFileSync(path.resolve(__dirname,'../public/index.html'),'utf8');
  const app=fs.readFileSync(path.resolve(__dirname,'../public/app.js'),'utf8');
  const server=fs.readFileSync(path.resolve(__dirname,'../server.js'),'utf8')+'\n'+fs.readFileSync(path.resolve(__dirname,'../lib/server/settings-service.js'),'utf8');
  assert.match(html,/connector-config-google-broker-url/);
  assert.match(html,/connector-config-google-broker-save/);
  assert.match(app,/saveGoogleOAuthBrokerUrl/);
  assert.match(app,/googleOAuthBrokerUrl:raw/);
  assert.match(app,/error&&error\.data/);
  assert.match(server,/googleOAuthBrokerUrl:\s*''/);
  assert.match(server,/cleanBrokerUrl\(raw\)/);
  assert.match(server,/GOOGLE_OAUTH_BROKER_URL_ENV \|\| String\(getSettings\(\)\.googleOAuthBrokerUrl/);
});

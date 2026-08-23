'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');

const BOOTSTRAP = String.raw`
const Module = require('module');
const originalLoad = Module._load;
function middleware(_req,_res,next){ if (typeof next === 'function') next(); }
function router(){
  const fn = function(_req,_res,next){ if (typeof next === 'function') next(); };
  for (const name of ['use','get','post','put','delete','patch','options','head','all','param','route','set','disable','enable']) fn[name] = () => fn;
  fn.listen = () => ({ on(){ return this; }, close(cb){ if (cb) cb(); } });
  fn.locals = Object.create(null);
  return fn;
}
function express(){ return router(); }
express.Router = router;
for (const name of ['json','urlencoded','raw','text','static']) express[name] = () => middleware;
express.application = {}; express.request = {}; express.response = {};
Module._load = function(request, parent, isMain){
  if (request === 'express') return express;
  if (request === 'qrcode') return { toDataURL: async () => 'data:image/png;base64,', toString: async () => '<svg></svg>' };
  if (request === 'archiver') return function(){ return { on(){return this;}, pipe(){return this;}, file(){return this;}, append(){return this;}, finalize(){return Promise.resolve();} }; };
  if (request.endsWith('/lifecycle-service') || request === './lib/server/lifecycle-service') return { createLifecycleService(){ return { start(){}, shutdown:async()=>{}, getServer(){ return null; }, getServerScheme(){ return 'http'; } }; } };
  return originalLoad.apply(this, arguments);
};
require('./server.js');
`;

test('point 7 composition boots through every route profile without undeclared dependencies', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dx-app-context-'));
  try {
    const result = spawnSync(process.execPath, ['-e', BOOTSTRAP], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 15000,
      env: {
        ...process.env,
        DATA_DIR: path.join(tmp, 'data'),
        HOST_ROOT: path.join(tmp, 'host'),
        INBOX_DIR: path.join(tmp, 'inbox'),
        IMAGES_DIR: path.join(tmp, 'images'),
        PORT: '55759',
      },
    });
    assert.equal(result.error, undefined, result.error && result.error.message);
    assert.equal(result.status, 0, `server composition smoke failed:\n${result.stderr || result.stdout}`);
  } finally {
    fs.rmSync(tmp, { recursive:true, force:true });
  }
});

'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const pkg=require('../package.json');
const {APP_NAME,APP_VERSION,versionPayload,injectAssetVersion}=require('../src/lib/app-version');

const root=path.join(__dirname,'..');

test('package metadata is the single version source for API and health payloads',()=>{
  assert.equal(APP_NAME,'mkcrm');
  assert.equal(APP_VERSION,pkg.version);
  assert.equal(pkg.version,'0.9.19.62');
  assert.deepEqual(versionPayload({}),{ok:true,name:'mkcrm',version:pkg.version,commit:null,environment:null});
  assert.equal(versionPayload({GIT_COMMIT:'abcdef123456',APP_ENV:'stage'}).commit,'abcdef123456');
});

test('server endpoints use the shared package-derived payload',()=>{
  const server=fs.readFileSync(path.join(root,'src/server.js'),'utf8');
  assert.ok(server.includes("pathname === '/health'"));
  assert.ok(server.includes("pathname === '/api/version'"));
  assert.ok(server.includes('versionPayload()'));
  assert.doesNotMatch(server,/const APP_VERSION\\s*=\\s*['"]/);
});

test('UI reads backend version and cache-bust tokens are injected from package version',()=>{
  const index=fs.readFileSync(path.join(root,'public/index.html'),'utf8');
  const app=fs.readFileSync(path.join(root,'public/assets/app.js'),'utf8');
  assert.match(index,/id="sidebarVersion"/);
  assert.equal((index.match(/__MKCRM_VERSION__/g)||[]).length,2);
  const rendered=injectAssetVersion(index);
  assert.doesNotMatch(rendered,/__MKCRM_VERSION__/);
  assert.equal(rendered.split(pkg.version).length-1,2);
  assert.ok(app.includes("fetch('/api/version'"));
  assert.doesNotMatch(app,/window\.MKCRM_VERSION\s*=/);
});

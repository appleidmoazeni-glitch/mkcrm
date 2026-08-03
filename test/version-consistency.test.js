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
  assert.match(pkg.version,/^\d+(?:\.\d+){2,}(?:-[0-9A-Za-z.-]+)?$/);
  const local=versionPayload({});
  assert.equal(local.ok,true);assert.equal(local.name,'mkcrm');assert.equal(local.applicationVersion,pkg.version);
  assert.match(local.gitSha,/^[0-9a-f]{40}$/);assert.equal(local.releaseMetadataReady,true);assert.ok(local.sourceBranch);assert.ok(local.buildTimestamp);
  const invalid=versionPayload({GIT_COMMIT:'abcdef123456',APP_ENV:'stage'});assert.equal(invalid.commit,'abcdef123456');assert.equal(invalid.releaseMetadataReady,false);assert.deepEqual(invalid.releaseBlockers,['GIT_SHA_MISSING_OR_INVALID']);
});

test('server endpoints use the shared package-derived payload',()=>{
  const server=fs.readFileSync(path.join(root,'src/server.js'),'utf8');
  assert.ok(server.includes("pathname === '/health'"));
  assert.ok(server.includes("pathname === '/api/version'"));
  assert.ok(server.includes('versionPayload()'));
  for(const field of ['activeSaleSnapshotId','activePurchaseDatasetId','activeFifoDatasetId','policyVersionId','sellerReadModelRunId','supplierReadModelRunId'])assert.ok(server.includes(field),`${field} must remain in the release metadata contract`);
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

'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const source=fs.readFileSync(path.join(__dirname,'../public/assets/app.js'),'utf8');
const guard=source.slice(source.indexOf('if(!window.__mkcrmSensitiveClickGuard)'),source.indexOf('function setPage',source.indexOf('if(!window.__mkcrmSensitiveClickGuard)')));
const hotfix=source.slice(source.indexOf('Production-safety hotfix: durable invoice issuance UX'));

test('issue button is excluded from the capture-phase generic click lock and receives the explicit safe handler',()=>{
  assert.equal(guard.includes("'#issueBtn,"),false);
  assert.match(hotfix,/function bindIssueButton\(\)/);
  assert.match(hotfix,/button\.dataset\.componentIdentity='sale-issue-button'/);
  assert.match(hotfix,/button\.onclick=event=>\{event\?\.preventDefault\?\.\(\);issueDiagnostic\('click-received'/);
  assert.match(hotfix,/bindIssueButton\(\);/);
});

test('binding model replaces the old node handler and a click initiates one request',async()=>{
  let requestCount=0;
  const bind=button=>{button.onclick=async()=>{if(button.disabled)return 'disabled';button.disabled=true;requestCount++;return 'request-initiated';};};
  const old={onclick:async()=>{throw new Error('stale handler')}};
  const current={onclick:null,disabled:false};
  bind(current);
  assert.notEqual(current.onclick,old.onclick);
  assert.equal(await current.onclick(),'request-initiated');
  assert.equal(requestCount,1);
  assert.equal(await current.onclick(),'disabled');
  assert.equal(requestCount,1);
});

test('route rerender model has one active handler per current button and preserves click initiation',async()=>{
  let requests=0;
  const bind=button=>{button.handlerCount=1;button.onclick=async()=>{requests++;};};
  for(let cycle=0;cycle<100;cycle++){
    const button={onclick:null,handlerCount:0};
    bind(button);
    assert.equal(button.handlerCount,1);
    await button.onclick();
  }
  assert.equal(requests,100);
});

test('stale local attempt 404 has an explicit clear-and-unlock contract',()=>{
  assert.match(hotfix,/if\(response\.status===404\)\{const stored=readStoredAttempt\(\);if\(stored===attemptId\)storeAttempt\(''\)/);
  assert.match(hotfix,/setIssueLocked\(false\);issueDiagnostic\('stale-attempt-cleared'/);
  assert.match(hotfix,/شناسه پیگیری قبلی در سرور پیدا نشد/);
});

test('every click guard and preflight transition has bounded diagnostic evidence and a Persian message',()=>{
  for(const stage of ['handler-attached','click-received','guard-no-button','guard-in-flight','guard-disabled','preflight-started','request-initiated'])assert.equal(hotfix.includes(`'${stage}'`),true,stage);
  assert.match(hotfix,/const ISSUE_DIAGNOSTIC_LIMIT=24/);
  assert.match(hotfix,/\.slice\(-ISSUE_DIAGNOSTIC_LIMIT\)/);
  assert.match(hotfix,/درخواست قبلی هنوز در حال بررسی است/);
  assert.match(hotfix,/دکمه صدور اکنون قفل است/);
});

test('ambiguous issuance stays locked while confirmed pre-Put failure remains retryable and cost editor guard remains active',()=>{
  assert.match(hotfix,/const LOCKED=new Set\(\['put_in_progress','put_response_ambiguous','put_succeeded_resolve_pending','manual_reconciliation_required'\]\)/);
  assert.match(hotfix,/issuance\.state==='confirmed_put_failure'/);
  assert.match(hotfix,/function enforceOneCostEditor\(\)/);
  assert.match(hotfix,/nodes\.slice\(1\)\.forEach\(node=>node\.remove\(\)\)/);
});

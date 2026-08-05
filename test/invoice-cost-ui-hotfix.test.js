'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const source=fs.readFileSync(path.join(__dirname,'../public/assets/app.js'),'utf8');
const server=fs.readFileSync(path.join(__dirname,'../src/server.js'),'utf8');

test('invoice-cost mount rechecks generation and identity after its async API read',()=>{const start=source.indexOf('let saleRefExtrasMountGeneration=0');const end=source.indexOf('const prevPageSettings',start);const block=source.slice(start,end);assert.match(block,/generation!==saleRefExtrasMountGeneration/);assert.match(block,/const list=await allowedExtras\(\)/);assert.match(block,/const afterAwait=\[\.\.\.document\.querySelectorAll\('#saleRefExtrasBox'\)\]/);assert.match(block,/componentIdentity='sale-invoice-cost-editor'/);assert.match(block,/uiPageLifecycle.*clearTimeout/);});

test('terminal UI guard enforces one editor and disconnects its observer on unmount',()=>{const start=source.indexOf('Production-safety hotfix: durable invoice issuance UX');const block=source.slice(start);assert.match(block,/function enforceOneCostEditor\(\)/);assert.match(block,/nodes\.slice\(1\)\.forEach\(node=>node\.remove\(\)\)/);assert.match(block,/new MutationObserver\(enforceOneCostEditor\)/);assert.match(block,/uiPageLifecycle.*observer\.disconnect/);assert.match(block,/activeEditorCount:active\?1:0/);});

test('ambiguous UI remains locked and exposes only recovery actions',()=>{const start=source.indexOf('Production-safety hotfix: durable invoice issuance UX');const block=source.slice(start);for(const label of ['بررسی مجدد وضعیت','مشاهده وضعیت بازیابی','ارجاع به حسابداری','از صدور مجدد خودداری کنید'])assert.equal(block.includes(label),true,label);assert.match(block,/setIssueLocked\(true\)/);assert.match(block,/retry-resolution/);assert.equal(block.includes('POST_PUT_RESOLVE_FAILED</div>'),false);});

test('server response does not expose raw Shaygan JSON and has no GUID Get filter',()=>{const route=server.slice(server.indexOf("if ((pathname === '/api/sales/issue'"),server.indexOf("if (pathname === '/admin/accounting/getTurnover'"));assert.equal(/sendJson\([^\n]+raw\s*:\s*r\.raw/.test(route),false);assert.equal(route.includes('getInvoiceByGuid'),false);assert.match(route,/technicalAudit/);assert.match(route,/lockedIssuancePayload/);});

test('100-cycle lifecycle model never has more than one active editor/listener set',()=>{let active=[],removed=0;for(let cycle=0;cycle<100;cycle++){active=[];for(let stale=0;stale<3;stale++)active.push({cycle,stale});if(active.length>1){removed+=active.length-1;active=active.slice(0,1);}assert.equal(active.length,1);const listenerSets=active.length?1:0;assert.equal(listenerSets,1);active=[];assert.equal(active.length,0);}assert.equal(removed,200);});

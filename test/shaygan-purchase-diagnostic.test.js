'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const d = require('../scripts/diagnose-shaygan-purchase-invoices');
const shaygan = require('../src/lib/shaygan');

let tests=0;
async function test(name,fn){await fn();tests++;process.stderr.write(`ok ${tests} - ${name}\n`);}
function rejects(fn,code){assert.throws(fn,e=>e&&e.code===code);}
function inv(overrides={}){
  return {
    InvTyp:3,InvNo:1234,GuId:'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',InvDate:'14050101',
    AccountNumber:'SUP-1',AccountName:'Supplier',CurrencyAbb1:'IRR',Rate:1,DiscAmount:0,
    CurrentVersion:'7',LastIssuerUsername:'user-a',RowVersionAsNumber:10,UpdateKind:0,
    Body:[{LineItemId:11,ItemNumber:'I-1',ItemDescription:'Item',STNumber:'1',Quan:2,Quan2:0,Price:100,Price2:0,Amount:200,LineDiscAmount:0,LineDiscPer:0,ReturnRial:0,UpdateKind:0}],
    ...overrides
  };
}
function apiExact(sequence){
  let i=0;
  return {getInvoice:async()=>({ok:true,status:200,list:[sequence[Math.min(i++,sequence.length-1)]]})};
}

(async()=>{
  await test('rejects unsupported InvTyp',()=>rejects(()=>d.parseArgs(['exact','--type','4','--invoice-no','1']), 'INVALID_INVOICE_TYPE'));
  await test('validates rowCount limits',()=>rejects(()=>d.parseArgs(['page','--type','3','--start-date','14050101','--end-date','14050102','--row-start','0','--row-count','21']), 'INVALID_INPUT'));
  await test('validates maxPages limits',()=>rejects(()=>d.parseArgs(['paging','--type','3','--start-date','14050101','--end-date','14050102','--row-count','20','--max-pages','26','--max-invoices','1']), 'INVALID_INPUT'));
  await test('validates maxInvoices limits',()=>rejects(()=>d.parseArgs(['paging','--type','3','--start-date','14050101','--end-date','14050102','--row-count','20','--max-pages','1','--max-invoices','501']), 'INVALID_INPUT'));
  await test('validates reads limits',()=>rejects(()=>d.parseArgs(['repeat','--type','3','--invoice-no','1','--reads','6']), 'INVALID_INPUT'));
  await test('validates interval limits',()=>rejects(()=>d.parseArgs(['repeat','--type','3','--invoice-no','1','--reads','2','--interval-ms','5001']), 'INVALID_INPUT'));
  await test('validates timeout limits',()=>rejects(()=>d.parseArgs(['exact','--type','3','--invoice-no','1','--timeout-ms','999']), 'INVALID_INPUT'));
  await test('validates date shape and order',()=>{
    rejects(()=>d.parseArgs(['page','--type','3','--start-date','1405010','--end-date','14050102','--row-start','0','--row-count','20']), 'INVALID_DATE');
    rejects(()=>d.parseArgs(['page','--type','3','--start-date','14050103','--end-date','14050102','--row-start','0','--row-count','20']), 'INVALID_DATE_RANGE');
  });
  await test('rejects unknown option',()=>rejects(()=>d.parseArgs(['exact','--type','3','--invoice-no','1','--wat','x']), 'UNKNOWN_OPTION'));
  await test('normal exact response',async()=>{
    const r=await d.exactOperation({type:3,invoiceNo:1234,hydrate:false,timeoutMs:1000,provisionalThreshold:1},apiExact([inv()]));
    assert.equal(r.ok,true);assert.equal(r.invoice.lines.length,1);assert.equal(r.transport.requestCount,1);
  });
  await test('header-only without hydrate',async()=>{
    const r=await d.exactOperation({type:3,invoiceNo:1234,hydrate:false,timeoutMs:1000,provisionalThreshold:1},apiExact([inv({Body:[]})]));
    assert.equal(r.contract.headerOnlyInitialResponse,true);assert(r.warnings.some(x=>x.code==='HEADER_ONLY_RESPONSE'));
  });
  await test('header-only hydrates once',async()=>{
    const r=await d.exactOperation({type:3,invoiceNo:1234,hydrate:true,timeoutMs:1000,provisionalThreshold:1},apiExact([inv({Body:[]}),inv()]));
    assert.equal(r.contract.hydrated,true);assert.equal(r.transport.requestCount,2);
  });
  await test('hydrate failure warning',async()=>{
    const r=await d.exactOperation({type:3,invoiceNo:1234,hydrate:true,timeoutMs:1000,provisionalThreshold:1},apiExact([inv({Body:[]})]));
    assert(r.warnings.some(x=>x.code==='HYDRATION_FAILED'));assert.equal(r.transport.requestCount,2);
  });
  await test('GUID mismatch is contract error',async()=>{
    await assert.rejects(()=>d.exactGuidOperation({type:3,guid:'ffffffff-ffff-ffff-ffff-ffffffffffff',timeoutMs:1000,provisionalThreshold:1},{getInvoiceByGuid:async()=>({ok:true,status:200,list:[inv()]})}),e=>e.code==='GUID_MISMATCH'&&e.exitCode===3);
  });
  await test('exact-guid Domain sends only GuId GUID field',async()=>{
    const originalFetch=global.fetch;let requestBody;
    global.fetch=async(_url,opts)=>{requestBody=JSON.parse(opts.body);return {ok:true,status:200,json:async()=>({Result:[]})};};
    try{await shaygan.getInvoiceByGuid('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',3,{timeoutMs:1000});}
    finally{global.fetch=originalFetch;}
    assert.deepEqual(requestBody.Domain.GuId,{From:'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',To:'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',In:[]});
    for(const key of ['Guid','InvGuId','InvHeaderGuId','InvHeaderGuid'])assert.equal(Object.hasOwn(requestBody.Domain,key),false);
  });
  await test('exact-guid transport error exposes sanitised status and actual error',async()=>{
    await assert.rejects(
      ()=>d.exactGuidOperation({type:3,guid:'ffffffff-ffff-ffff-ffff-ffffffffffff',timeoutMs:1000,provisionalThreshold:1},{getInvoiceByGuid:async()=>({ok:false,status:502,error:'upstream unavailable ConnectionName=RealName TokenString=real-token'})}),
      e=>e.code==='TRANSPORT_ERROR'&&e.details.status===502&&e.details.error.includes('upstream unavailable')&&e.details.error.includes('ConnectionName=[REDACTED]')&&!e.details.error.includes('RealName')&&!e.details.error.includes('real-token')
    );
  });
  await test('invoice number mismatch is contract error',async()=>{
    await assert.rejects(()=>d.exactOperation({type:3,invoiceNo:999,hydrate:false,timeoutMs:1000,provisionalThreshold:1},apiExact([inv()])),e=>e.code==='INVOICE_NUMBER_MISMATCH');
  });
  await test('duplicate LineItemId warning',()=>{
    const x=d.sanitizedInvoice(inv({Body:[inv().Body[0],{...inv().Body[0],ItemNumber:'I-2'}]}),1);
    assert(x.warnings.some(w=>w.code==='DUPLICATE_LINE_ITEM_ID'));
  });
  await test('missing LineItemId warning',()=>{
    const line={...inv().Body[0]};delete line.LineItemId;
    assert(d.sanitizedInvoice(inv({Body:[line]}),1).warnings.some(w=>w.code==='LINE_ITEM_ID_MISSING'));
  });
  await test('missing ItemNumber warning',()=>{
    const line={...inv().Body[0]};delete line.ItemNumber;
    assert(d.sanitizedInvoice(inv({Body:[line]}),1).warnings.some(w=>w.code==='ITEM_NUMBER_MISSING'));
  });
  await test('price zero warning differs from price one',()=>{
    const x=d.sanitizedInvoice(inv({Body:[{...inv().Body[0],Price:0,Amount:0}]}),1);
    assert(x.warnings.some(w=>w.code==='PRICE_ZERO'));assert(!x.warnings.some(w=>w.code==='PRICE_ONE'));
  });
  await test('price one observations',()=>{
    const x=d.sanitizedInvoice(inv({Body:[{...inv().Body[0],Quan:1,Price:1,Amount:1}]}),1);
    assert(x.warnings.some(w=>w.code==='PRICE_ONE'));assert(x.warnings.some(w=>w.code==='AMOUNT_ONE'));assert(x.warnings.some(w=>w.code==='DERIVED_UNIT_COST_ONE'));
  });
  await test('mixed provisional lines',()=>{
    const x=d.sanitizedInvoice(inv({Body:[{...inv().Body[0],LineItemId:1,Price:1,Amount:2},{...inv().Body[0],LineItemId:2,Price:10,Amount:20}]}),1);
    assert.equal(x.contract.mixedProvisionalAndFinalLines,true);assert(x.warnings.some(w=>w.code==='MIXED_PROVISIONAL_COST'));
  });
  await test('unsafe numeric warning',()=>{
    const x=d.sanitizedInvoice(inv({Body:[{...inv().Body[0],Amount:Number.MAX_SAFE_INTEGER+10}]}),1);
    assert(x.warnings.some(w=>w.code==='UNSAFE_NUMERIC_VALUE'));
  });
  await test('normal decimal does not trigger unsafe numeric warning',()=>{
    const x=d.sanitizedInvoice(inv({Body:[{...inv().Body[0],Price:951860416.64,Amount:1903720833.28}]}),1);
    assert(!x.warnings.some(w=>w.code==='UNSAFE_NUMERIC_VALUE'));
  });
  await test('NaN and Infinity trigger unsafe numeric warnings without breaking hashes',()=>{
    const x=d.sanitizedInvoice(inv({Body:[{...inv().Body[0],Price:NaN,Amount:Infinity}]}),1);
    assert.equal(x.warnings.filter(w=>w.code==='UNSAFE_NUMERIC_VALUE').length,2);
    assert.match(x.hashes.fullHash,/^[a-f0-9]{64}$/);
  });
  await test('tiny amount difference is within tolerance',()=>{
    const x=d.sanitizedInvoice(inv({Body:[{...inv().Body[0],Quan:3,Price:0.1,Amount:0.3000000001}]}),1);
    assert(!x.warnings.some(w=>w.code==='AMOUNT_INCONSISTENT'));
  });
  await test('real amount difference still warns',()=>{
    const x=d.sanitizedInvoice(inv({Body:[{...inv().Body[0],Quan:3,Price:10,Amount:31}]}),1);
    assert(x.warnings.some(w=>w.code==='AMOUNT_INCONSISTENT'));
  });
  await test('AmortizePercent is exposed as allocatedExpenseAmount observation',()=>{
    const x=d.sanitizedInvoice(inv({Body:[{...inv().Body[0],AmortizePercent:1250.5}]}),1);
    assert.equal(x.invoice.lines[0].AmortizePercent,1250.5);
    assert.equal(x.observations[0].allocatedExpenseAmount,1250.5);
  });
  await test('redacts nested secrets',()=>{
    const warnings=[],x=d.redact({a:{TokenString:'secret',ok:1}},warnings);
    assert.equal(x.a.TokenString,'[REDACTED]');assert(warnings.some(w=>w.code==='SENSITIVE_FIELD_REDACTED'));
  });
  await test('redacts secrets in arrays',()=>{
    const x=d.redact([{authorization:'secret'}],[]);
    assert.equal(x[0].authorization,'[REDACTED]');
  });
  await test('sanitised invoice omits TokenString',()=>{
    const x=d.sanitizedInvoice(inv({TokenString:'secret',Body:[{...inv().Body[0],token:'secret'}]}),1);
    assert(!JSON.stringify(x).toLowerCase().includes('secret'));
    assert(!JSON.stringify(x.invoice).toLowerCase().includes('tokenstring'));
  });
  await test('canonical hash deterministic',()=>assert.equal(d.sha({b:2,a:1}),d.sha({a:1,b:2})));
  await test('line order does not alter hashes',()=>{
    const a={...inv().Body[0],LineItemId:1,ItemNumber:'A'},b={...inv().Body[0],LineItemId:2,ItemNumber:'B'};
    const x=d.sanitizedInvoice(inv({Body:[a,b]}),1),y=d.sanitizedInvoice(inv({Body:[b,a]}),1);
    assert.equal(x.hashes.fullHash,y.hashes.fullHash);assert.equal(x.hashes.accountingHash,y.hashes.accountingHash);
  });
  await test('price change changes accounting hash',()=>{
    const x=d.sanitizedInvoice(inv(),1),y=d.sanitizedInvoice(inv({Body:[{...inv().Body[0],Price:101}]}),1);
    assert.notEqual(x.hashes.accountingHash,y.hashes.accountingHash);
  });
  await test('issuer change does not change accounting hash',()=>{
    const x=d.sanitizedInvoice(inv(),1),y=d.sanitizedInvoice(inv({LastIssuerUsername:'other'}),1);
    assert.equal(x.hashes.accountingHash,y.hashes.accountingHash);
  });
  await test('GUID change changes identity hash',()=>{
    const x=d.sanitizedInvoice(inv(),1),y=d.sanitizedInvoice(inv({GuId:'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'}),1);
    assert.notEqual(x.hashes.identityHash,y.hashes.identityHash);
  });
  await test('short page followed by data',async()=>{
    const pages=[[inv()],[inv({InvNo:1235,GuId:'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'})],[]];let i=0;
    const r=await d.pagingOperation({type:3,startDate:'14050101',endDate:'14050102',rowCount:2,maxPages:3,maxInvoices:10,hydrate:false,timeoutMs:1000,provisionalThreshold:1},{getInvoicePageByDate:async()=>({ok:true,status:200,result:pages[i++]})});
    assert.equal(r.summary.shortPageFollowedByData,true);assert.equal(r.summary.stoppedBy,'EMPTY_PAGE');
  });
  await test('empty page terminates naturally',async()=>{
    const r=await d.pagingOperation({type:3,startDate:'14050101',endDate:'14050102',rowCount:20,maxPages:2,maxInvoices:10,hydrate:false,timeoutMs:1000,provisionalThreshold:1},{getInvoicePageByDate:async()=>({ok:true,status:200,result:[]})});
    assert.equal(r.summary.complete,true);assert.equal(r.summary.stoppedBy,'EMPTY_PAGE');
  });
  await test('maxPages is incomplete safety stop',async()=>{
    const r=await d.pagingOperation({type:3,startDate:'14050101',endDate:'14050102',rowCount:20,maxPages:1,maxInvoices:10,hydrate:false,timeoutMs:1000,provisionalThreshold:1},{getInvoicePageByDate:async()=>({ok:true,status:200,result:[inv()]})});
    assert.equal(r.summary.complete,false);assert.equal(r.summary.stoppedBy,'MAX_PAGES');assert(r.warnings.some(w=>w.code==='SAFETY_LIMIT_REACHED'));assert.equal(d.exitCodeForResult('paging',r),4);
  });
  await test('duplicate invoice and line across pages',async()=>{
    let i=0;const pages=[[inv()],[inv()],[]];
    const r=await d.pagingOperation({type:3,startDate:'14050101',endDate:'14050102',rowCount:1,maxPages:3,maxInvoices:10,hydrate:false,timeoutMs:1000,provisionalThreshold:1},{getInvoicePageByDate:async()=>({ok:true,status:200,result:pages[i++]})});
    assert.equal(r.summary.duplicateInvoiceCount,1);assert.equal(r.summary.duplicateLineCount,1);
  });
  await test('compare added lines',()=>{
    const a=d.sanitizedInvoice(inv(),1),b=d.sanitizedInvoice(inv({Body:[...inv().Body,{...inv().Body[0],LineItemId:12,ItemNumber:'I-2'}]}),1);
    assert.equal(d.compareSnapshots(a,b).changes.linesAdded.length,1);
  });
  await test('compare removed lines',()=>{
    const a=d.sanitizedInvoice(inv({Body:[...inv().Body,{...inv().Body[0],LineItemId:12,ItemNumber:'I-2'}]}),1),b=d.sanitizedInvoice(inv(),1);
    assert.equal(d.compareSnapshots(a,b).changes.linesRemoved.length,1);
  });
  await test('compare changed lines and metadata signals',()=>{
    const a=d.sanitizedInvoice(inv(),1),b=d.sanitizedInvoice(inv({LastIssuerUsername:'user-b',Body:[{...inv().Body[0],Price:110}]}),1),r=d.compareSnapshots(a,b);
    assert.equal(r.changes.linesChanged.length,1);assert.equal(r.accountingHashChanged,true);assert.equal(r.versionSignals.LastIssuerUsername.changed,true);
  });
  await test('compare detects unstable page order',()=>{
    const one={invoiceType:3,invoiceNo:1,invoiceGuid:'a'},two={invoiceType:3,invoiceNo:2,invoiceGuid:'b'};
    const left={operation:'paging',summary:{sequence:[one,two],sequenceHash:d.sha([one,two])}},right={operation:'paging',summary:{sequence:[two,one],sequenceHash:d.sha([two,one])}};
    const r=d.compareSnapshots(left,right);assert.equal(r.ordering.sameContent,true);assert.equal(r.ordering.orderingChanged,true);assert(r.warnings.some(w=>w.code==='UNSTABLE_PAGE_ORDER'));
  });
  await test('invalid compare JSON rejected',()=>{
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mkcrm-diag-')),file=path.join(dir,'bad.json');fs.writeFileSync(file,'{');
    rejects(()=>d.readJsonFile(file),'INVALID_JSON');fs.rmSync(dir,{recursive:true,force:true});
  });
  await test('oversized compare file rejected',()=>{
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mkcrm-diag-')),file=path.join(dir,'large.json'),fd=fs.openSync(file,'w');fs.ftruncateSync(fd,d.MAX_FILE_BYTES+1);fs.closeSync(fd);
    rejects(()=>d.readJsonFile(file),'FILE_TOO_LARGE');fs.rmSync(dir,{recursive:true,force:true});
  });
  await test('CLI stdout contains one valid JSON document',()=>{
    const p=spawnSync(process.execPath,[path.resolve(__dirname,'../scripts/diagnose-shaygan-purchase-invoices.js'),'exact','--type','4','--invoice-no','1'],{encoding:'utf8'});
    const lines=p.stdout.trim().split(/\r?\n/);assert.equal(lines.length,1);assert.doesNotThrow(()=>JSON.parse(lines[0]));assert.equal(p.status,1);
  });
  process.stderr.write(`# ${tests} tests passed\n`);
})().catch(e=>{process.stderr.write(`${e.stack||e}\n`);process.exitCode=1;});

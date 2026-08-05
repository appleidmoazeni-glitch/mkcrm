'use strict';

const assert = require('node:assert/strict');
const { resolveIssuedInvoiceAfterPut } = require('../src/lib/post-put-invoice-resolver');

let tests=0;
async function test(name,fn){await fn();tests++;process.stderr.write(`ok ${tests} - ${name}\n`);}
const formatDate8=()=> '14050105';
const issuedAt=Date.parse('2026-07-26T10:00:00Z');
const body={
  invDate:'14050105',crmId:'CRM-1',
  items:[
    {itemCode:'I-1',stockNumber:'1',quantity:2,price:100},
    {itemCode:'I-2',stockNumber:'1',quantity:1,price:50}
  ]
};
const mapping={cashboxAccountNumber:'CASH-1',employeeAccountNumber:'SELLER-1',fullName:'Seller'};
function candidate(overrides={}){
  return {
    InvTyp:2,InvNo:100,GuId:'guid-expected',InvDate:'14050105',
    AccountNumber:'CASH-1',SAccountNumber:'SELLER-1',InvDescription:'CRM-1',
    CreatedDate:'2026-07-26T10:01:00Z',FirstIssuerUsername:'Seller',
    Body:[
      {ItemNumber:'I-1',STNumber:'1',Quan:2,Price:100,Amount:200},
      {ItemNumber:'I-2',STNumber:'1',Quan:1,Price:50,Amount:50}
    ],
    ...overrides
  };
}
function api({pages=[],verified={}}={}){
  let pageIndex=0;
  const calls={pages:[],exact:[],guid:0};
  return {
    calls,
    getInvoicePageByDate:async(...args)=>{
      calls.pages.push(args);
      const page=pages[pageIndex++]||[];
      return Array.isArray(page)?{ok:true,result:page}:{ok:true,...page};
    },
    getInvoice:async(no,type)=>{calls.exact.push([no,type]);return {ok:true,list:[verified]};},
    getInvoiceByGuid:async()=>{calls.guid++;throw new Error('unsupported GUID lookup called');}
  };
}
function request(issueResponse,shaygan,extra={}){
  return resolveIssuedInvoiceAfterPut({issueResponse,body,mapping,invoiceType:2,crmId:'CRM-1',shaygan,formatDate8,issuedAt,maxPages:5,rowCount:20,...extra});
}

(async()=>{
  await test('direct invoice number returns without lookup',async()=>{
    const shaygan=api(),r=await request({result:[{Number:321,GuId:'direct-guid'}]},shaygan);
    assert.equal(r.ok,true);assert.equal(r.invoiceNumber,321);assert.equal(r.method,'put-response');
    assert.equal(shaygan.calls.pages.length,0);assert.equal(shaygan.calls.exact.length,0);assert.equal(shaygan.calls.guid,0);
  });
  await test('zero number resolves by date and final exact verification',async()=>{
    const c=candidate(),shaygan=api({pages:[[c],[]],verified:{...c,Body:[...c.Body,{ItemNumber:'DETAIL',STNumber:'1',Quan:1,Price:1,Amount:1}]}});
    const r=await request({result:[{Number:0,GuId:'guid-expected'}]},shaygan);
    assert.equal(r.ok,true);assert.equal(r.invoiceNumber,100);assert.equal(r.method,'date-search-verified');
    assert.equal(r.result.Body.length,3);assert.deepEqual(shaygan.calls.exact,[[100,2]]);assert.equal(shaygan.calls.guid,0);
  });
  await test('best of multiple candidates is verified',async()=>{
    const weak=candidate({InvNo:101,GuId:'other-guid',InvDescription:'',CreatedDate:'2026-07-25T08:00:00Z'});
    const strong=candidate({InvNo:102}),shaygan=api({pages:[[weak,strong],[]],verified:strong});
    const r=await request({result:[{Number:0,GuId:'guid-expected'}]},shaygan);
    assert.equal(r.ok,true);assert.equal(r.invoiceNumber,102);assert(r.candidateCount>=2);assert(r.matchReasons.includes('guid'));
    assert.deepEqual(shaygan.calls.exact,[[102,2]]);
  });
  await test('multiple equally reliable candidates require manual reconciliation',async()=>{
    const first=candidate({InvNo:103,GuId:''}),second=candidate({InvNo:104,GuId:''}),shaygan=api({pages:[[first,second],[]],verified:first});
    const r=await request({result:[{Number:0,GuId:''}]},shaygan);
    assert.equal(r.ok,false);assert.equal(r.code,'POST_PUT_RESOLVE_FAILED');assert.equal(r.failureStage,'multiple-candidates');assert.equal(r.candidateCount,2);assert.equal(shaygan.calls.exact.length,0);
  });
  await test('wrong candidate fails identity verification',async()=>{
    const best=candidate(),verified=candidate({GuId:'different-guid'}),shaygan=api({pages:[[best],[]],verified});
    const r=await request({result:[{Number:0,GuId:'guid-expected'}]},shaygan);
    assert.equal(r.ok,false);assert.equal(r.code,'POST_PUT_RESOLVE_FAILED');assert.equal(r.failureStage,'identity-verification');
  });
  await test('no valid candidate returns POST_PUT_RESOLVE_FAILED',async()=>{
    const wrong=candidate({InvNo:200,GuId:'wrong',AccountNumber:'OTHER',SAccountNumber:'OTHER',InvDescription:'',InvDate:'14040101',Body:[]});
    const shaygan=api({pages:[[wrong],[]],verified:wrong}),r=await request({result:[{Number:0,GuId:'guid-expected'}]},shaygan);
    assert.equal(r.ok,false);assert.equal(r.code,'POST_PUT_RESOLVE_FAILED');assert.equal(r.failureStage,'candidate-search');assert.equal(shaygan.calls.exact.length,0);
  });
  await test('short page does not stop search',async()=>{
    const wrong=candidate({InvNo:201,GuId:'wrong',AccountNumber:'OTHER',SAccountNumber:'OTHER',InvDescription:'',InvDate:'14040101',Body:[]});
    const good=candidate({InvNo:202}),shaygan=api({pages:[[wrong],[good],[]],verified:good});
    const r=await request({result:[{Number:0,GuId:'guid-expected'}]},shaygan);
    assert.equal(r.ok,true);assert.equal(r.invoiceNumber,202);assert.equal(shaygan.calls.pages.length,3);
    assert.deepEqual(shaygan.calls.pages.map(x=>x[0]),[0,20,40]);
  });
  await test('final verification rejects wrong invoice number',async()=>{
    const best=candidate({InvNo:300}),verified=candidate({InvNo:301}),shaygan=api({pages:[[best],[]],verified});
    const r=await request({result:[{Number:0,GuId:'guid-expected'}]},shaygan);
    assert.equal(r.ok,false);assert.equal(r.code,'POST_PUT_RESOLVE_FAILED');assert.equal(r.failureStage,'final-verification');
    assert(r.attempts.some(x=>x.method==='final-verification'));
  });
  await test('TotalRecords in first result reads all expected pages',async()=>{
    const first=candidate({InvNo:401,GuId:'wrong',TotalRecords:45}),last=candidate({InvNo:403});
    const shaygan=api({pages:[[first],[candidate({InvNo:402,GuId:'wrong'})],[last]],verified:last});
    const r=await request({result:[{Number:0,GuId:'guid-expected'}]},shaygan,{maxPages:1});
    assert.equal(r.ok,true);assert.equal(r.invoiceNumber,403);assert.equal(shaygan.calls.pages.length,3);
    assert.deepEqual(r.paging,{totalRecords:45,rowCount:20,expectedPages:3,pagesRead:3,pagingMode:'total-records'});
  });
  await test('short middle page does not stop TotalRecords paging',async()=>{
    const good=candidate({InvNo:502}),shaygan=api({pages:[
      {totalRecords:41,result:[candidate({InvNo:500,GuId:'wrong'})]},
      [candidate({InvNo:501,GuId:'wrong'})],
      [good]
    ],verified:good});
    const r=await request({result:[{Number:0,GuId:'guid-expected'}]},shaygan);
    assert.equal(r.ok,true);assert.equal(shaygan.calls.pages.length,3);assert.equal(r.paging.pagesRead,3);
  });
  await test('TotalRecords stops exactly at expectedPages without extra read',async()=>{
    const good=candidate({InvNo:602}),shaygan=api({pages:[
      {raw:{TotalRecords:'21'},result:[candidate({InvNo:601,GuId:'wrong'})]},
      [good],
      [candidate({InvNo:603})]
    ],verified:good});
    const r=await request({result:[{Number:0,GuId:'guid-expected'}]},shaygan);
    assert.equal(r.ok,true);assert.equal(shaygan.calls.pages.length,2);
    assert.equal(r.paging.expectedPages,2);assert.equal(r.paging.pagesRead,2);
  });
  await test('missing TotalRecords uses defensive fallback',async()=>{
    const good=candidate({InvNo:702}),shaygan=api({pages:[
      [candidate({InvNo:701,GuId:'wrong'})],
      [good],
      []
    ],verified:good});
    const r=await request({result:[{Number:0,GuId:'guid-expected'}]},shaygan);
    assert.equal(r.ok,true);assert.equal(shaygan.calls.pages.length,3);
    assert.deepEqual(r.paging,{totalRecords:null,rowCount:20,expectedPages:null,pagesRead:3,pagingMode:'fallback'});
  });
  await test('TotalRecords zero reads no additional page',async()=>{
    const shaygan=api({pages:[{TotalRecords:0,result:[]}]});
    const r=await request({result:[{Number:0,GuId:'guid-expected'}]},shaygan);
    assert.equal(r.ok,false);assert.equal(r.code,'POST_PUT_RESOLVE_FAILED');assert.equal(shaygan.calls.pages.length,1);
    assert.deepEqual(r.paging,{totalRecords:0,rowCount:20,expectedPages:0,pagesRead:1,pagingMode:'total-records'});
  });
  process.stderr.write(`# ${tests} tests passed\n`);
})().catch(e=>{process.stderr.write(`${e.stack||e}\n`);process.exitCode=1;});

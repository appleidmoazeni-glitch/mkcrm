'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

const source=fs.readFileSync(path.join(__dirname,'../public/assets/app.js'),'utf8');
const server=fs.readFileSync(path.join(__dirname,'../src/server.js'),'utf8');
const start=source.indexOf('/* Production-safety hotfix: durable invoice issuance UX');
const end=source.indexOf('/* Financial operations navigation',start);
const hotfix=source.slice(start,end);

function storage(initial={}){
  const values=new Map(Object.entries(initial));
  return{getItem:key=>values.has(key)?values.get(key):null,setItem:(key,value)=>values.set(key,String(value)),removeItem:key=>values.delete(key),has:key=>values.has(key),value:key=>values.get(key)};
}
function element(){return{disabled:false,textContent:'',innerHTML:'',value:'',dataset:{},onclick:null,querySelector:()=>null,selectedOptions:[],isConnected:true};}
function harness({fetchImpl}={}){
  const elements=new Map([['#issueBtn',element()],['#saleOut',element()],['#buyerName',element()],['#buyerMobile',element()],['#buyerNational',element()],['#leadId',element()],['#saleQ',element()],['#saleSelected',element()],['#STNumber',element()],['#Quan',element()],['#Price',element()],['#saleGeneralRef',element()],['#saleDiscount',element()],['#saleInventory',element()],['#serialBox',element()],['#priceWarn',element()],['#saleExtrasRows',element()],['#content',element()],['#logoutBtn',element()]]);
  elements.get('#Quan').value='1';elements.get('#saleDiscount').value='0';
  const localStorage=storage(),sessionStorage=storage();
  const listeners={};
  const state={user:{username:'seller-a'},saleLines:[],selectedItem:null,selectedStock:null,selectedSerials:[],serialInfo:null,invoiceNumber:null,selectedMapping:{username:'seller-a',cashboxAccountNumber:'CASH',employeeAccountNumber:'SELLER'}};
  const context={
    state,localStorage,sessionStorage,location:{hash:'#sale'},crypto:{randomUUID:()=>`uuid-${Math.random()}`},
    document:{querySelector:selector=>elements.get(selector)||null,querySelectorAll:()=>[]},
    window:{addEventListener:(name,fn)=>{listeners[name]=fn;}},
    MutationObserver:class{observe(){}disconnect(){}},uiPageLifecycle:{add(){}},
    esc:value=>String(value),renderSaleLines(){},setTimeout:()=>1,clearTimeout(){},
    fetch:fetchImpl||(async()=>({status:200,json:async()=>({ok:true,issuance:null})})),
    pageSale:async()=>{},shell(){},console,Math,Date,JSON,Number,String,Boolean,Array,Object,Set,Promise,encodeURIComponent
  };
  context.window.window=context.window;context.window.pageSale=context.pageSale;context.window.shell=context.shell;context.window.addEventListener=context.window.addEventListener;
  Object.assign(context.window,{state,document:context.document,location:context.location});
  vm.createContext(context);vm.runInContext(hotfix,context);
  return{...context,elements,listeners,api:context.window.__saleIssuanceHotfix};
}

test('successful resolved status exposes print, view, and new-invoice actions',async()=>{
  const h=harness({fetchImpl:async()=>({status:200,json:async()=>({ok:true,issuance:{issuanceAttemptId:'sale:A',state:'resolved',resolved:true,invoiceNumber:123,printUrl:'/print/invoice/123'}})})});
  await h.api.refreshStatus('sale:A');
  const output=h.elements.get('#saleOut').innerHTML;
  for(const text of ['چاپ','مشاهده فاکتور','صدور فاکتور جدید'])assert.match(output,new RegExp(text));
  assert.equal(h.elements.get('#issueBtn').disabled,true);
});

test('new invoice reset clears all prior identity, lines, serials, lock, and persisted draft state',async()=>{
  const h=harness();
  Object.assign(h.state,{saleLines:[{itemCode:'OLD'}],selectedItem:{itemCode:'OLD'},selectedStock:{stockNumber:'1'},selectedSerials:['S'],serialInfo:{x:1},invoiceNumber:123,saleIssued:true,saleIssueInFlight:true,saleIssueKey:'sale:OLD'});
  h.localStorage.setItem('mkcrm.activeSaleIssuance.seller-a','sale:OLD');h.sessionStorage.setItem('mkcrm.pageState.seller-a.sale','old');
  h.elements.get('#buyerName').value='Old customer';h.elements.get('#leadId').value='OLD-LEAD';h.elements.get('#saleGeneralRef').value='OLD-REF';h.elements.get('#saleExtrasRows').innerHTML='old cost';
  await h.api.resetForNewDraft();
  assert.equal(h.state.saleLines.length,0);assert.equal(h.state.selectedItem,null);assert.equal(h.state.selectedStock,null);assert.equal(h.state.selectedSerials.length,0);assert.equal(h.state.serialInfo,null);assert.equal(h.state.invoiceNumber,null);assert.equal(h.state.saleIssued,false);assert.equal(h.state.saleIssueInFlight,false);assert.notEqual(h.state.saleIssueKey,'sale:OLD');
  assert.equal(h.localStorage.has('mkcrm.activeSaleIssuance.seller-a'),false);assert.equal(h.sessionStorage.has('mkcrm.pageState.seller-a.sale'),false);assert.equal(h.elements.get('#buyerName').value,'');assert.equal(h.elements.get('#leadId').value,'');assert.equal(h.elements.get('#saleGeneralRef').value,'');assert.equal(h.elements.get('#saleExtrasRows').innerHTML,'');
});

test('logout cleanup is user-scoped and removes only transient sale persistence',()=>{
  const h=harness();h.localStorage.setItem('mkcrm.activeSaleIssuance.seller-a','sale:OLD');h.localStorage.setItem('preference','keep');h.sessionStorage.setItem('mkcrm.pageState.seller-a.sale','old');h.sessionStorage.setItem('mkcrm.pageState.seller-a.stocks','keep');
  h.api.clearUserState();
  assert.equal(h.localStorage.has('mkcrm.activeSaleIssuance.seller-a'),false);assert.equal(h.sessionStorage.has('mkcrm.pageState.seller-a.sale'),false);assert.equal(h.localStorage.value('preference'),'keep');assert.equal(h.sessionStorage.value('mkcrm.pageState.seller-a.stocks'),'keep');
});

test('login/page recovery discovers a real server-side unresolved attempt and stays locked',async()=>{
  const h=harness({fetchImpl:async url=>({status:200,json:async()=>url.endsWith('/active')?{ok:true,issuance:{issuanceAttemptId:'sale:SERVER',state:'manual_reconciliation_required',issuanceLocked:true}}:{ok:true}})});
  await h.api.discoverActive();
  assert.equal(h.localStorage.value('mkcrm.activeSaleIssuance.seller-a'),'sale:SERVER');assert.equal(h.elements.get('#issueBtn').disabled,true);assert.match(h.elements.get('#saleOut').innerHTML,/از صدور مجدد خودداری کنید/);
});

test('no server-side unresolved attempt leaves a clean draft unlocked',async()=>{
  const h=harness();await h.api.discoverActive();assert.equal(h.elements.get('#issueBtn').disabled,false);assert.equal(h.state.saleIssueInFlight,false);
});

test('stale local attempt returning 404 is removed without clearing the editable draft',async()=>{
  const h=harness({fetchImpl:async()=>({status:404,json:async()=>({ok:false,code:'ISSUANCE_ATTEMPT_NOT_FOUND'})})});h.state.saleLines=[{itemCode:'KEEP'}];h.localStorage.setItem('mkcrm.activeSaleIssuance.seller-a','sale:MISSING');
  await h.api.refreshStatus('sale:MISSING',true);
  assert.equal(h.localStorage.has('mkcrm.activeSaleIssuance.seller-a'),false);assert.equal(h.elements.get('#issueBtn').disabled,false);assert.equal(h.state.saleLines.length,1);
});

test('ambiguous and resolving states remain blocked while confirmed failure is recoverable',()=>{
  for(const state of ['put_in_progress','put_response_ambiguous','put_succeeded_resolve_pending','manual_reconciliation_required'])assert.equal(hotfix.includes(`'${state}'`),true,state);
  assert.match(hotfix,/issuance\.state==='confirmed_put_failure'/);assert.match(hotfix,/storeAttempt\(''\);state\.saleIssueKey=newAttemptId\(\)/);
});

test('request attempt is persisted only immediately before the protected issue request',()=>{
  assert.match(hotfix,/const attemptId=ensureAttemptId\(\),invoiceExtras=selectedExtras\(\);storeAttempt\(attemptId\);setIssueLocked\(true\)/);
  assert.doesNotMatch(hotfix,/function ensureAttemptId\(\)[^{]*\{[^}]*storeAttempt\(id\)/);
});

test('cross-tab storage changes trigger server reconciliation instead of blind unlock',()=>{
  assert.match(hotfix,/window\.addEventListener\('storage'/);assert.match(hotfix,/const attemptId=event\.newValue\|\|event\.oldValue/);assert.match(hotfix,/refreshIssuanceStatus\(attemptId\)/);
});

test('active-attempt endpoint is read-only, owner-scoped, and precedes the dynamic attempt route',()=>{
  const active=server.indexOf("pathname==='/api/sales/issuance/active'"),dynamic=server.indexOf('const saleIssuanceStatusMatch');assert.ok(active>0&&active<dynamic);
  const block=server.slice(active,dynamic);assert.match(block,/req\.method==='GET'/);assert.match(block,/issuanceState:\{\$in:saleIssuance\.LOCKED_STATES\}/);assert.match(block,/mappingUsername:username/);assert.match(block,/'requestedBy\.username':username/);assert.doesNotMatch(block,/insertOne|updateOne|deleteOne|putSaleInvoice/);
});

test('single cost editor, duplicate-click guard, print and Lead ID contracts remain present',()=>{
  assert.match(hotfix,/function enforceOneCostEditor\(\)/);assert.match(hotfix,/if\(state\.saleIssueInFlight\)/);assert.match(hotfix,/leadId:qs\('#leadId'\)/);assert.match(hotfix,/\/print\/invoice\//);
});

test('page refresh checks persisted or server-active attempts without creating a fake persisted attempt',()=>{
  assert.match(hotfix,/const activeAttempt=readStoredAttempt\(\);if\(activeAttempt\)refreshIssuanceStatus\(activeAttempt\);else discoverActiveIssuance\(\)/);
});

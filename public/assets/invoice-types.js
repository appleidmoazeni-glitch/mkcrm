(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.MKCRMInvoiceTypes=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const registry=Object.freeze({
    2:Object.freeze({family:'sale',label:'فاکتور فروش',viewer:'invoice'}),
    3:Object.freeze({family:'purchase',label:'فاکتور خرید',viewer:'invoice'}),
    4:Object.freeze({family:'warehouse-transfer',label:'انتقال انبار',viewer:'warehouse-transfer'}),
    5:Object.freeze({family:'warehouse-transfer',label:'انتقال انبار',viewer:'warehouse-transfer'}),
    6:Object.freeze({family:'sale-return',label:'برگشت از فروش',viewer:'invoice'}),
    7:Object.freeze({family:'purchase-return',label:'برگشت از خرید',viewer:'invoice'}),
    10:Object.freeze({family:'warehouse-transfer',label:'انتقال انبار',viewer:'warehouse-transfer'})
  });
  function normalizeInvTyp(value){const n=Number(value);return Number.isInteger(n)&&n>0?n:null;}
  function definition(value){const n=normalizeInvTyp(value);return n?registry[n]||null:null;}
  function normalizePersianText(value){return String(value??'').replace(/[يى]/g,'ی').replace(/ك/g,'ک').trim().replace(/\s+/g,' ');}
  function turnoverDescription(row={}){return normalizePersianText([row.RowDesc,row.Description,row.Des,row.Comment,row.RowDescription,row.Detail,row.DetailDesc].filter(Boolean).join(' '));}
  function classifyTurnoverInvoiceType(row){
    const text=typeof row==='object'&&row!==null?turnoverDescription(row):normalizePersianText(row);
    if(text.includes('برگشت از فروش'))return 6;
    if(text.includes('برگشت از خرید'))return 7;
    if(text.includes('فاکتور فروش'))return 2;
    if(text.includes('فاکتور خرید'))return 3;
    return null;
  }
  return Object.freeze({registry,normalizeInvTyp,normalizePersianText,turnoverDescription,classifyTurnoverInvoiceType,getInvoiceFamily:v=>definition(v)?.family||'unknown',getInvoiceTypeLabel:v=>definition(v)?.label||'نوع سند نامشخص',isSupportedInvoiceType:v=>!!definition(v),isWarehouseTransferType:v=>definition(v)?.family==='warehouse-transfer',getInvoiceViewerRoute:v=>definition(v)?.viewer||null,supportedTypes:Object.freeze(Object.keys(registry).map(Number)),turnoverTypes:Object.freeze([2,3,6,7])});
});

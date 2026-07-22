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
  return Object.freeze({registry,normalizeInvTyp,getInvoiceFamily:v=>definition(v)?.family||'unknown',getInvoiceTypeLabel:v=>definition(v)?.label||'نوع سند نامشخص',isSupportedInvoiceType:v=>!!definition(v),isWarehouseTransferType:v=>definition(v)?.family==='warehouse-transfer',getInvoiceViewerRoute:v=>definition(v)?.viewer||null,supportedTypes:Object.freeze(Object.keys(registry).map(Number))});
});

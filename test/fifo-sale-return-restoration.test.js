'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fifo = require('../src/lib/fifo-shadow-engine');

function sale(overrides={}){
  return {
    snapshotId:'S1',saleInvoiceType:2,saleInvoiceNo:1892,saleLineId:'SL-2-1892-001-10M8150930',
    saleGuid:'SALE-1892',saleDate:'14050221',createdDate:'2026-05-11T21:29:04',row:1,
    itemGuid:'ITEM-G',itemCode:'10M8150930',itemName:'Notebook',qty:1,saleValue:3690000000,
    sellerAccountNumber:'11701129',sellerName:'سعید امیدوار',...overrides
  };
}
function layer(overrides={}){
  return {
    datasetId:'P1',purchaseLineIdentity:'PURCHASE-101-LINE',layerKind:'purchase',validationStatus:'valid',
    purchaseInvoiceDate:'14050123',purchaseInvoiceNo:101,sourceRow:2448,purchaseInvoiceGuid:'PURCHASE-101',
    supplierAccountNumber:'41104330',supplierName:'بازرگانی ماندگار - بیات',itemGuid:'ITEM-G',itemCode:'10M8150930',
    netPurchasedQuantity:1,netUnitCost:'2391986526.70',...overrides
  };
}
function source(overrides={}){
  return {
    saleActive:{snapshotId:'S1'},purchaseActive:{datasetId:'P1',dataset:{}},saleHeaders:[],
    saleLines:[],purchaseLayers:[layer()],manuals:[],purchaseReturnResolutions:[],saleReturnResolutions:[],...overrides
  };
}

test('FIFO-RET-01 restores the exact Purchase 101 cost after Return 51 for Sale 1999',()=>{
  const input=source({saleLines:[
    sale(),
    sale({saleInvoiceType:6,saleInvoiceNo:51,saleLineId:'SL-6-51-001-10M8150930',saleGuid:'RETURN-51',createdDate:'2026-05-11T21:31:01',generalRef:'1892',saleValue:3690000000}),
    sale({saleInvoiceNo:1999,saleLineId:'SL-2-1999-001-10M8150930',saleGuid:'SALE-1999',saleDate:'14050223',createdDate:'2026-05-13T19:55:15',saleValue:3400000000,sellerAccountNumber:'11701150',sellerName:'عماد میرزایی'})
  ]});
  const result=fifo._allocateSources('FIFO-RET-01',input,{});
  const first=result.allocations.filter(row=>row.saleLineId==='SL-2-1892-001-10M8150930');
  const reversal=result.allocations.filter(row=>row.saleLineId==='SL-6-51-001-10M8150930');
  const later=result.allocations.filter(row=>row.saleLineId==='SL-2-1999-001-10M8150930');
  assert.equal(first.length,1);
  assert.equal(reversal.length,1);
  assert.equal(later.length,1);
  assert.equal(reversal[0].originalSaleLineId,first[0].saleLineId);
  assert.equal(reversal[0].originalAllocationId,first[0].allocationId);
  assert.equal(reversal[0].returnLinkageSource,'SOURCE_GENERAL_REF');
  assert.equal(reversal[0].allocatedQty,-1);
  assert.equal(reversal[0].allocatedCostAmountExact,'-2391986526.70');
  assert.equal(reversal[0].sellerAccountNumber,'11701129');
  assert.equal(reversal[0].returnOperatorAccountNumber,'11701129');
  assert.equal(later[0].sourceType,'official_purchase_layer');
  assert.equal(later[0].purchaseLineIdentity,'PURCHASE-101-LINE');
  assert.equal(later[0].allocatedCostAmountExact,'2391986526.70');
  assert.equal(later[0].allocatedSaleValueExact,'3400000000.00');
  assert.equal(result.exceptions.find(row=>row.saleReturnLineId==='SL-6-51-001-10M8150930').status,'source-linked-reversed-restored');
  const facts=fifo._provenanceFacts(result.allocations,[]);
  const originalFact=facts.find(row=>row.saleLineId==='SL-2-1892-001-10M8150930');
  const laterFact=facts.find(row=>row.saleLineId==='SL-2-1999-001-10M8150930');
  assert.equal(originalFact.quantityExact,'0.000000');
  assert.equal(originalFact.saleValueExact,'0.00');
  assert.equal(originalFact.fifoCostExact,'0.00');
  assert.equal(originalFact.fifoProfitExact,'0.00');
  assert.equal(originalFact.sellerIdentity,'11701129');
  assert.equal(originalFact.costSourceType,'OFFICIAL_PURCHASE_LAYER');
  const returnSource=originalFact.provenanceSources.find(row=>row.returnProvenance);
  assert.equal(returnSource.returnProvenance.returnInvoiceNumber,51);
  assert.equal(returnSource.returnProvenance.originSaleInvoiceNumber,1892);
  assert.equal(returnSource.returnProvenance.originSaleLineId,'SL-2-1892-001-10M8150930');
  assert.equal(returnSource.returnProvenance.reversedAllocationId,first[0].allocationId);
  assert.equal(returnSource.returnProvenance.linkageSource,'SOURCE_GENERAL_REF');
  assert.equal(returnSource.returnProvenance.linkageReference,'1892');
  assert.equal(returnSource.returnProvenance.restoredQuantityExact,'1.000000');
  assert.equal(returnSource.returnProvenance.restoredCostAmountExact,'2391986526.70');
  assert.equal(laterFact.fifoCostExact,'2391986526.70');
  assert.equal(laterFact.fifoProfitExact,'1008013473.30');
  assert.equal(laterFact.sellerIdentity,'11701150');
});

test('a return linked to Sale A restores Sale A and never reverses intervening Sale B',()=>{
  const input=source({
    purchaseLayers:[layer({netPurchasedQuantity:2})],
    saleLines:[
      sale({saleInvoiceNo:10,saleLineId:'SALE-A',saleGuid:'A',saleValue:3000000000,createdDate:'2026-05-11T10:00:00'}),
      sale({saleInvoiceNo:11,saleLineId:'SALE-B',saleGuid:'B',saleValue:3100000000,createdDate:'2026-05-11T10:01:00'}),
      sale({saleInvoiceType:6,saleInvoiceNo:12,saleLineId:'RETURN-A',saleGuid:'RA',generalRef:'10',saleValue:3000000000,createdDate:'2026-05-11T10:02:00'}),
      sale({saleInvoiceNo:13,saleLineId:'SALE-C',saleGuid:'C',saleValue:3200000000,createdDate:'2026-05-11T10:03:00'})
    ]
  });
  const result=fifo._allocateSources('FIFO-SEQUENCE',input,{});
  const reversal=result.allocations.find(row=>row.saleLineId==='RETURN-A');
  const saleC=result.allocations.find(row=>row.saleLineId==='SALE-C');
  assert.equal(reversal.originalSaleLineId,'SALE-A');
  assert.equal(saleC.sourceType,'official_purchase_layer');
  assert.equal(result.allocations.filter(row=>row.saleLineId==='SALE-B'&&row.sourceType==='sale_return_reversal').length,0);
});

test('partial return from one allocation restores only returned quantity and repeated over-return fabricates no capacity',()=>{
  const input=source({
    purchaseLayers:[layer({netPurchasedQuantity:10})],
    saleLines:[
      sale({saleInvoiceNo:20,saleLineId:'SALE-10',qty:10,saleValue:10000,createdDate:'2026-05-11T10:00:00'}),
      sale({saleInvoiceType:6,saleInvoiceNo:21,saleLineId:'RETURN-3',generalRef:'20',qty:3,saleValue:3000,createdDate:'2026-05-11T10:01:00'}),
      sale({saleInvoiceType:6,saleInvoiceNo:22,saleLineId:'RETURN-9',generalRef:'20',qty:9,saleValue:9000,createdDate:'2026-05-11T10:02:00'}),
      sale({saleInvoiceNo:23,saleLineId:'SALE-AFTER',qty:10,saleValue:10000,createdDate:'2026-05-11T10:03:00'})
    ]
  });
  const result=fifo._allocateSources('FIFO-PARTIAL',input,{});
  assert.equal(result.allocations.find(row=>row.saleLineId==='RETURN-3').allocatedQty,-3);
  assert.equal(result.allocations.find(row=>row.saleLineId==='RETURN-9').allocatedQty,-7);
  const after=result.allocations.filter(row=>row.saleLineId==='SALE-AFTER');
  assert.deepEqual(after.map(row=>[row.sourceType,row.allocatedQty,row.unknownQty]),[['official_purchase_layer',10,0]]);
  assert.equal(result.exceptions.find(row=>row.saleReturnLineId==='RETURN-9').status,'source-link-insufficient-original-quantity');
});

test('partial return across multiple original cost layers is quarantined without fabricated precision',()=>{
  const input=source({
    purchaseLayers:[layer({purchaseLineIdentity:'L1',netPurchasedQuantity:2,netUnitCost:100}),layer({purchaseLineIdentity:'L2',purchaseInvoiceNo:102,netPurchasedQuantity:2,netUnitCost:200})],
    saleLines:[sale({saleInvoiceNo:30,saleLineId:'SALE-MULTI',qty:4,saleValue:1000}),sale({saleInvoiceType:6,saleInvoiceNo:31,saleLineId:'RETURN-MULTI',generalRef:'30',qty:1,saleValue:250,createdDate:'2026-05-11T21:31:01'})]
  });
  const result=fifo._allocateSources('FIFO-MULTI',input,{});
  assert.equal(result.allocations.some(row=>row.saleLineId==='RETURN-MULTI'),false);
  assert.equal(result.exceptions.find(row=>row.saleReturnLineId==='RETURN-MULTI').code,'SALE_RETURN_ALLOCATION_AMBIGUOUS');
});

test('unlinked return and return of unknown original cost never restore a fake cost basis',()=>{
  const input=source({purchaseLayers:[],saleLines:[
    sale({saleInvoiceNo:40,saleLineId:'SALE-UNKNOWN'}),
    sale({saleInvoiceType:6,saleInvoiceNo:41,saleLineId:'RETURN-UNKNOWN',generalRef:'40'}),
    sale({saleInvoiceType:6,saleInvoiceNo:42,saleLineId:'RETURN-UNLINKED',generalRef:''}),
    sale({saleInvoiceNo:43,saleLineId:'SALE-LATER',saleDate:'14050222'})
  ]});
  const result=fifo._allocateSources('FIFO-UNKNOWN',input,{});
  assert.equal(result.allocations.find(row=>row.saleLineId==='RETURN-UNKNOWN').unknownQty,-1);
  assert.equal(result.allocations.find(row=>row.saleLineId==='SALE-LATER').sourceType,'unknown_cost');
  assert.equal(result.allocations.some(row=>row.saleLineId==='RETURN-UNLINKED'),false);
});

test('FIFO Candidate UI explains sale, return, cost source and net effect without raw JSON',()=>{
  const ui=fs.readFileSync(path.join(__dirname,'../public/assets/app.js'),'utf8');
  const start=ui.indexOf('async function loadAllocations()');
  const end=ui.indexOf('async function startBuild',start);
  const view=ui.slice(start,end);
  assert.match(view,/فروش \/ برگشت از فروش/);
  assert.match(view,/مأخذ هزینه/);
  assert.match(view,/اثر خالص/);
  assert.match(view,/originalAllocationId/);
  assert.match(view,/returnLinkageSource/);
  assert.doesNotMatch(view,/JSON\.stringify/);
  const finalRegistry=ui.slice(ui.indexOf('Financial operations navigation — final, single registry.'));
  assert.match(finalRegistry,/\{id:'fifo-shadow-validation',label:'اعتبارسنجی FIFO Shadow'\}/);
  assert.match(finalRegistry,/current==='fifo-shadow-validation'/);
  assert.match(finalRegistry,/window\.pageFifoShadowValidation\(\)/);
});

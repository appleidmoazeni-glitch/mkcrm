'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {MemoryDb}=require('./helpers/memory-mongo');
const recovery=require('../src/lib/purchase-history-recovery');

function seed(){
  return new MemoryDb({
    fifoAllocations:[
      {datasetId:'FIFO-C',sourceType:'unknown_cost',saleLineId:'L1',saleDate:'14050508',itemGuid:'G-N',itemCode:'NB-1',itemDescription:'Notebook A',officialProductCategoryName:'NOTEBOOK',quantityExact:'2.000000',allocatedSaleValueExact:'2000000.00'},
      {datasetId:'FIFO-C',sourceType:'unknown_cost',saleLineId:'L2',saleDate:'14050506',itemGuid:'G-H',itemCode:'HIGH-1',itemDescription:'CPU A',officialProductCategoryName:'CPU',quantityExact:'1.000000',allocatedSaleValueExact:'5000000.00'},
      {datasetId:'FIFO-C',sourceType:'unknown_cost',saleLineId:'L3',saleDate:'14050510',itemGuid:'G-H',itemCode:'HIGH-1',itemDescription:'CPU A',officialProductCategoryName:'CPU',quantityExact:'1.000000',allocatedSaleValueExact:'1000000.00'}
    ],
    supplierPurchaseLayers:[{datasetId:'PLAYER-C',datasetSchemaVersion:1,purchaseLineIdentity:'GUID-3-100:1',layerKind:'purchase'}],
    purchaseLayerRecoveryCandidates:[]
  });
}
function shaygan(){
  const calls=[];
  return {
    calls,
    async getKardexByItemCode(itemCode,_stock,options){calls.push({kind:'kardex',itemCode,options});return{ok:true,rows:[{invoiceType:3,invoiceNumber:itemCode==='NB-1'?101:102,inQty:2,date:'14050501'},{invoiceType:7,invoiceNumber:12,outQty:1,date:'14050503'}]};},
    async getInvoice(invoiceNo,type,options){calls.push({kind:'invoice',invoiceNo,type,options});const code=invoiceNo===101?'NB-1':'HIGH-1';const guid=invoiceNo===101?'G-N':'G-H';return{ok:true,list:[{InvTyp:3,InvNo:invoiceNo,InvDate:'14050501',GuId:`GUID-3-${invoiceNo}`,AccountNumber:'SUP-1',AccountName:'Supplier',Body:[{LineItemId:1,ItemNumber:code,ItemGuId:guid,ItemDescription:code,Quan:2,Price:100,Amount:200}]}]};}
  };
}

test('bounded recovery prioritizes notebook plus high value and never creates purchase layers',async()=>{
  const db=seed(),api=shaygan();
  const before=structuredClone(db.collection('supplierPurchaseLayers').rows);
  const result=await recovery.recover(db,{shaygan:api,fifoDatasetId:'FIFO-C',purchaseDatasetId:'PLAYER-C',maxItems:2,maxKardexRows:3,timeoutMs:4000,persist:true});
  assert.equal(result.bounded,true);
  assert.equal(result.selectedItemCount,2);
  assert.equal(result.notebookPriorityCount,1);
  assert.equal(result.recoveredEvidenceCount,2);
  assert.equal(result.persistedEvidenceCount,2);
  assert.equal(result.layerWrites,0);
  assert.equal(result.activationPerformed,false);
  assert.deepEqual(db.collection('supplierPurchaseLayers').rows,before);
  assert.equal(db.collection('purchaseLayerRecoveryCandidates').rows.length,2);
  assert.ok(result.recovered.every(row=>row.status==='detected'&&row.reviewRequired&&!row.approvedForDatasetRebuild));
  assert.ok(result.recovered.every(row=>row.eligibilityForFifoChronology==='eligible_before_first_sale'));
  assert.ok(api.calls.filter(row=>row.kind==='kardex').every(row=>row.options.maxRows===3&&row.options.timeoutMs===4000));
});

test('existing purchase identity is excluded and transport failures are sanitized',async()=>{
  const db=seed();
  const api=shaygan();
  api.getKardexByItemCode=async itemCode=>itemCode==='NB-1'
    ?{ok:false,rows:[],error:'token=secret timeout'}
    :{ok:true,rows:[{invoiceType:3,invoiceNumber:100,inQty:1,date:'14050501'}]};
  const result=await recovery.recover(db,{shaygan:api,fifoDatasetId:'FIFO-C',purchaseDatasetId:'PLAYER-C',maxItems:2,persist:false});
  assert.equal(result.recoveredEvidenceCount,0);
  assert.equal(result.persistedEvidenceCount,0);
  assert.equal(result.failures.length,1);
  assert.doesNotMatch(result.failures[0].error,/secret/);
  assert.match(result.failures[0].error,/REDACTED/);
});

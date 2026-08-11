'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs');
const path=require('path');
const {MemoryDb}=require('./helpers/memory-mongo');
const provenance=require('../src/lib/fifo-profit-provenance');
const fifo=require('../src/lib/fifo-shadow-engine');
const manualCost=require('../src/lib/manual-cost-resolution');
const sellerFinancial=require('../src/lib/seller-financial-performance');

const accountant={username:'khedmati',role:'accounting'};
function allocation(overrides={}){return {allocationId:'A1',sourceType:'official_purchase_layer',purchaseDatasetId:'PDS',purchaseLineIdentity:'PL-1',purchaseInvoiceNo:1112,purchaseInvoiceDate:'14050401',supplierAccountNumber:'SUP-1',supplierName:'ماتریس',quantityExact:'1.000000',allocatedQty:1,unknownQty:0,unitCostExact:'300.000000',allocatedCostAmountExact:'300.00',...overrides};}

test('official single-layer provenance exposes purchase invoice, supplier and exact conservation',()=>{
  const result=provenance.lineProvenance([allocation()],{saleQtyExact:'1.000000',saleValueExact:'329.00'});
  assert.equal(result.profitProvenanceStatus,'PROVEN');
  assert.equal(result.costSourceType,'OFFICIAL_PURCHASE_LAYER');
  assert.equal(result.provenanceSources[0].purchaseInvoiceNumber,1112);
  assert.equal(result.provenanceSources[0].supplierName,'ماتریس');
  assert.equal(result.provenanceReconciliation.quantityConserved,true);
  assert.equal(result.provenanceReconciliation.moneyConserved,true);
  assert.equal(result.provenanceReconciliation.fifoProfitExact,'29.00');
});

test('official multi-layer provenance preserves every source and total cost',()=>{
  const rows=[allocation({allocationId:'A1',quantityExact:'2.000000',allocatedQty:2,allocatedCostAmountExact:'200.00',unitCostExact:'100.000000'}),allocation({allocationId:'A2',purchaseLineIdentity:'PL-2',purchaseInvoiceNo:1167,quantityExact:'3.000000',allocatedQty:3,allocatedCostAmountExact:'360.00',unitCostExact:'120.000000'})];
  const result=provenance.lineProvenance(rows,{saleQtyExact:'5.000000',saleValueExact:'700.00'});
  assert.equal(result.profitProvenanceStatus,'PROVEN');
  assert.equal(result.costSourceType,'MULTI_PURCHASE_LAYER');
  assert.deepEqual(result.provenanceSources.map(row=>row.purchaseInvoiceNumber),[1112,1167]);
  assert.equal(result.provenanceReconciliation.allocatedCostExact,'560.00');
});

test('quantity mismatch and partial source never expose full profit',()=>{
  const mismatch=provenance.lineProvenance([allocation()],{saleQtyExact:'2.000000',saleValueExact:'400.00'});
  assert.equal(mismatch.profitProvenanceStatus,'PARTIAL');
  assert.equal(mismatch.provenanceReconciliation.fifoProfitExact,null);
  const partial=provenance.lineProvenance([allocation(),allocation({allocationId:'U',sourceType:'unknown_cost',quantityExact:'1.000000',allocatedQty:0,unknownQty:1,unitCostExact:null,allocatedCostAmountExact:null,unknownReason:'no_purchase_history_available'})],{saleQtyExact:'2.000000',saleValueExact:'500.00'});
  assert.equal(partial.profitProvenanceStatus,'PARTIAL');
  assert.equal(partial.provenanceReconciliation.fifoProfitExact,null);
});

test('unknown source has no fake provenance or profit',()=>{
  const result=provenance.lineProvenance([allocation({sourceType:'unknown_cost',quantityExact:'1.000000',allocatedQty:0,unknownQty:1,unitCostExact:null,allocatedCostAmountExact:null,unknownReason:'no_purchase_history_available'})],{saleQtyExact:'1.000000',saleValueExact:'500.00'});
  assert.equal(result.profitProvenanceStatus,'UNKNOWN');
  assert.equal(result.costSourceType,'UNKNOWN');
  assert.equal(result.provenanceReconciliation.allocatedCostExact,null);
  assert.equal(result.provenanceReconciliation.fifoProfitExact,null);
});

test('manual purchase-layer and legacy-item provenance have distinct evidence labels',()=>{
  const manual={resolutionId:'MC-1',revision:3,contentHash:'a'.repeat(64),manualCostExact:'612310000.000000',resolutionScope:'purchase_layer',createdBy:{username:'khedmati',role:'accounting'},approvedBy:{username:'admin',role:'admin'},approvedAt:new Date('2026-08-01T00:00:00Z')};
  const exactLayer=provenance.lineProvenance([allocation({sourceType:'approved_manual_purchase_layer',manualResolutionId:'MC-1'})],{saleQtyExact:'1.000000',saleValueExact:'329.00',manualById:new Map([['MC-1',manual]])});
  assert.equal(exactLayer.costSourceType,'MANUAL_COST_PURCHASE_LAYER');
  assert.equal(exactLayer.provenanceSources[0].evidenceQuality,'GOVERNED_EXACT_LAYER');
  const legacy=provenance.lineProvenance([allocation({sourceType:'approved_manual_cost',manualResolutionId:'MC-1',purchaseLineIdentity:'',purchaseInvoiceNo:0})],{saleQtyExact:'1.000000',saleValueExact:'329.00',manualById:new Map([['MC-1',{...manual,resolutionScope:'item'}]])});
  assert.equal(legacy.costSourceType,'MANUAL_COST_ITEM_LEGACY');
  assert.equal(legacy.provenanceSources[0].evidenceQuality,'GOVERNED_LEGACY_ITEM');
  assert.match(legacy.provenanceSources[0].warning,/فاکتور خرید مشخص/);
});

test('impact preview performs zero index or collection writes',async()=>{
  const db=new MemoryDb({manualCostResolutions:[{resolutionId:'MC-1',status:'approved',itemGuid:'G1',itemCode:'I1',manualCostExact:'10.000000',effectiveFrom:'14050101',effectiveTo:''}],fifoDatasetState:[{scopeKey:fifo.SCOPE_KEY,activeDatasetId:'FIFO-OLD'}],fifoAllocations:[{datasetId:'FIFO-OLD',saleLineId:'L1',saleInvoiceType:2,saleInvoiceNo:1,saleDate:'14050102',itemGuid:'G1',itemCode:'I1',sourceType:'unknown_cost',unknownQty:1,quantityExact:'1.000000',allocatedSaleValueExact:'20.00',allocatedCostAmountExact:null}]});
  let writes=0;db.createCollection=async()=>{writes++;throw new Error('unexpected createCollection');};for(const collection of db.collections.values())collection.createIndex=async()=>{writes++;throw new Error('unexpected createIndex');};
  const result=await manualCost.impactPreview(db,'MC-1',{role:'accounting'});
  assert.equal(result.readOnly,true);assert.equal(result.affected.saleLines,1);assert.equal(writes,0);
});

function candidateDb(){return new MemoryDb({
  saleSnapshotState:[{scopeKey:'sale-type2|14050101|',activeSnapshotId:'SALE-NEW'}],saleSnapshots:[{snapshotId:'SALE-NEW',status:'completed'}],saleSnapshotDatasetHeaders:[{snapshotId:'SALE-NEW',invTyp:2,invNo:1479}],saleSnapshotDatasetLines:[{snapshotId:'SALE-NEW',saleLineId:'SL-2-1479-001-10X1407920',saleInvoiceType:2,saleInvoiceNo:1479,saleDate:'14050210',row:1,itemGuid:'G-ASUS',itemCode:'10X1407920',itemName:'ASUS notebook',qty:1,saleValue:1147000000,currentInventory:1,mainGroupName:'NOTEBOOK'}],
  purchaseLayerDatasetState:[{scopeKey:'purchase-invoices-types-3-7',activeDatasetId:'PURCHASE-NEW'}],purchaseLayerDatasets:[{datasetId:'PURCHASE-NEW',status:'completed',activationStatus:'active',sourceDateFrom:'14050101'}],supplierPurchaseLayers:[],
  manualCostResolutions:[{resolutionId:'MCOST-1785779703360-79333248',status:'approved',revision:3,deleted:false,itemGuid:'G-ASUS',itemCode:'10X1407920',manualCostExact:'612310000.000000',resolutionScope:'item',effectiveFrom:'14050101',effectiveTo:'',contentHash:'b'.repeat(64),createdBy:{username:'khedmati',role:'accounting'},approvedBy:{username:'admin',role:'admin'},approvedAt:new Date('2026-08-01T00:00:00Z')}],purchaseReturnResolutions:[],saleReturnResolutions:[],
  fifoDatasets:[{datasetId:'FIFO-OLD',status:'completed',activationStatus:'validated-shadow',validation:{valid:true}}],fifoAllocations:[],fifoExceptions:[],fifoDiagnostics:[],fifoDatasetState:[{scopeKey:fifo.SCOPE_KEY,activeDatasetId:'FIFO-OLD'}]
});}

test('candidate includes approved manual fingerprint, applies FIFO-04 deterministically and never auto-activates',async()=>{
  const db=candidateDb();const oldState=structuredClone(db.collection(fifo.STATE).rows[0]);const oldDataset=structuredClone(db.collection(fifo.DATASETS).rows[0]);
  const built=await fifo.buildShadowDataset(db,{},accountant);
  assert.equal(built.activationStatus,'validated-candidate');assert.equal(db.collection(fifo.STATE).rows[0].activeDatasetId,'FIFO-OLD');assert.match(built.manualResolutionSetFingerprint,/^[a-f0-9]{64}$/);assert.match(built.candidateFingerprint,/^[a-f0-9]{64}$/);
  const facts=fifo._provenanceFacts(db.collection(fifo.ALLOCATIONS).rows.filter(row=>row.datasetId===built.datasetId),db.collection('manualCostResolutions').rows);const line=facts[0];
  assert.equal(line.costSourceType,'MANUAL_COST_ITEM_LEGACY');assert.equal(line.fifoCostExact,'612310000.00');assert.equal(line.fifoProfitExact,'534690000.00');assert.equal(line.profitProvenanceStatus,'PROVEN');
  assert.deepEqual(db.collection(fifo.DATASETS).rows.find(row=>row.datasetId==='FIFO-OLD'),oldDataset);assert.equal(db.collection(fifo.STATE).rows[0].activeDatasetId,oldState.activeDatasetId);
  const report=await fifo.candidateQualityReport(db,built.datasetId);assert.equal(report.candidateNotActivated,true);assert.equal(report.candidateCoverage.provenLines,1);assert.deepEqual(report.delta.manualCostAffectedLines,['SL-2-1479-001-10X1407920']);
});

test('opening-inventory candidate remains unknown and receives no automatic cost',async()=>{
  const db=candidateDb();db.collection('saleSnapshotDatasetLines').rows[0]={...db.collection('saleSnapshotDatasetLines').rows[0],itemGuid:'OPEN-G',itemCode:'OPEN',saleDate:'14040101'};db.collection('manualCostResolutions').rows=[];
  const built=await fifo.buildShadowDataset(db,{},accountant);const row=db.collection(fifo.ALLOCATIONS).rows.find(item=>item.datasetId===built.datasetId);
  assert.equal(row.unknownReason,'opening_inventory_candidate');assert.equal(row.costSourceType,'UNKNOWN');assert.equal(row.allocatedCostAmountExact,null);
});

test('seller/category aggregate contract exposes proven profit and coverage without calling it total profit',()=>{
  const rows=[{sellerIdentity:'S1',officialProductCategoryIdentity:'C1',officialProductCategoryName:'NOTEBOOK',accountingMonth:'140504',saleInvoiceIdentity:'2:1',quantityExact:'1.000000',grossSaleAmountExact:'100.00',lineDiscountExact:'0.00',allocatedInvoiceDiscountExact:'0.00',netSaleAmountExact:'100.00',fifoCostExact:'70.00',actualFifoProfitExact:'30.00',profitProvenanceStatus:'PROVEN',commissionableProfitExact:null,preliminaryCommissionExact:null,blockers:[],costCoverageStatus:'complete'},{sellerIdentity:'S1',officialProductCategoryIdentity:'C1',officialProductCategoryName:'NOTEBOOK',accountingMonth:'140504',saleInvoiceIdentity:'2:2',quantityExact:'1.000000',grossSaleAmountExact:'50.00',lineDiscountExact:'0.00',allocatedInvoiceDiscountExact:'0.00',netSaleAmountExact:null,fifoCostExact:null,actualFifoProfitExact:null,profitProvenanceStatus:'UNKNOWN',commissionableProfitExact:null,preliminaryCommissionExact:null,blockers:['cost-unknown'],costCoverageStatus:'unknown'}];
  const summary=sellerFinancial._buildSummaries(rows,'RUN',new Date()).find(row=>row.dimension==='seller-category-month');
  assert.equal(summary.provenFifoProfitExact,'30.00');assert.equal(summary.provenProfitSaleValueExact,'100.00');assert.equal(summary.unknownOrPartialSaleValueExact,'50.00');assert.equal(summary.provenProfitCoveragePercent,50);
  const ui=fs.readFileSync(path.join(__dirname,'../public/assets/app.js'),'utf8');assert.match(ui,/سود FIFO اثبات‌شده/);assert.doesNotMatch(ui,/card\('Total FIFO Profit'/);
});

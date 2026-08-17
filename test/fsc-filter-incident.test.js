'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {MemoryDb}=require('./helpers/memory-mongo');
const fsc=require('../src/lib/financial-source-control');

const accounting={username:'khedmati',role:'accounting'};
const uiSource=()=>fs.readFileSync(path.join(__dirname,'../public/assets/financial-source-control.js'),'utf8');
function store(){return new MemoryDb({
  purchaseLayerDatasetState:[{scopeKey:'purchase-invoices-types-3-7',activeDatasetId:'P-A'}],
  purchaseLayerDatasets:[{datasetId:'P-A',status:'completed',activationStatus:'active'}],
  fifoDatasetState:[{scopeKey:'fifo-shadow-v2-precision-evidence',activeDatasetId:'F-A'}],
  fifoDatasets:[{datasetId:'F-A',status:'completed',activationStatus:'active'},{datasetId:'F-C',status:'completed',activationStatus:'candidate'}],
  fifoAllocations:[
    {datasetId:'F-C',allocationId:'U1',sourceType:'unknown_cost',saleLineId:'SL1',saleInvoiceType:2,saleInvoiceNo:1,saleDate:'14050110',itemGuid:'G-X',itemCode:'X',quantityExact:'1',allocatedSaleValueExact:'1000',sellerIdentity:'117',sellerAccountNumber:'117',sellerName:'فروشنده یک',officialProductCategoryGuid:'CPU-G',officialProductCategoryName:'CPU'},
    {datasetId:'F-C',allocationId:'U2',sourceType:'unknown_cost',saleLineId:'SL2',saleInvoiceType:2,saleInvoiceNo:2,saleDate:'14050111',itemGuid:'G-Y',itemCode:'Y',quantityExact:'1',allocatedSaleValueExact:'2000',sellerIdentity:'118',sellerAccountNumber:'118',sellerName:'فروشنده دو',officialProductCategoryGuid:'CPU-G',officialProductCategoryName:'CPU'},
    {datasetId:'F-C',allocationId:'U3',sourceType:'unknown_cost',saleLineId:'SL3',saleInvoiceType:2,saleInvoiceNo:3,saleDate:'14050112',itemGuid:'G-Z',itemCode:'Z',quantityExact:'1',allocatedSaleValueExact:'3000',sellerIdentity:'117',sellerAccountNumber:'117',sellerName:'فروشنده یک',officialProductCategoryGuid:'NB-G',officialProductCategoryName:'NOTEBOOK'}
  ],
  manualCostResolutions:[],openingInventoryEvidence:[],
  accountingOfficialGroupCatalogRuns:[{catalogRunId:'CAT',fetchedAt:new Date()}],
  accountingOfficialItemGroups:[
    {catalogRunId:'CAT',isMainGroup:true,sourceGroupGuid:'CPU-G',groupName:'CPU',resolvedMainGroupGuid:'CPU-G',resolvedMainGroupName:'CPU'},
    {catalogRunId:'CAT',isMainGroup:true,sourceGroupGuid:'NB-G',groupName:'NOTEBOOK',resolvedMainGroupGuid:'NB-G',resolvedMainGroupName:'NOTEBOOK'}
  ]
});}

test('seller selector serializes the stable identity, not its label',()=>assert.match(uiSource(),/sellerIdentity:requireStableSelector\([^\n]+sellerIdentity/));
test('seller backend filter is exact',async()=>{const result=await fsc.fifoLines(store(),{fifoDatasetId:'F-C',sellerIdentity:'117'},accounting);assert.equal(result.total,2);assert.ok(result.list.every(row=>row.sellerIdentity==='117'));assert.equal(result.filtersApplied.sellerIdentity,'117');});
test('category selector serializes the official GUID',()=>assert.match(uiSource(),/categoryGuid:requireStableSelector\([^\n]+officialProductCategoryGuid/));
test('category backend filter is exact',async()=>{const result=await fsc.fifoLines(store(),{fifoDatasetId:'F-C',categoryGuid:'NB-G'},accounting);assert.equal(result.total,1);assert.equal(result.list[0].officialProductCategoryGuid,'NB-G');assert.equal(result.filtersApplied.categoryGuid,'NB-G');});
test('legacy category rows resolve only through exact audited case variants of the canonical GUID name',async()=>{const db=store();delete db.collection('fifoAllocations').rows[2].officialProductCategoryGuid;db.collection('fifoAllocations').rows[2].officialProductCategoryName='Notebook';const result=await fsc.fifoLines(db,{fifoDatasetId:'F-C',categoryGuid:'NB-G'},accounting);assert.equal(result.total,1);assert.equal(result.list[0].officialProductCategoryGuid,'NB-G');assert.equal(result.list[0].categoryIdentityResolution,'canonical-name-legacy-fallback');assert.equal(result.legacyCategoryFallbackRows,1);assert.equal(result.categoryFilterAudit.authority,'official-product-category-guid');assert.equal(result.categoryFilterAudit.legacyFallback,'exact-case-variant-only');assert.ok(result.categoryFilterAudit.legacyAliases.includes('Notebook'));});
test('legacy category fallback rejects partial or unrelated display names',async()=>{const db=store();delete db.collection('fifoAllocations').rows[2].officialProductCategoryGuid;db.collection('fifoAllocations').rows[2].officialProductCategoryName='Notebook Legacy';const result=await fsc.fifoLines(db,{fifoDatasetId:'F-C',categoryGuid:'NB-G'},accounting);assert.equal(result.total,0);});
test('seller and category filters return only their intersection',async()=>{const result=await fsc.fifoLines(store(),{fifoDatasetId:'F-C',sellerIdentity:'117',categoryGuid:'CPU-G'},accounting);assert.equal(result.total,1);assert.equal(result.list[0].saleLineId,'SL1');});
test('all option removes authoritative filters cleanly',async()=>{const result=await fsc.fifoLines(store(),{fifoDatasetId:'F-C',sellerIdentity:'',categoryGuid:''},accounting);assert.equal(result.total,3);assert.deepEqual(result.filtersApplied,{sellerIdentity:'',categoryGuid:''});assert.match(uiSource(),/storeFifoFilters\(emptyFifoFilterState\(\)\)/);});
test('dataset change preserves valid stable filter state and reapplies it',()=>{const source=uiSource();assert.match(source,/readStoredFifoFilters\(\)/);assert.match(source,/selectors\.sellers\.some\(row=>row\.sellerIdentity===filterState\.sellerIdentity\)/);assert.match(source,/sessionStorage\.setItem\(FIFO_DATASET_KEY/);});
test('filtered summary and table reconcile on the same row count',async()=>{const db=store(),filters={fifoDatasetId:'F-C',sellerIdentity:'117',categoryGuid:'CPU-G'};const [summary,lines]=await Promise.all([fsc.fifoSummary(db,filters,accounting),fsc.fifoLines(db,filters,accounting)]);assert.equal(summary.filteredRowCount,lines.total);assert.equal(summary.selected.UNKNOWN.lines,1);assert.deepEqual(summary.filtersApplied,lines.filtersApplied);});
test('stale async response cannot overwrite the latest filter generation',()=>{const source=uiSource();assert.match(source,/request!==requestGeneration/);assert.match(source,/tabGeneration!==window\.__fscFifoTabGeneration/);});
test('refresh and route re-render restore stable filter state',()=>{const source=uiSource();assert.match(source,/sessionStorage\.getItem\(FIFO_FILTER_KEY\)/);assert.match(source,/sessionStorage\.setItem\(FIFO_FILTER_KEY/);});
test('display names are never accepted as authoritative filters',async()=>{const db=store();const seller=await fsc.fifoLines(db,{fifoDatasetId:'F-C',seller:'فروشنده یک'},accounting);const category=await fsc.fifoLines(db,{fifoDatasetId:'F-C',category:'NOTEBOOK'},accounting);assert.equal(seller.total,3);assert.equal(category.total,3);assert.match(uiSource(),/FSC_SELECTOR_IDENTITY_REQUIRED/);});
test('pagination retains exact authoritative filters',async()=>{const result=await fsc.fifoLines(store(),{fifoDatasetId:'F-C',sellerIdentity:'117',page:2,pageSize:1},accounting);assert.equal(result.total,2);assert.equal(result.page,2);assert.equal(result.list.length,1);assert.equal(result.list[0].sellerIdentity,'117');});
test('FSC filter GET services perform no writes',async()=>{const db=store(),before=JSON.stringify([...db.collections].map(([name,collection])=>[name,collection.rows]));await fsc.selectorOptions(db,{fifoDatasetId:'F-C'},accounting);await fsc.fifoLines(db,{fifoDatasetId:'F-C',sellerIdentity:'117'},accounting);await fsc.fifoSummary(db,{fifoDatasetId:'F-C',categoryGuid:'CPU-G'},accounting);assert.equal(JSON.stringify([...db.collections].map(([name,collection])=>[name,collection.rows])),before);});
test('FSC filter path introduces no request-time Shaygan call',()=>{const source=fs.readFileSync(path.join(__dirname,'../src/lib/financial-source-control.js'),'utf8');const section=source.slice(source.indexOf('async function fifoFacts'),source.indexOf('async function reviewCenter'));assert.doesNotMatch(section,/shaygan|Invoice\/Get|GetKardex/i);});
test('FSC filter indexes are maintained outside GET handlers',()=>{const fifoSource=fs.readFileSync(path.join(__dirname,'../src/lib/fifo-shadow-engine.js'),'utf8');const serverSource=fs.readFileSync(path.join(__dirname,'../src/server.js'),'utf8');assert.match(fifoSource,/datasetId:1, sellerAccountNumber:1, saleLineId:1/);const routes=serverSource.slice(serverSource.indexOf("financial-source-control\/fifo\/lines"),serverSource.indexOf("financial-source-control\/review-center"));assert.doesNotMatch(routes,/createIndex|ensureIndexes/);});

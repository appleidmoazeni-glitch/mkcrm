'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {MemoryDb}=require('./helpers/memory-mongo');
const governance=require('../src/lib/accounting-governance');
const ledger=require('../src/lib/profit-commission-ledger');
const shaygan=require('../src/lib/shaygan');

const accounting={username:'khedmati',role:'accounting'};
const manager={username:'manager-test',role:'manager'};
const admin={username:'admin',role:'admin'};
const seller={username:'seller-test',role:'seller'};
const evidence={policyVersionId:'POLICY-1',reason:'Verified against controlled test evidence',sourceReference:'TEST-DOC-1',evidenceMetadata:{attachmentId:'ATT-1'}};
const governedEvidence={reason:'Verified against controlled test evidence',sourceReference:'TEST-DOC-1',attachmentMetadata:{attachmentId:'ATT-1'}};

function facts(){return[
  {factId:'F1',fifoDatasetId:'FIFO-1',saleLineIdentity:'L1',saleDate:'14050410',sellerIdentity:'S1',itemGuid:'I1',itemCode:'NB-1',officialProductCategoryIdentity:'guid:P1',officialProductCategoryGuid:'P1',officialProductCategoryNumber:'1',officialProductCategoryName:'NOTEBOOK',quantityExact:'1.000000',saleAmountExact:'950.00',actualFifoProfitExact:'200.00',costCoverageStatus:'complete',invoiceDiscountAttributionStatus:'official-line-or-zero'},
  {factId:'F2',fifoDatasetId:'FIFO-1',saleLineIdentity:'L2',saleDate:'14050411',sellerIdentity:'S1',itemGuid:'I2',itemCode:'CP-1',officialProductCategoryIdentity:'guid:P2',officialProductCategoryGuid:'P2',officialProductCategoryNumber:'84',officialProductCategoryName:'CPU',quantityExact:'1.000000',saleAmountExact:'50.00',actualFifoProfitExact:null,costCoverageStatus:'unknown',invoiceDiscountAttributionStatus:'unresolved-invoice-level'}
];}
function dbSeed(extra={}){return new MemoryDb({
  fifoProfitFacts:facts(),
  commissionPolicyVersions:[{policyVersionId:'POLICY-1',name:'Tir policy',accountingPeriod:'140504',effectiveFrom:'14050401',effectiveTo:'14050431',status:'approved',revision:3,createdBy:{username:'creator',role:'accounting'},approvedBy:manager}],
  accountingOfficialGroupCatalogRuns:[{catalogRunId:'TEST-CATALOG',fetchedAt:new Date()}],
  accountingOfficialItemGroups:[{catalogRunId:'TEST-CATALOG',groupIdentity:'guid:P1',sourceGroupGuid:'P1',groupNumber:'1',groupName:'NOTEBOOK',resolvedMainGroupIdentity:'guid:P1',resolvedMainGroupGuid:'P1',resolvedMainGroupNumber:'1',resolvedMainGroupName:'NOTEBOOK'}],
  accountingOfficialItemGroupAssignments:[{catalogRunId:'TEST-CATALOG',itemGuid:'I1',itemCode:'NB-1',isOfficialEvidence:true,resolvedMainGroupIdentity:'guid:P1',resolvedMainGroupGuid:'P1',resolvedMainGroupNumber:'1',resolvedMainGroupName:'NOTEBOOK'}],
  ...extra
});}

test('ItemGroup/GetList wrapper uses the Swagger POST contract and read-only body',async()=>{
  const original=global.fetch;let observed;global.fetch=async(url,options)=>{observed={url,options,body:JSON.parse(options.body)};return{ok:true,status:200,json:async()=>({Result:[{GroupGuid:'G1',GroupNumber:'1',GroupName:'Notebook',IsMainGroup:true}],CurrentVersion:'42'})};};try{const result=await shaygan.getItemGroupsPage(0,100);assert.equal(result.ok,true);assert.equal(result.list.length,1);assert.match(observed.url,/\/api\/ItemGroup\/GetList\?RowStart=0&RowCount=100$/);assert.equal(observed.options.method,'POST');assert.deepEqual(Object.keys(observed.body.Domain).sort(),['GroupNumber','Sort','SortOnAuxId']);assert.equal(observed.body.StartVersion,'0');assert.equal(observed.body.EndVersion,'');assert.ok(observed.body.Config.ConnectionName);assert.equal(observed.url.includes('/Put'),false);}finally{global.fetch=original;}
});

test('official hierarchy uses GUID identity, resolves main traversal and preserves duplicate numbers',async()=>{
  const hierarchy=governance.resolveGroupHierarchy([
    {GroupGuid:'P-A',GroupNumber:'1',GroupName:'Notebook',IsMainGroup:true},
    {GroupGuid:'G-A',GroupNumber:'00030',GroupName:'Notebook child',ParentGroupGuId:'P-A',ParentGroupNumber:'1',ParentGroupName:'Notebook',IsMainGroup:false},
    {GroupGuid:'G-A2',GroupNumber:'00031',GroupName:'Notebook grandchild',ParentGroupGuId:'G-A',ParentGroupNumber:'00030',ParentGroupName:'Notebook child',IsMainGroup:false},
    {GroupGuid:'P-B',GroupNumber:'2',GroupName:'Parts',IsMainGroup:true},
    {GroupGuid:'G-B',GroupNumber:'00030',GroupName:'Parts child',ParentGroupGuId:'P-B',ParentGroupNumber:'2',ParentGroupName:'Parts',IsMainGroup:false}
  ],{sourceVersion:'42'});assert.equal(hierarchy.diagnostics.groupCount,5);assert.equal(hierarchy.diagnostics.mainGroupCount,2);assert.equal(hierarchy.diagnostics.parentResolvedCount,5);assert.equal(hierarchy.diagnostics.ambiguousNumbers.length,1);const child=hierarchy.rows.find(x=>x.sourceGroupGuid==='G-A');assert.equal(child.groupIdentity,'guid:G-A');assert.equal(child.resolvedMainGroupIdentity,'guid:P-A');assert.equal(child.hierarchyDepth,1);assert.deepEqual(child.hierarchyPath.map(x=>x.groupGuid),['P-A','G-A']);const grandchild=hierarchy.rows.find(x=>x.sourceGroupGuid==='G-A2');assert.equal(grandchild.resolvedMainGroupIdentity,'guid:P-A');assert.equal(grandchild.hierarchyDepth,2);assert.deepEqual(grandchild.hierarchyPath.map(x=>x.groupGuid),['P-A','G-A','G-A2']);
});

test('GUID-less fallback identity remains parent-aware and never uses GroupNumber alone',()=>{
  assert.equal(governance.normalizeOfficialGroup({GroupNumber:'00030',GroupName:'A',ParentGroupNumber:'1',ParentGroupName:'Main A'}).groupIdentity,'parent-number:1|parent-name:Main A|number:00030');
  assert.equal(governance.normalizeOfficialGroup({GroupNumber:'00030',GroupName:'Main A',IsMainGroup:true}).groupIdentity,'number:00030|name:Main A|parent:UNRESOLVED');
  assert.notEqual(governance.normalizeOfficialGroup({GroupNumber:'00030',GroupName:'Main A',IsMainGroup:true}).groupIdentity,governance.normalizeOfficialGroup({GroupNumber:'00030',GroupName:'Main B',IsMainGroup:true}).groupIdentity);
});

test('orphan and cycle hierarchy remain diagnostic-only',async()=>{
  const hierarchy=governance.resolveGroupHierarchy([{GroupGuid:'O1',GroupNumber:'10',ParentGroupGuId:'MISSING',IsMainGroup:false},{GroupGuid:'C1',GroupNumber:'20',ParentGroupGuId:'C2',IsMainGroup:false},{GroupGuid:'C2',GroupNumber:'21',ParentGroupGuId:'C1',IsMainGroup:false}]);assert.equal(hierarchy.rows.find(x=>x.sourceGroupGuid==='O1').validationStatus,'orphan-parent');assert.equal(hierarchy.rows.find(x=>x.sourceGroupGuid==='C1').validationStatus,'cycle');assert.equal(hierarchy.diagnostics.orphanParentCount,1);assert.equal(hierarchy.diagnostics.cycleCount,2);const item=governance.resolveItemGroup(governance.normalizeOfficialItem({ItemGuId:'I1',ItemCode:'100',ItemGroupGuId:'O1'}),hierarchy);assert.equal(item.isOfficialEvidence,false);assert.equal(item.resolutionStatus,'orphan');assert.equal(item.prefixFallbackOnly,true);
});

test('full catalog refresh is idempotent, GUID-resolved and never approves mappings',async()=>{
  const db=dbSeed();const immutableFacts=structuredClone(db.collection(ledger.FIFO_FACTS).rows);const wrapper={getItemGroupsPage:async()=>({ok:true,list:[{GroupGuid:'P1',GroupNumber:'1',GroupName:'Notebook',IsMainGroup:true},{GroupGuid:'G1',GroupNumber:'10',GroupName:'Child',ParentGroupGuId:'P1',ParentGroupNumber:'1',ParentGroupName:'Notebook',IsMainGroup:false}],raw:{CurrentVersion:'7'}}),getItemsPage:async()=>({ok:true,totalRecords:2,list:[{raw:{ItemGuId:'I1',ItemCode:'NB-1',ItemGroupGuId:'G1'}},{raw:{ItemGuId:'I2',ItemCode:'CP-1',ItemGroupGuId:'G1'}}]}),putSaleInvoice:async()=>{throw new Error('write must not be called');},putPurchaseInvoice:async()=>{throw new Error('write must not be called');}};const first=await governance.refreshOfficialGroupCatalog(db,wrapper,{pageSize:100},accounting);const second=await governance.refreshOfficialGroupCatalog(db,wrapper,{pageSize:100},accounting);assert.equal(first.run.groupCount,2);assert.equal(first.run.itemOfficialResolutionCount,2);assert.equal(first.run.itemResolutionCounts['guid-resolved'],2);assert.equal(db.collection(governance.GROUP_CATALOG).rows.length,2);assert.equal(db.collection(governance.ITEM_GROUP_ASSIGNMENTS).rows.length,3);assert.equal(db.collection(governance.GROUP_CATALOG_RUNS).rows.length,3);assert.equal(second.automaticMappingsApproved,0);assert.equal(db.collection(ledger.CATEGORY_MAPPINGS).rows.length,0);assert.deepEqual(db.collection(ledger.FIFO_FACTS).rows,immutableFacts);assert.equal(first.inventoryWrites,0);assert.equal(first.snapshotWrites,0);assert.equal(first.fifoWrites,0);assert.equal(first.invoiceWrites,0);const report=await governance.groupReviewMatrix(db,{fifoDatasetId:'FIFO-1',periodFrom:'14050401',periodTo:'14050431'},accounting);assert.equal(report.coverage.officialResolvedLinePercent,100);assert.equal(report.list[0].groupIdentity,'guid:P1');assert.equal(report.list[0].childGroupCount,1);
});

test('official group paging follows TotalRecords and stops at the exact expected page',async()=>{
  const starts=[];const groups=[
    {GroupGuid:'P1',GroupNumber:'1',GroupName:'Main',IsMainGroup:true,TotalRecords:3},
    {GroupGuid:'G1',GroupNumber:'10',GroupName:'Child 1',ParentGroupGuId:'P1'},
    {GroupGuid:'G2',GroupNumber:'11',GroupName:'Child 2',ParentGroupGuId:'P1'}
  ];
  const wrapper={getItemGroupsPage:async(start,count)=>{starts.push(start);return{ok:true,list:groups.slice(start,start+count),raw:{Result:groups.slice(start,start+count)}};},getItemsPage:async()=>({ok:true,totalRecords:0,list:[]})};
  const result=await governance.refreshOfficialGroupCatalog(dbSeed(),wrapper,{pageSize:2,maxGroupPages:10},accounting);
  assert.deepEqual(starts,[0,2]);assert.equal(result.run.groupTotalRecords,3);assert.equal(result.run.groupExpectedPages,2);assert.equal(result.run.groupPagesRead,2);
});

test('prefix fallback is explicit and never treated as official accounting evidence',async()=>{
  const item=governance.normalizeOfficialItem({ItemGuId:'I1',ItemCode:'14400F',ItemGroupGuId:'MISSING'});const assignment=governance.resolveItemGroup(item,{rows:[]});assert.equal(assignment.isOfficialEvidence,false);assert.equal(assignment.prefixFallbackOnly,true);const db=dbSeed({accountingOfficialItemGroupAssignments:[{...assignment,catalogRunId:'RUN1',active:true}],accountingOfficialGroupCatalogRuns:[{catalogRunId:'RUN1',fetchedAt:new Date()}]});const report=await governance.groupReviewMatrix(db,{fifoDatasetId:'FIFO-1',periodFrom:'14050401',periodTo:'14050431'},accounting);assert.equal(report.coverage.officialResolvedLineCount,0);assert.equal(report.list[0].groupIdentity,'UNRESOLVED');assert.match(report.list[0].suggestionEvidence,/diagnostic-only/);assert.equal(report.automaticApproval,false);
});

test('category mapping workflow keeps evidence optional while enforcing policy, role separation, revision and overlap safety',async()=>{
  const db=dbSeed();const created=await ledger.createCategoryMapping(db,{policyVersionId:'POLICY-1',itemGuid:'I1',commissionRatePool:'NOTEBOOK',effectiveFrom:'14050401',effectiveTo:'14050431'},accounting);assert.equal(created.mapping.status,'draft');const submitted=await ledger.transitionCategoryMapping(db,created.mapping.mappingId,'submit',{revision:1},accounting);await assert.rejects(ledger.transitionCategoryMapping(db,created.mapping.mappingId,'approve',{revision:2},accounting),e=>e.code==='PROFIT_LEDGER_FORBIDDEN');await assert.rejects(ledger.transitionCategoryMapping(db,created.mapping.mappingId,'approve',{revision:99},manager),e=>e.code==='CATEGORY_MAPPING_CONFLICT');const approved=await ledger.transitionCategoryMapping(db,created.mapping.mappingId,'approve',{revision:submitted.mapping.revision},manager);assert.equal(approved.mapping.status,'approved');assert.equal(approved.automaticApproval,false);
  const overlap=await ledger.createCategoryMapping(db,{itemGuid:'I1',commissionRatePool:'COMPONENT',effectiveFrom:'14050415',effectiveTo:'14050501',...evidence},accounting);const pending=await ledger.transitionCategoryMapping(db,overlap.mapping.mappingId,'submit',{revision:1,...evidence},accounting);await assert.rejects(ledger.transitionCategoryMapping(db,overlap.mapping.mappingId,'approve',{revision:pending.mapping.revision,...evidence},manager),e=>e.code==='CATEGORY_MAPPING_OVERLAP');
});

test('category mapping create is unique by approved policy, exact Main Group GUID and effective period',async()=>{
  const db=dbSeed({accountingOfficialItemGroups:[
    {catalogRunId:'TEST-CATALOG',groupIdentity:'guid:P1',sourceGroupGuid:'P1',groupNumber:'1',groupName:'NOTEBOOK',resolvedMainGroupIdentity:'guid:P1',resolvedMainGroupGuid:'P1',resolvedMainGroupNumber:'1',resolvedMainGroupName:'NOTEBOOK'},
    {catalogRunId:'TEST-CATALOG',groupIdentity:'guid:P1-OTHER',sourceGroupGuid:'P1-OTHER',groupNumber:'1',groupName:'OTHER SAME NUMBER',resolvedMainGroupIdentity:'guid:P1-OTHER',resolvedMainGroupGuid:'P1-OTHER',resolvedMainGroupNumber:'1',resolvedMainGroupName:'OTHER SAME NUMBER'}
  ]});
  const first=await ledger.createCategoryMapping(db,{policyVersionId:'POLICY-1',groupPathIdentity:'guid:P1',officialProductCategoryIdentity:'guid:P1',officialProductCategoryGuid:'P1',officialProductCategoryNumber:'1',officialProductCategoryName:'NOTEBOOK',commissionRatePool:'NOTEBOOK',effectiveFrom:'14050401',effectiveTo:'14050431'},accounting);
  const duplicate=await ledger.createCategoryMapping(db,{policyVersionId:'POLICY-1',groupPathIdentity:'guid:P1',officialProductCategoryIdentity:'guid:P1',officialProductCategoryGuid:'P1',officialProductCategoryNumber:'1',officialProductCategoryName:'NOTEBOOK',commissionRatePool:'COMPONENT',effectiveFrom:'14050401',effectiveTo:'14050431'},accounting);assert.equal(duplicate.created,false);assert.equal(duplicate.openedExisting,true);assert.equal(duplicate.mapping.mappingId,first.mapping.mappingId);assert.equal(db.collection(ledger.CATEGORY_MAPPINGS).rows.filter(row=>['draft','pending','returned'].includes(row.status)).length,1);
  const sameNumberDifferentGuid=await ledger.createCategoryMapping(db,{policyVersionId:'POLICY-1',groupPathIdentity:'guid:P1-OTHER',officialProductCategoryIdentity:'guid:P1-OTHER',officialProductCategoryGuid:'P1-OTHER',officialProductCategoryNumber:'1',officialProductCategoryName:'OTHER SAME NUMBER',commissionRatePool:'UNRESOLVED',effectiveFrom:'14050401',effectiveTo:'14050431'},accounting);
  assert.notEqual(sameNumberDifferentGuid.mapping.mappingId,first.mapping.mappingId);assert.equal(sameNumberDifferentGuid.mapping.officialProductCategoryGuid,'P1-OTHER');
});

test('draft cancellation preserves the exact governed reason, audit and history',async()=>{
  const db=dbSeed();const created=await ledger.createCategoryMapping(db,{policyVersionId:'POLICY-1',groupPathIdentity:'guid:P1',officialProductCategoryIdentity:'guid:P1',officialProductCategoryGuid:'P1',officialProductCategoryNumber:'1',officialProductCategoryName:'NOTEBOOK',commissionRatePool:'NOTEBOOK',effectiveFrom:'14050101',effectiveTo:'14050531'},accounting);const reason='لغو پیش‌نویس تکراری؛ رکورد مرجع:\nCMAP-1785912487392-a49b270c';const result=await ledger.transitionCategoryMapping(db,created.mapping.mappingId,'cancel',{revision:1,reason},accounting);assert.equal(result.mapping.status,'cancelled');assert.equal(result.mapping.cancellationReason,reason);assert.equal(result.mapping.cancelledBy.username,accounting.username);assert.equal(result.mapping.auditLog.at(-1).details.reason,reason);assert.equal(db.collection(ledger.CATEGORY_MAPPINGS).rows.length,1);await assert.rejects(ledger.transitionCategoryMapping(db,created.mapping.mappingId,'cancel',{revision:2,reason:''},accounting),error=>error.code==='CATEGORY_MAPPING_STATUS_INVALID');
});

test('authenticated khedmati workflow creates one draft, submits it, and admin rejects without approval',async()=>{
  const db=dbSeed();
  const created=await ledger.createCategoryMapping(db,{policyVersionId:'POLICY-1',groupPathIdentity:'guid:P1',officialProductCategoryIdentity:'guid:P1',officialProductCategoryGuid:'P1',officialProductCategoryNumber:'1',officialProductCategoryName:'NOTEBOOK',commissionRatePool:'UNRESOLVED',effectiveFrom:'14050401',effectiveTo:'14050431',reason:'TEMP GOVERNANCE CONTRACT TEST',sourceReference:'GOVERNANCE-GATE-TEST'},accounting);
  const submitted=await ledger.transitionCategoryMapping(db,created.mapping.mappingId,'submit',{revision:created.mapping.revision,reason:'TEMP GOVERNANCE CONTRACT TEST',sourceReference:'GOVERNANCE-GATE-TEST'},accounting);
  await assert.rejects(ledger.transitionCategoryMapping(db,created.mapping.mappingId,'approve',{revision:submitted.mapping.revision,reason:'must remain human separated'},accounting),error=>error.code==='PROFIT_LEDGER_FORBIDDEN'&&error.statusCode===403);
  const rejected=await ledger.transitionCategoryMapping(db,created.mapping.mappingId,'reject',{revision:submitted.mapping.revision,reason:'Temporary validation completed',sourceReference:'GOVERNANCE-GATE-TEST'},admin);
  assert.equal(rejected.mapping.status,'rejected');assert.equal(rejected.mapping.revision,3);assert.equal(rejected.mapping.createdBy.username,'khedmati');assert.equal(rejected.mapping.rejectedBy.username,'admin');
  assert.deepEqual(rejected.mapping.auditLog.map(event=>[event.action,event.by.username]),[['mapping-created','khedmati'],['mapping-submit','khedmati'],['mapping-reject','admin']]);
  assert.equal(await db.collection(ledger.CATEGORY_MAPPINGS).countDocuments({policyVersionId:'POLICY-1',officialProductCategoryGuid:'P1',effectiveFrom:'14050401',effectiveTo:'14050431'}),1);assert.equal(await db.collection(ledger.CATEGORY_MAPPINGS).countDocuments({status:'approved'}),0);
});

test('stored canonical item identity survives draft editing',async()=>{
  const db=dbSeed();const created=await ledger.createCategoryMapping(db,{itemGuid:'I1',commissionRatePool:'COMPONENT',effectiveFrom:'14050401',effectiveTo:'14050431',...evidence},accounting);const updated=await ledger.updateCategoryMapping(db,created.mapping.mappingId,{revision:1,commissionRatePool:'CUSTOM',reason:'human draft correction'},accounting);assert.equal(updated.mapping.identityType,'itemGuid');assert.equal(updated.mapping.identityValue,'I1');assert.equal(updated.mapping.commissionRatePool,'CUSTOM');assert.equal(updated.mapping.revision,2);
});

test('category approval is serialized per stable identity',async()=>{
  const db=dbSeed();const created=await ledger.createCategoryMapping(db,{itemGuid:'I1',commissionRatePool:'NOTEBOOK',effectiveFrom:'14050401',effectiveTo:'14050431',...evidence},accounting);const submitted=await ledger.transitionCategoryMapping(db,created.mapping.mappingId,'submit',{revision:1,...evidence},accounting);db.collection(ledger.CATEGORY_APPROVAL_LOCKS).rows.push({lockKey:'itemGuid|I1',owner:'other-approver',expiresAt:new Date(Date.now()+10000)});await assert.rejects(ledger.transitionCategoryMapping(db,created.mapping.mappingId,'approve',{revision:submitted.mapping.revision,...evidence},manager),e=>e.code==='APPROVAL_LOCKED');assert.equal(db.collection(ledger.CATEGORY_MAPPINGS).rows[0].status,'pending');
});

test('rate workflow distinguishes blank from zero and supports exact seller override without hidden default',async()=>{
  const db=dbSeed();await assert.rejects(ledger.createRateVersion(db,{sellerIdentity:'*',commissionCategory:'NOTEBOOK',rate:'',effectiveFrom:'14050401',...evidence},accounting),e=>e.code==='RATE_REQUIRED');const global=await ledger.createRateVersion(db,{sellerIdentity:'*',commissionCategory:'NOTEBOOK',rate:'0.14000000',effectiveFrom:'14050401',effectiveTo:'14050431',...evidence},accounting);const gs=await ledger.transitionRateVersion(db,global.rateVersion.rateVersionId,'submit',{revision:1,...evidence},accounting);await ledger.transitionRateVersion(db,global.rateVersion.rateVersionId,'approve',{revision:gs.rateVersion.revision,...evidence},manager);const special=await ledger.createRateVersion(db,{sellerIdentity:'S1',commissionCategory:'NOTEBOOK',rate:'0.35000000',effectiveFrom:'14050401',effectiveTo:'14050431',...evidence},accounting);const ss=await ledger.transitionRateVersion(db,special.rateVersion.rateVersionId,'submit',{revision:1,...evidence},accounting);await ledger.transitionRateVersion(db,special.rateVersion.rateVersionId,'approve',{revision:ss.rateVersion.revision,...evidence},manager);const resolved=await ledger.resolveRate(db,'S1','NOTEBOOK','14050410');assert.equal(resolved.rateVersion.rate,'0.35000000');assert.equal((await ledger.resolveRate(db,'OTHER','COMPONENT','14050410')).status,'missing');
});

test('Tir rate review matrix separates official Product Category from Rate Pool',async()=>{
  const db=dbSeed({commissionCategoryMappings:[{mappingId:'M1',identityType:'itemGuid',identityValue:'I1',commissionCategory:'NOTEBOOK',effectiveFrom:'14050401',effectiveTo:'14050431',status:'approved'}],commissionRateVersions:[{rateVersionId:'R1',sellerIdentity:'*',commissionCategory:'NOTEBOOK',rate:'0.14000000',effectiveFrom:'14050401',effectiveTo:'14050431',status:'pending',sourceReference:'TIR-WORKBOOK'}]});const report=await governance.rateReviewMatrix(db,{fifoDatasetId:'FIFO-1'},accounting);const notebook=report.list.find(row=>row.officialProductCategoryName==='NOTEBOOK');const cpu=report.list.find(row=>row.officialProductCategoryName==='CPU');assert.equal(notebook.commissionRatePool,'NOTEBOOK');assert.equal(notebook.proposedRate,'0.14000000');assert.equal(notebook.rateStatus,'pending');assert.equal(notebook.rateClassification,'rate-pool-default');assert.equal(cpu.commissionRatePool,'UNRESOLVED');assert.equal(cpu.rateStatus,'missing');assert.equal(report.blankRateIsZero,false);
});

test('official Main Group remains Product Category while child items inherit an approved Rate Pool',async()=>{
  const db=dbSeed({
    accountingOfficialGroupCatalogRuns:[{catalogRunId:'RUN-V2',fetchedAt:new Date('2026-08-03T00:00:00Z')}],
    accountingOfficialItemGroups:[
      {catalogRunId:'RUN-V2',groupIdentity:'guid:P-TABLET',sourceGroupGuid:'P-TABLET',groupNumber:'2',groupName:'TABLET',resolvedMainGroupIdentity:'guid:P-TABLET',resolvedMainGroupGuid:'P-TABLET',resolvedMainGroupNumber:'2',resolvedMainGroupName:'TABLET'},
      {catalogRunId:'RUN-V2',groupIdentity:'guid:C-APPLE',sourceGroupGuid:'C-APPLE',groupNumber:'24',groupName:'APPLE',resolvedMainGroupIdentity:'guid:P-TABLET',resolvedMainGroupGuid:'P-TABLET',resolvedMainGroupNumber:'2',resolvedMainGroupName:'TABLET'}
    ],
    accountingOfficialItemGroupAssignments:[
      {catalogRunId:'RUN-V2',itemGuid:'TAB-1',itemCode:'TAB-1',groupIdentity:'guid:C-APPLE',isOfficialEvidence:true,resolvedMainGroupIdentity:'guid:P-TABLET',resolvedMainGroupGuid:'P-TABLET',resolvedMainGroupNumber:'2',resolvedMainGroupName:'TABLET'},
      {catalogRunId:'RUN-V2',itemGuid:'TAB-2',itemCode:'TAB-2',groupIdentity:'guid:C-APPLE',isOfficialEvidence:true,resolvedMainGroupIdentity:'guid:P-TABLET',resolvedMainGroupGuid:'P-TABLET',resolvedMainGroupNumber:'2',resolvedMainGroupName:'TABLET'}
    ]
  });
  const created=await ledger.createCategoryMapping(db,{groupPathIdentity:'guid:P-TABLET',officialProductCategoryIdentity:'guid:P-TABLET',officialProductCategoryGuid:'P-TABLET',officialProductCategoryNumber:'2',officialProductCategoryName:'TABLET',commissionRatePool:'COMPONENT',effectiveFrom:'14050401',effectiveTo:'14050431',...evidence},accounting);
  assert.equal(created.mapping.schemaVersion,2);assert.equal(created.mapping.officialProductCategoryName,'TABLET');assert.equal(created.mapping.commissionRatePool,'COMPONENT');assert.equal(created.mapping.status,'draft');
  const submitted=await ledger.transitionCategoryMapping(db,created.mapping.mappingId,'submit',{revision:1,...evidence},accounting);const approved=await ledger.transitionCategoryMapping(db,created.mapping.mappingId,'approve',{revision:submitted.mapping.revision,...evidence},manager);assert.equal(approved.mapping.status,'approved');
  const maps=await governance._assignmentMaps(db);for(const itemGuid of ['TAB-1','TAB-2']){const enriched=governance.enrichFact({itemGuid,itemCode:itemGuid},maps.byGuid.get(itemGuid));const resolved=ledger._resolveCategoryFromMappings([approved.mapping],enriched,'14050410');assert.equal(resolved.officialProductCategoryName,'TABLET');assert.equal(resolved.commissionRatePool,'COMPONENT');assert.equal(resolved.mappingId,approved.mapping.mappingId);}
});

test('rate resolution has deterministic seller/category to pool-default precedence and pins the version',()=>{
  const classification={officialProductCategoryIdentity:'guid:P-TABLET',officialProductCategoryName:'TABLET',commissionRatePool:'COMPONENT'};
  const rows=[
    {rateVersionId:'POOL-DEFAULT',sellerIdentity:'*',rateScope:'rate_pool',commissionRatePool:'COMPONENT',effectiveFrom:'14050401',effectiveTo:'14050431',rate:'0.20'},
    {rateVersionId:'CATEGORY-DEFAULT',sellerIdentity:'*',rateScope:'product_category',officialProductCategoryIdentity:'guid:P-TABLET',officialProductCategoryName:'TABLET',effectiveFrom:'14050401',effectiveTo:'14050431',rate:'0.18'},
    {rateVersionId:'SELLER-POOL',sellerIdentity:'S1',rateScope:'rate_pool',commissionRatePool:'COMPONENT',effectiveFrom:'14050401',effectiveTo:'14050431',rate:'0.17'},
    {rateVersionId:'SELLER-CATEGORY',sellerIdentity:'S1',rateScope:'product_category',officialProductCategoryIdentity:'guid:P-TABLET',officialProductCategoryName:'TABLET',effectiveFrom:'14050401',effectiveTo:'14050431',rate:'0.16'}
  ];
  let result=ledger._resolveRateFromRows(rows,'S1',classification,'14050410');assert.equal(result.rateVersion.rateVersionId,'SELLER-CATEGORY');assert.equal(result.precedence,'seller/category');assert.equal(result.appliedRateVersionId,'SELLER-CATEGORY');
  result=ledger._resolveRateFromRows(rows.filter(row=>row.rateVersionId!=='SELLER-CATEGORY'),'S1',classification,'14050410');assert.equal(result.rateVersion.rateVersionId,'SELLER-POOL');assert.equal(result.precedence,'seller/rate-pool');
  result=ledger._resolveRateFromRows(rows.filter(row=>!row.rateVersionId.startsWith('SELLER')),'S1',classification,'14050410');assert.equal(result.rateVersion.rateVersionId,'CATEGORY-DEFAULT');assert.equal(result.precedence,'category-default');
  result=ledger._resolveRateFromRows(rows.filter(row=>row.rateVersionId==='POOL-DEFAULT'),'S1',classification,'14050410');assert.equal(result.rateVersion.rateVersionId,'POOL-DEFAULT');assert.equal(result.precedence,'rate-pool-default');
});

test('legacy category and rate records remain byte-for-byte stored and are adapted only on read',async()=>{
  const legacyMapping={mappingId:'LEGACY-M',identityType:'itemGuid',identityValue:'I1',commissionCategory:'OTHER',effectiveFrom:'14050401',effectiveTo:'',status:'rejected',revision:4,auditLog:[{action:'mapping-reject',by:{username:'admin',role:'admin'}}]};
  const legacyRate={rateVersionId:'LEGACY-R',sellerIdentity:'*',commissionCategory:'COMPONENT',effectiveFrom:'14050401',effectiveTo:'',rate:'0.20',status:'pending',revision:2,auditLog:[{action:'rate-submit',by:{username:'khedmati',role:'accounting'}}]};
  const db=dbSeed({commissionCategoryMappings:[structuredClone(legacyMapping)],commissionRateVersions:[structuredClone(legacyRate)]});const mappings=await ledger.listCategoryMappings(db,{}),rates=await ledger.listRateVersions(db,{});assert.deepEqual(db.collection(ledger.CATEGORY_MAPPINGS).rows[0],legacyMapping);assert.deepEqual(db.collection(ledger.RATE_VERSIONS).rows[0],legacyRate);assert.equal(mappings.list[0].commissionRatePool,'CUSTOM');assert.equal(mappings.list[0].legacyCompatibility,true);assert.equal(rates.list[0].rateScope,'rate_pool');assert.equal(rates.list[0].commissionRatePool,'COMPONENT');assert.equal(rates.list[0].legacyCompatibility,true);
});

test('opening balance requires source evidence, independent approval, isolated pools and idempotent single posting',async()=>{
  const db=dbSeed();await assert.rejects(governance.createOpeningBalance(db,{pool:'COMPONENT',accountingPeriod:'140504',amountExact:'500'},accounting),e=>e.code==='OPENING_EVIDENCE_REQUIRED');const created=await governance.createOpeningBalance(db,{pool:'COMPONENT',accountingPeriod:'140504',amountExact:'500',sourceDocumentType:'Management packet',...governedEvidence},accounting);const submitted=await governance.transitionOpeningBalance(db,created.openingBalance.openingBalanceId,'submit',{revision:1},accounting);await assert.rejects(governance.transitionOpeningBalance(db,created.openingBalance.openingBalanceId,'approve',{revision:submitted.openingBalance.revision,...governedEvidence},accounting),e=>e.code==='ACCOUNTING_GOVERNANCE_FORBIDDEN');const approved=await governance.transitionOpeningBalance(db,created.openingBalance.openingBalanceId,'approve',{revision:submitted.openingBalance.revision,...governedEvidence},manager);assert.equal(approved.ledgerEntry.pool,'COMPONENT');assert.equal(approved.ledgerEntry.creditAmountExact,'500.00');const replay=await governance.transitionOpeningBalance(db,created.openingBalance.openingBalanceId,'approve',{revision:approved.openingBalance.revision,...governedEvidence},manager);assert.equal(replay.idempotent,true);assert.equal(db.collection(ledger.SAVED_LEDGER).rows.length,1);assert.equal((await ledger.savedBalance(db,'NOTEBOOK')).balanceExact,'0.00');assert.equal((await ledger.savedBalance(db,'COMPONENT')).balanceExact,'500.00');
});

test('opening reversal is a separate approval workflow and cannot silently alter the original',async()=>{
  const db=dbSeed();const original=await governance.createOpeningBalance(db,{pool:'NOTEBOOK',accountingPeriod:'140504',amountExact:'100',sourceDocumentType:'Workbook',...governedEvidence},accounting);const os=await governance.transitionOpeningBalance(db,original.openingBalance.openingBalanceId,'submit',{revision:1},accounting);const oa=await governance.transitionOpeningBalance(db,original.openingBalance.openingBalanceId,'approve',{revision:os.openingBalance.revision,...governedEvidence},manager);const reversal=await governance.createOpeningBalance(db,{pool:'NOTEBOOK',accountingPeriod:'140504',amountExact:'100',entryKind:'REVERSAL',reversalOf:oa.openingBalance.openingBalanceId,sourceDocumentType:'Reversal approval',...governedEvidence},accounting);assert.equal(reversal.openingBalance.status,'draft');assert.equal(db.collection(ledger.SAVED_LEDGER).rows.length,1);const rs=await governance.transitionOpeningBalance(db,reversal.openingBalance.openingBalanceId,'submit',{revision:1},accounting);await governance.transitionOpeningBalance(db,reversal.openingBalance.openingBalanceId,'approve',{revision:rs.openingBalance.revision,...governedEvidence},manager);assert.equal(db.collection(ledger.SAVED_LEDGER).rows.length,2);assert.equal((await ledger.savedBalance(db,'NOTEBOOK')).balanceExact,'0.00');
});

test('only one approved opening balance may exist per pool and period',async()=>{
  const db=dbSeed();async function pending(amount,source){const c=await governance.createOpeningBalance(db,{pool:'NOTEBOOK',accountingPeriod:'140504',amountExact:amount,sourceDocumentType:'Workbook',...governedEvidence,sourceReference:source},accounting);return governance.transitionOpeningBalance(db,c.openingBalance.openingBalanceId,'submit',{revision:1},accounting);}const first=await pending('100','DOC-A');await governance.transitionOpeningBalance(db,first.openingBalance.openingBalanceId,'approve',{revision:first.openingBalance.revision,...governedEvidence},manager);const second=await pending('200','DOC-B');await assert.rejects(governance.transitionOpeningBalance(db,second.openingBalance.openingBalanceId,'approve',{revision:second.openingBalance.revision,...governedEvidence},manager),e=>e.code==='OPENING_APPROVED_DUPLICATE');assert.equal(db.collection(ledger.SAVED_LEDGER).rows.length,1);
});

test('readiness exposes approved/projected coverage and normal export is blocked with machine-readable reasons',async()=>{
  const db=dbSeed({commissionCategoryMappings:[{mappingId:'M1',identityType:'itemGuid',identityValue:'I1',commissionCategory:'NOTEBOOK',effectiveFrom:'14050401',effectiveTo:'14050431',status:'approved'},{mappingId:'M2',identityType:'itemGuid',identityValue:'I2',commissionCategory:'COMPONENT',effectiveFrom:'14050401',effectiveTo:'14050431',status:'pending'}],commissionRateVersions:[{rateVersionId:'R1',sellerIdentity:'S1',commissionCategory:'NOTEBOOK',rate:'0.14',effectiveFrom:'14050401',effectiveTo:'14050431',status:'approved'}]});const result=await governance.readiness(db,{fifoDatasetId:'FIFO-1',periodFrom:'14050401',periodTo:'14050431'},accounting);assert.equal(result.metrics.mappedSaleValuePercent,95);assert.equal(result.metrics.projectedMappedSaleValuePercent,100);assert.equal(result.normalExportReady,false);assert.equal(result.blockers.some(x=>x.code==='UNMAPPED_LINES'),true);assert.equal(result.blockers.some(x=>x.code==='COST_COVERAGE_INCOMPLETE'),true);await assert.rejects(ledger.createExcelExport(db,{fifoDatasetId:'FIFO-1'},accounting),e=>e.code==='COMMISSION_EXPORT_NOT_READY'&&Array.isArray(e.blockers));
});

test('diagnostic export is explicit, admin-only, audited and never contains a payable total',async()=>{
  const db=dbSeed();await assert.rejects(ledger.createExcelExport(db,{fifoDatasetId:'FIFO-1',exportMode:'diagnostic',...governedEvidence},accounting),e=>e.code==='ACCOUNTING_GOVERNANCE_FORBIDDEN');const result=await ledger.createExcelExport(db,{fifoDatasetId:'FIFO-1',exportMode:'diagnostic',...governedEvidence},admin);assert.equal(result.exportMode,'diagnostic');assert.equal(result.payable,false);assert.match(result.content,/INCOMPLETE DIAGNOSTIC ONLY/);assert.equal(db.collection(governance.EXPORT_OVERRIDES).rows.length,1);
});

test('normal export opens only after every governed prerequisite is approved',async()=>{
  const readyFacts=facts().map(row=>row.factId==='F2'?{...row,actualFifoProfitExact:'10.00',costCoverageStatus:'complete',invoiceDiscountAttributionStatus:'official-line-or-zero'}:row);const db=new MemoryDb({fifoProfitFacts:readyFacts,commissionCategoryMappings:[{mappingId:'M1',identityType:'itemGuid',identityValue:'I1',commissionCategory:'NOTEBOOK',effectiveFrom:'14050401',effectiveTo:'14050431',status:'approved'},{mappingId:'M2',identityType:'itemGuid',identityValue:'I2',commissionCategory:'COMPONENT',effectiveFrom:'14050401',effectiveTo:'14050431',status:'approved'}],commissionRateVersions:[{rateVersionId:'R1',sellerIdentity:'S1',commissionCategory:'NOTEBOOK',rate:'0.14',effectiveFrom:'14050401',effectiveTo:'14050431',status:'approved'},{rateVersionId:'R2',sellerIdentity:'S1',commissionCategory:'COMPONENT',rate:'0.20',effectiveFrom:'14050401',effectiveTo:'14050431',status:'approved'}],savedProfitOpeningBalances:[{openingBalanceId:'O1',pool:'NOTEBOOK',accountingPeriod:'140504',entryKind:'OPENING',status:'approved'},{openingBalanceId:'O2',pool:'COMPONENT',accountingPeriod:'140504',entryKind:'OPENING',status:'approved'}]});const ready=await governance.readiness(db,{fifoDatasetId:'FIFO-1'},accounting);assert.equal(ready.normalExportReady,true);assert.equal(ready.blockers.length,0);const exported=await ledger.createExcelExport(db,{fifoDatasetId:'FIFO-1'},accounting);assert.equal(exported.exportMode,'normal');assert.equal(exported.payable,false);assert.equal(exported.content.includes('INCOMPLETE DIAGNOSTIC ONLY'),false);
});

test('seller has no access and source/UI contracts preserve accounting boundaries',async()=>{
  const db=dbSeed();await assert.rejects(governance.groupReviewMatrix(db,{},seller),e=>e.code==='ACCOUNTING_GOVERNANCE_FORBIDDEN');const source=fs.readFileSync(path.join(__dirname,'../src/lib/accounting-governance.js'),'utf8');for(const forbidden of ['Invoice/Put','PutSaleInvoice','PutBuyInvoice','saleSnapshotDatasetLines.update','fifoProfitFacts.update','supplierPurchaseLayers.update','itemInventoryCatalog.update'])assert.equal(source.includes(forbidden),false,forbidden);const ui=fs.readFileSync(path.join(__dirname,'../public/assets/app.js'),'utf8');assert.match(ui,/commission-category-governance/);assert.match(ui,/Official Product Category/);assert.match(ui,/Commission Rate Pool/);assert.match(ui,/officialProductCategoryIdentity/);assert.match(ui,/commissionRatePool/);assert.match(ui,/seller\/category.*seller\/rate-pool.*category default.*rate-pool default/);assert.match(ui,/saved-profit-opening-governance/);assert.match(ui,/COMMISSION_EXPORT_NOT_READY|Normal export/);assert.match(ui,/excelDiagnostic/);assert.match(ui,/Diagnostic Export \(incomplete \/ non-payable\)/);assert.match(ui,/data-action="\$\{action\}"/);assert.match(ui,/action==='edit'\?editRecord/);const sellerPages=ui.match(/seller:\s*\[([^\]]+)\]/)?.[1]||'';assert.equal(sellerPages.includes('commission-category-governance'),false);assert.equal(sellerPages.includes('saved-profit-opening-governance'),false);
});

test('final financial navigation removes duplicates, preserves redirects and enforces role visibility',async()=>{
  const ui=fs.readFileSync(path.join(__dirname,'../public/assets/app.js'),'utf8');
  assert.equal((ui.match(/addEventListener\('hashchange'/g)||[]).length,1,'only the final dynamic hash router may remain');
  const marker='/* Financial Navigation and Policy Selection cleanup.';
  const start=ui.lastIndexOf(marker);
  assert.ok(start>ui.lastIndexOf('/* Phase B final registry'),'cleanup registry must be last');
  const registration=ui.slice(start);
  function node(tag='div'){
    const value={tag,dataset:{},children:[],parentNode:null,open:undefined,
      appendChild(child){child.parentNode=this;this.children.push(child);return child;},
      remove(){if(this.parentNode)this.parentNode.children=this.parentNode.children.filter(child=>child!==this);},
      querySelectorAll(selector){
        const matches=[];
        const visit=current=>{for(const child of current.children){
          const financial=selector==='[data-financial-navigation="true"]'&&child.dataset.financialNavigation==='true';
          const page=selector.match(/data-page="([^"]+)"/)?.[1];
          if(financial||(page&&child.dataset.page===page))matches.push(child);
          visit(child);
        }};visit(this);return matches;
      },
      querySelector(selector){return this.querySelectorAll(selector)[0]||null;}
    };return value;
  }
  function load(role){
    const menu=node('menu');
    for(const id of ['commission-policy-governance','commission-category-governance','commission-rate-governance','commission-rate-versions','accounting-fifo-readiness','fifo-profit-facts','supplier-incentive-ledger']){
      for(let copy=0;copy<2;copy++){const button=node('button');button.dataset.page=id;menu.appendChild(button);}
    }
    let fallback=0,health=0;
    const context={
      window:{renderMenu(){},async route(){fallback++;},__accountingGovernanceRenderers:{'commission-export-readiness':async()=>{health++;}}},
      document:{querySelector:selector=>selector==='#menu'?menu:null,createElement:tag=>node(tag)},
      location:{hash:''},userRole:()=>role,firstAllowedPage:()=> 'dashboard'
    };
    context.renderMenu=context.window.renderMenu;context.route=context.window.route;
    vm.runInNewContext(registration,context);
    const buttons=()=>menu.querySelectorAll('[data-financial-navigation="true"]').filter(item=>item.tag==='button');
    return{...context,menu,buttons,get fallback(){return fallback;},get health(){return health;}};
  }
  const expected={accounting:9,admin:14,manager:13,purchase:1,seller:0,seller_buyer:0,viewer:0};
  for(const[role,count]of Object.entries(expected)){
    const state=load(role);assert.equal(state.buttons().length,count,role);
    assert.equal(new Set(state.buttons().map(button=>button.dataset.page)).size,count,`${role} duplicate capability`);
    state.window.renderMenu();assert.equal(state.buttons().length,count,`${role} duplicate after rerender`);
    const advanced=state.menu.children.find(item=>item.tag==='details');
    if(['admin','manager'].includes(role))assert.equal(advanced.open,false,`${role} advanced collapsed`);else assert.equal(advanced,undefined,`${role} advanced hidden`);
  }
  const accountingState=load('accounting');
  assert.deepEqual(accountingState.buttons().slice(0,3).map(button=>button.textContent),['سیاست‌های پورسانت','تعریف پورسانت گروه کالا','نرخ‌های پورسانت']);
  accountingState.location.hash='#commission-rate-versions';await accountingState.window.route();
  assert.equal(accountingState.location.hash,'commission-rate-governance');assert.equal(accountingState.fallback,1);
  accountingState.location.hash='#accounting-fifo-readiness';await accountingState.window.route();
  assert.equal(accountingState.location.hash,'financial-data-health');assert.equal(accountingState.health,1);
  const sellerState=load('seller');sellerState.location.hash='#seller-profit';await sellerState.window.route();
  assert.equal(sellerState.location.hash,'dashboard');assert.equal(sellerState.fallback,1);
});

test('policy selectors expose bounded Persian empty, loading and retry states without prompt',()=>{
  const ui=fs.readFileSync(path.join(__dirname,'../public/assets/app.js'),'utf8');
  const phaseBStart=ui.indexOf('/* Phase B financial-governance page definitions.');
  const phaseB=ui.slice(phaseBStart,ui.indexOf('window.__phaseBFinancialRenderers=renderers;',phaseBStart));
  assert.match(phaseB,/هیچ سیاست پورسانت مصوبی وجود ندارد\./);
  assert.match(phaseB,/ابتدا یک سیاست پورسانت ایجاد و پس از تأیید مدیر، آن را انتخاب کنید\./);
  assert.match(phaseB,/ایجاد سیاست پورسانت/);assert.match(phaseB,/بازخوانی سیاست‌ها/);assert.match(phaseB,/تلاش دوباره/);
  assert.match(phaseB,/row\.status==='approved'/);assert.match(phaseB,/row\.policyVersionId!=='LEGACY_PRE_POLICY'/);assert.match(phaseB,/!row\.historicalFrozen/);
  assert.match(phaseB,/id="fgmCreate" disabled/);assert.match(phaseB,/id="fgrCreate" disabled/);
  assert.match(phaseB,/cancelled:'لغوشده'/);assert.match(phaseB,/rate_pool:'سبد نرخ'/);assert.match(phaseB,/جزئیات حسابرسی/);assert.match(phaseB,/رکورد تاریخی/);
  assert.match(phaseB,/function recordId\(row,type\)/);assert.match(phaseB,/type==='mapping'\?row\.mappingId/);assert.match(phaseB,/type==='rate'\?row\.rateVersionId/);
  assert.doesNotMatch(phaseB,/row\.policyVersionId\|\|row\.mappingId\|\|row\.rateVersionId/);
  assert.match(phaseB,/data-row-type="projection"/);assert.match(phaseB,/data-row-type="persisted"/);assert.match(phaseB,/ثبت‌نشده/);assert.match(phaseB,/ایجاد پیش‌نویس/);
  assert.match(phaseB,/CATEGORY_MAPPING_NOT_FOUND/);assert.match(phaseB,/رکورد نگاشت پیدا نشد/);assert.match(phaseB,/data-error-code/);
  assert.match(phaseB,/Candidate محاسباتی هرگز پیش‌نویس تلقی نمی‌شود/);assert.match(phaseB,/data-rate-version-id/);
  assert.match(phaseB,/data-action="reject"/);assert.match(phaseB,/رد کردن/);
  assert.equal(/\bprompt\s*\(/.test(phaseB),false,'primary governance pages must not use prompt');
});

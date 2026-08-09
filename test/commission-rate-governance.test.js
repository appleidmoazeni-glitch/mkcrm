'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { MemoryDb } = require('./helpers/memory-mongo');
const ledger = require('../src/lib/profit-commission-ledger');
const { shiftJalaliDate } = require('../src/lib/jalali-date');

const accounting={username:'khedmati',role:'accounting'};
const manager={username:'manager-1',role:'manager'};
const admin={username:'admin',role:'admin'};

function policy(id='P1',status='approved',from='14050401',to='14050431'){
  return {policyVersionId:id,name:id,accountingPeriod:'140504',effectiveFrom:from,effectiveTo:to,status,revision:3,createdBy:{username:'policy-owner',role:'accounting'},approvedBy:manager,contentHash:`HASH-${id}`};
}
function dbSeed(extra={}){
  return new MemoryDb({commissionPolicyVersions:[policy(),...(extra.policies||[])],commissionRateVersions:extra.rates||[],accountingOfficialGroupCatalogRuns:[{catalogRunId:'CAT-1',fetchedAt:new Date()}],accountingOfficialItemGroups:[{catalogRunId:'CAT-1',groupIdentity:'guid:NOTEBOOK',sourceGroupGuid:'NOTEBOOK-GUID',groupNumber:'1',groupName:'NOTEBOOK',resolvedMainGroupIdentity:'guid:NOTEBOOK',resolvedMainGroupGuid:'NOTEBOOK-GUID',resolvedMainGroupNumber:'1',resolvedMainGroupName:'NOTEBOOK'}]});
}
const rateInput=(overrides={})=>({policyVersionId:'P1',sellerIdentity:'*',rateScope:'rate_pool',commissionRatePool:'NOTEBOOK',rate:'0.14000000',effectiveFrom:'14050401',effectiveTo:'14050431',...overrides});
async function pending(db,input={}){const created=await ledger.createRateVersion(db,rateInput(input),accounting);return (await ledger.transitionRateVersion(db,created.rateVersion.rateVersionId,'submit',{revision:created.rateVersion.revision},accounting)).rateVersion;}
async function approved(db,input={}){const row=await pending(db,input);return (await ledger.transitionRateVersion(db,row.rateVersionId,'approve',{revision:row.revision},manager)).rateVersion;}

test('GOV-04 create uses exact scale, backend TEST class and optional description/evidence',async()=>{
  const db=dbSeed();const result=await ledger.createRateVersion(db,rateInput({rate:'0.14125'}),accounting);assert.equal(result.rateVersion.rate,'0.14125000');assert.equal(result.rateVersion.recordClass,'TEST');assert.equal(result.rateVersion.environment,'STAGING');assert.equal(result.rateVersion.status,'draft');assert.match(result.rateVersion.contentHash,/^[a-f0-9]{64}$/);assert.match(result.rateVersion.sourceFingerprint,/^[a-f0-9]{64}$/);assert.equal(result.automaticApproval,false);
});

test('GOV-04 rejects rate precision beyond the authoritative eight-decimal scale',async()=>{const db=dbSeed();await assert.rejects(ledger.createRateVersion(db,rateInput({rate:'0.141250001'}),accounting),error=>error.code==='RATE_INVALID');});

test('GOV-04 closed effective period is mandatory, Jalali and inside Policy',async()=>{
  const db=dbSeed();for(const input of [{effectiveTo:''},{effectiveFrom:'1405/04/32'},{effectiveFrom:'14050329'},{effectiveTo:'14050501'}])await assert.rejects(ledger.createRateVersion(db,rateInput(input),accounting),error=>['INVALID_JALALI_DATE','RATE_EFFECTIVE_PERIOD_INVALID'].includes(error.code));
  const valid=await ledger.createRateVersion(db,rateInput({effectiveFrom:'۱۴۰۵/۰۴/۰۱',effectiveTo:'1405-04-31'}),accounting);assert.equal(valid.rateVersion.effectiveFrom,'14050401');assert.equal(valid.rateVersion.effectiveTo,'14050431');
});

test('GOV-04 Jalali boundary helper supports explicit mid-month adjacency',()=>{assert.equal(shiftJalaliDate('14050415',1),'14050416');assert.equal(shiftJalaliDate('14050701',-1),'14050631');assert.equal(shiftJalaliDate('14050101',-1),'14041230');});

test('GOV-04 workflow enforces independent approval, stale revision, return/resubmit, reject and cancel',async()=>{
  const db=dbSeed();const adminDraft=(await ledger.createRateVersion(db,rateInput({sellerIdentity:'ADMIN-OWNED'}),admin)).rateVersion,adminPending=(await ledger.transitionRateVersion(db,adminDraft.rateVersionId,'submit',{revision:adminDraft.revision},admin)).rateVersion;await assert.rejects(ledger.transitionRateVersion(db,adminPending.rateVersionId,'approve',{revision:adminPending.revision},admin),error=>error.code==='RATE_SELF_APPROVAL_FORBIDDEN');const first=await pending(db);await assert.rejects(ledger.transitionRateVersion(db,first.rateVersionId,'approve',{revision:1},manager),error=>error.code==='RATE_STALE_REVISION');const returned=(await ledger.transitionRateVersion(db,first.rateVersionId,'return',{revision:first.revision},manager)).rateVersion;const edited=(await ledger.updateRateVersion(db,returned.rateVersionId,{revision:returned.revision,rate:'0.15',effectiveFrom:'14050401',effectiveTo:'14050431'},accounting)).rateVersion;const resubmitted=(await ledger.transitionRateVersion(db,edited.rateVersionId,'submit',{revision:edited.revision},accounting)).rateVersion;const rejected=(await ledger.transitionRateVersion(db,resubmitted.rateVersionId,'reject',{revision:resubmitted.revision},manager)).rateVersion;assert.equal(rejected.status,'rejected');const draft=(await ledger.createRateVersion(db,rateInput({sellerIdentity:'S2'}),accounting)).rateVersion;const cancelled=(await ledger.transitionRateVersion(db,draft.rateVersionId,'cancel',{revision:draft.revision},accounting)).rateVersion;assert.equal(cancelled.status,'cancelled');
});

test('GOV-04 Policy is revalidated at submit and approval',async()=>{
  const db=dbSeed();const draft=(await ledger.createRateVersion(db,rateInput(),accounting)).rateVersion;db.collection('commissionPolicyVersions').rows[0].status='retired';await assert.rejects(ledger.transitionRateVersion(db,draft.rateVersionId,'submit',{revision:1},accounting),error=>error.code==='RATE_POLICY_NOT_APPROVED');db.collection('commissionPolicyVersions').rows[0].status='approved';const submitted=(await ledger.transitionRateVersion(db,draft.rateVersionId,'submit',{revision:1},accounting)).rateVersion;db.collection('commissionPolicyVersions').rows[0].status='retired';await assert.rejects(ledger.transitionRateVersion(db,submitted.rateVersionId,'approve',{revision:submitted.revision},manager),error=>error.code==='RATE_POLICY_NOT_APPROVED');
});

test('GOV-04 duplicate open workflow is blocked with existing identity',async()=>{
  const db=dbSeed();const first=await ledger.createRateVersion(db,rateInput(),accounting);await assert.rejects(ledger.createRateVersion(db,rateInput(),accounting),error=>error.code==='RATE_DUPLICATE_OPEN_WORKFLOW'&&error.details.existingRateVersionId===first.rateVersion.rateVersionId);assert.equal(db.collection(ledger.RATE_VERSIONS).rows.length,1);
});

test('GOV-04 same active Policy and different active Policy overlaps block',async()=>{
  const db=dbSeed({policies:[policy('P2','approved')]});await approved(db);const same=await pending(db,{sellerIdentity:'*',effectiveFrom:'14050415',effectiveTo:'14050420'});await assert.rejects(ledger.transitionRateVersion(db,same.rateVersionId,'approve',{revision:same.revision},manager),error=>error.code==='RATE_OVERLAP');const other=await pending(db,{policyVersionId:'P2',sellerIdentity:'*',effectiveFrom:'14050410',effectiveTo:'14050412'});await assert.rejects(ledger.transitionRateVersion(db,other.rateVersionId,'approve',{revision:other.revision},manager),error=>error.code==='RATE_OVERLAP');
});

test('GOV-04 retired Policy approved Rate, rejected and cancelled records do not block',async()=>{
  const historical={rateVersionId:'OLD',policyVersionId:'RETIRED',sellerIdentity:'*',rateScope:'rate_pool',commissionRatePool:'NOTEBOOK',rate:'0.10',effectiveFrom:'14050401',effectiveTo:'14050431',status:'approved',recordClass:'TEST',revision:2};const db=dbSeed({policies:[policy('RETIRED','retired')],rates:[historical,{...historical,rateVersionId:'REJECTED',policyVersionId:'P1',status:'rejected'},{...historical,rateVersionId:'CANCELLED',policyVersionId:'P1',status:'cancelled'}]});const current=await pending(db);const result=await ledger.transitionRateVersion(db,current.rateVersionId,'approve',{revision:current.revision},manager);assert.equal(result.rateVersion.status,'approved');assert.equal(db.collection(ledger.RATE_VERSIONS).rows.find(row=>row.rateVersionId==='OLD').status,'approved');
});

test('GOV-04 approval lock rejects a concurrent approval',async()=>{const db=dbSeed();const row=await pending(db);db.collection(ledger.RATE_APPROVAL_LOCKS).rows.push({lockKey:'*|rate_pool|NOTEBOOK',owner:'other',expiresAt:new Date(Date.now()+10000)});await assert.rejects(ledger.transitionRateVersion(db,row.rateVersionId,'approve',{revision:row.revision},manager),error=>error.code==='RATE_APPROVAL_LOCKED');});

test('GOV-04 precedence is deterministic and explicit zero differs from missing',()=>{
  const classification={officialProductCategoryIdentity:'guid:NOTEBOOK',officialProductCategoryName:'NOTEBOOK',commissionRatePool:'COMPONENT',policyVersionId:'P1'};const base={policyVersionId:'P1',effectiveFrom:'14050401',effectiveTo:'14050431',status:'approved',recordClass:'TEST'};const rows=[{...base,rateVersionId:'POOL',sellerIdentity:'*',rateScope:'rate_pool',commissionRatePool:'COMPONENT',rate:'0.20000000'},{...base,rateVersionId:'CATEGORY',sellerIdentity:'*',rateScope:'product_category',officialProductCategoryIdentity:'guid:NOTEBOOK',officialProductCategoryName:'NOTEBOOK',rate:'0.18000000'},{...base,rateVersionId:'SELLER-POOL',sellerIdentity:'S1',rateScope:'rate_pool',commissionRatePool:'COMPONENT',rate:'0.17000000'},{...base,rateVersionId:'SELLER-CATEGORY',sellerIdentity:'S1',rateScope:'product_category',officialProductCategoryIdentity:'guid:NOTEBOOK',officialProductCategoryName:'NOTEBOOK',rate:'0.00000000'}];const resolved=ledger._resolveRateFromRows(rows,'S1',classification,'14050410');assert.equal(resolved.precedence,'seller/category');assert.equal(resolved.appliedRateExact,'0.00000000');assert.equal(ledger._resolveRateFromRows([],'S1',classification,'14050410').code,'RATE_NOT_FOUND');const conflict=ledger._resolveRateFromRows([...rows,{...rows[3],rateVersionId:'DUP'}],'S1',classification,'14050410');assert.equal(conflict.code,'RATE_CONFLICT');
});

test('GOV-04 supersession links immutable approved content and changes applicability only at boundary',async()=>{
  const db=dbSeed();const old=await approved(db);const replacement=(await ledger.createSupersedingRateVersion(db,old.rateVersionId,{rate:'0.16000000',effectiveFrom:'14050416',effectiveTo:'14050431',reason:'mid-month management replacement'},accounting)).rateVersion;assert.equal(replacement.supersedesRateVersionId,old.rateVersionId);const submitted=(await ledger.transitionRateVersion(db,replacement.rateVersionId,'submit',{revision:replacement.revision},accounting)).rateVersion;const approvedReplacement=(await ledger.transitionRateVersion(db,submitted.rateVersionId,'approve',{revision:submitted.revision},manager)).rateVersion;const storedOld=db.collection(ledger.RATE_VERSIONS).rows.find(row=>row.rateVersionId===old.rateVersionId);assert.equal(storedOld.rate,'0.14000000');assert.equal(storedOld.supersededByRateVersionId,approvedReplacement.rateVersionId);assert.equal(storedOld.supersessionEffectiveFrom,'14050416');const rows=db.collection(ledger.RATE_VERSIONS).rows;assert.equal(ledger._resolveRateFromRows(rows,'OTHER','NOTEBOOK','14050415').rateVersion.rateVersionId,old.rateVersionId);assert.equal(ledger._resolveRateFromRows(rows,'OTHER','NOTEBOOK','14050416').rateVersion.rateVersionId,approvedReplacement.rateVersionId);
});

test('GOV-04 supersession reason is mandatory and approved rows cannot be edited',async()=>{const db=dbSeed();const old=await approved(db);await assert.rejects(ledger.createSupersedingRateVersion(db,old.rateVersionId,{rate:'0.15',effectiveFrom:'14050416',effectiveTo:'14050431'},accounting),error=>error.code==='RATE_SUPERSESSION_INVALID');await assert.rejects(ledger.updateRateVersion(db,old.rateVersionId,{revision:old.revision,rate:'0.99'},accounting),error=>error.code==='RATE_CLOSED_PERIOD');});

test('GOV-04 recordClass is environment-owned and Production excludes TEST resolution',async()=>{
  const previous=process.env.MKCRM_ENV;try{process.env.MKCRM_ENV='production';const db=dbSeed();await assert.rejects(ledger.createRateVersion(db,rateInput({recordClass:'TEST'}),accounting),error=>error.code==='RATE_RECORD_CLASS_INVALID');const created=await ledger.createRateVersion(db,rateInput(),accounting);assert.equal(created.rateVersion.recordClass,'BUSINESS');const rows=[{...created.rateVersion,status:'approved'},{...created.rateVersion,rateVersionId:'TEST-RATE',recordClass:'TEST',rate:'0.99'}];const result=ledger._resolveRateFromRows(rows,'OTHER','NOTEBOOK','14050410');assert.equal(result.rateVersion.recordClass,'BUSINESS');}finally{if(previous===undefined)delete process.env.MKCRM_ENV;else process.env.MKCRM_ENV=previous;}
});

test('GOV-04 staging database identity overrides production-mode Node runtime',async()=>{const previous={node:process.env.NODE_ENV,mongo:process.env.MONGO_URI,app:process.env.MKCRM_ENV};try{delete process.env.MKCRM_ENV;process.env.NODE_ENV='production';process.env.MONGO_URI='mongodb://127.0.0.1:27017/mkcrm_staging';assert.equal(ledger._rateEnvironment(),'STAGING');}finally{for(const [key,value]of Object.entries({NODE_ENV:previous.node,MONGO_URI:previous.mongo,MKCRM_ENV:previous.app}))if(value===undefined)delete process.env[key];else process.env[key]=value;}});

test('GOV-04 rejects forbidden scopes',async()=>{const db=dbSeed();for(const rateScope of ['global','store','role','user_group'])await assert.rejects(ledger.createRateVersion(db,rateInput({rateScope}),accounting),error=>error.code==='RATE_TARGET_INVALID');});

test('GOV-04 UI keeps one route, exact fields, workflow sections and no hidden seed',()=>{const source=fs.readFileSync(path.join(__dirname,'../public/assets/app.js'),'utf8');for(const text of ['اعمال برای','Product Category','Commission Rate Pool','نرخ درصد','از تاریخ شمسی','تا تاریخ شمسی','نیازمند اقدام / Missing Coverage','Draft / Pending','History / Audit','ایجاد نسخه جایگزین','Commission مقدماتی و non-payable'])assert.match(source,new RegExp(text));assert.match(source,/'commission-rate-governance':ratePage/);assert.match(source,/current==='commission-rate-governance'.*window\.__phaseBFinancialRenderers\?\.\[current\]/s);const start=source.indexOf('async function ratePage()'),end=source.indexOf('const renderers=',start);assert.doesNotMatch(source.slice(start,end),/Seed Tir 14% \/ 20%/);});

test('GOV-04 exports additive schema and keeps commission non-payable',async()=>{const db=dbSeed();const result=await ledger.listRateVersions(db,{});assert.equal(result.commissionPayable,false);assert.equal(result.missingRateIsZero,false);assert.deepEqual(result.precedence,['seller/category','seller/rate-pool','category-default','rate-pool-default']);assert.ok(ledger.RATE_RECORD_CLASSES.includes('HISTORICAL'));});

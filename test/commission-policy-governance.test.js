'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {MemoryDb}=require('./helpers/memory-mongo');
const policy=require('../src/lib/commission-policy-governance');
const ledger=require('../src/lib/profit-commission-ledger');

const accounting={username:'khedmati',role:'accounting'};
const manager={username:'manager',role:'manager'};
const admin={username:'admin',role:'admin'};
const seller={username:'seller',role:'seller'};

async function approvedPolicy(db,overrides={}){
  const created=await policy.createPolicy(db,{name:'Tir governed rates',accountingPeriod:'140504',effectiveFrom:'14050401',effectiveTo:'14050431',...overrides},accounting);
  const pending=await policy.transitionPolicy(db,created.policy.policyVersionId,'submit',{revision:1},accounting);
  return (await policy.transitionPolicy(db,created.policy.policyVersionId,'approve',{revision:pending.policy.revision},manager)).policy;
}

test('policy workflow is Jalali, revisioned, independently approved and immutable',async()=>{
  const db=new MemoryDb();
  await assert.rejects(policy.createPolicy(db,{name:'bad',accountingPeriod:'140504',effectiveFrom:'20260701'},accounting),error=>error.code==='COMMISSION_POLICY_JALALI_DATE_REQUIRED');
  const created=await policy.createPolicy(db,{name:'Tir',accountingPeriod:'140504',effectiveFrom:'۱۴۰۵/۰۴/۰۱',effectiveTo:'1405-04-31'},accounting);
  assert.equal(created.policy.effectiveFrom,'14050401');assert.equal(created.policy.effectiveTo,'14050431');
  await assert.rejects(policy.updatePolicy(db,created.policy.policyVersionId,{revision:9,name:'stale'},accounting),error=>error.code==='COMMISSION_POLICY_CONFLICT'&&error.statusCode===409);
  const pending=await policy.transitionPolicy(db,created.policy.policyVersionId,'submit',{revision:1},accounting);
  await assert.rejects(policy.transitionPolicy(db,created.policy.policyVersionId,'approve',{revision:pending.policy.revision},accounting),error=>error.code==='COMMISSION_POLICY_FORBIDDEN');
  const approved=await policy.transitionPolicy(db,created.policy.policyVersionId,'approve',{revision:pending.policy.revision},manager);
  assert.equal(approved.policy.status,'approved');assert.equal(approved.policy.approvedBy.username,'manager');
  await assert.rejects(policy.updatePolicy(db,created.policy.policyVersionId,{revision:3,name:'changed'},accounting),error=>error.code==='COMMISSION_POLICY_IMMUTABLE');
  await assert.rejects(policy.listPolicies(db,{},seller),error=>error.code==='COMMISSION_POLICY_FORBIDDEN');
});

test('approved policy overlap is serialized and rejected for the same accounting scope',async()=>{
  const db=new MemoryDb();await approvedPolicy(db);
  const second=await policy.createPolicy(db,{name:'Overlap',accountingPeriod:'140504',effectiveFrom:'14050415',effectiveTo:'14050501'},accounting);
  const pending=await policy.transitionPolicy(db,second.policy.policyVersionId,'submit',{revision:1},accounting);
  await assert.rejects(policy.transitionPolicy(db,second.policy.policyVersionId,'approve',{revision:pending.policy.revision},manager),error=>error.code==='COMMISSION_POLICY_OVERLAP'&&error.statusCode===409);
});

test('LEGACY_PRE_POLICY and sidecar migration are idempotent and preserve source bytes',async()=>{
  const category={mappingId:'OLD-MAP',schemaVersion:1,identityType:'itemCode',identityValue:'X',commissionCategory:'OTHER',effectiveFrom:'14040101',effectiveTo:'',status:'approved',auditLog:[{action:'old'}]};
  const rate={rateVersionId:'OLD-RATE',schemaVersion:1,sellerIdentity:'*',commissionCategory:'NOTEBOOK',rate:'0.14',effectiveFrom:'14040101',status:'approved'};
  const db=new MemoryDb({commissionCategoryMappings:[category],commissionRateVersions:[rate]});
  const beforeMappings=structuredClone(db.collection('commissionCategoryMappings').rows);const beforeRates=structuredClone(db.collection('commissionRateVersions').rows);
  const first=await policy.migrateLegacyBindings(db,{migrationRunId:'RUN-1'},admin);assert.equal(first.created,2);assert.equal(first.legacyPolicyCreated,true);
  const second=await policy.migrateLegacyBindings(db,{migrationRunId:'RUN-2'},admin);assert.equal(second.created,0);assert.equal(second.skipped,2);
  assert.deepEqual(db.collection('commissionCategoryMappings').rows,beforeMappings);assert.deepEqual(db.collection('commissionRateVersions').rows,beforeRates);
  const attached=await policy.attachPolicyBindings(db,'category_mapping',beforeMappings);assert.equal(attached[0].policyVersionId,policy.LEGACY_POLICY_ID);assert.equal(attached[0].legacyPolicy,true);
  const legacy=(await policy.listPolicies(db,{},admin)).list.find(row=>row.policyVersionId===policy.LEGACY_POLICY_ID);assert.equal(legacy.status,'historical_frozen');assert.equal(legacy.selectable,false);
  await assert.rejects(policy.transitionPolicy(db,policy.LEGACY_POLICY_ID,'retire',{revision:1},manager),error=>error.code==='LEGACY_POLICY_IMMUTABLE');
});

test('sidecar detects source tampering and new rates require a selectable approved policy',async()=>{
  const db=new MemoryDb({commissionRateVersions:[{rateVersionId:'OLD',sellerIdentity:'*',commissionCategory:'NOTEBOOK',rate:'0.14',effectiveFrom:'14040101',status:'approved'}]});
  await policy.migrateLegacyBindings(db,{},admin);db.collection('commissionRateVersions').rows[0].rate='0.99';
  await assert.rejects(policy.migrateLegacyBindings(db,{},admin),error=>error.code==='COMMISSION_POLICY_BINDING_HASH_CONFLICT'&&error.migration.conflicts.length===1);
  await assert.rejects(ledger.createRateVersion(db,{sellerIdentity:'*',commissionRatePool:'NOTEBOOK',rate:'0.2',effectiveFrom:'14050401'},accounting),error=>error.code==='RATE_POLICY_NOT_APPROVED');
  const approved=await approvedPolicy(db);const created=await ledger.createRateVersion(db,{policyVersionId:approved.policyVersionId,sellerIdentity:'*',commissionRatePool:'NOTEBOOK',rate:'0.2',effectiveFrom:'14050401',effectiveTo:'14050431'},accounting);
  assert.equal(created.rateVersion.policyVersionId,approved.policyVersionId);assert.equal(created.rateVersion.status,'draft');
});

test('manual-cost roles remain separated in the exported contract',()=>{
  const manual=require('../src/lib/manual-cost-resolution');
  assert.deepEqual(manual.EDIT_ROLES,['admin','accounting']);assert.deepEqual(manual.APPROVE_ROLES,['admin','manager']);
});

test('only currently approved operational policies are selectable',async()=>{
  const db=new MemoryDb();
  let listed=await policy.listPolicies(db,{},admin);assert.equal(listed.selectable.length,0);
  await policy.migrateLegacyBindings(db,{},admin);listed=await policy.listPolicies(db,{},admin);assert.equal(listed.selectable.length,0);assert.equal(listed.list.find(row=>row.policyVersionId===policy.LEGACY_POLICY_ID).selectable,false);
  const approved=await approvedPolicy(db);listed=await policy.listPolicies(db,{},admin);assert.deepEqual(listed.selectable.map(row=>row.policyVersionId),[approved.policyVersionId]);
  await policy.transitionPolicy(db,approved.policyVersionId,'retire',{revision:approved.revision,reason:'controlled test retirement'},manager);
  listed=await policy.listPolicies(db,{},admin);assert.equal(listed.selectable.length,0);
});
